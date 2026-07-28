import { WebSocket } from "ws";
import {
  BetResult,
  GamePhase,
  GamePlayer,
  GameQuestion,
  GuessQuestion,
  PlacedBet,
} from "./types.js";
import {
  drawGuessQuestion,
  generateMathQuestion,
  loadQuestions,
  QuestionDeck,
} from "./questions.js";

export const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;
const SPIN_TIME_MS = 3500;
const BASE_QUESTION_TIME_MS = 15000;
const MIN_QUESTION_TIME_MS = 8000;
const BETTING_TIME_MS = 4500;
const REVEAL_MS = 5000;
const PICK_TIME_MS = 15000;
const MATH_QUESTION_CHANCE = 0.3;
const DUEL_CHANCE = 0.5;
const DUEL_TIME_MS = 20000;
const DUEL_LOSER_COST = 100;
const CODE_SYMBOLS = ["🔴", "🟡", "🟢", "🔵", "🟣", "🟠"];
const CODE_LENGTH = 4;
const CODE_MAX_ATTEMPTS = 6;
const CODE_DUEL_TIME_MS = 90000;
const EMPTY_ROOM_GRACE_MS = 60000;
const STARTING_MONEY = 500;
const WRONG_ANSWER_COST = 100;
const MIN_BET = 10;
const CHAT_HISTORY_LIMIT = 50;
const CHAT_MAX_LENGTH = 300;
const CHAT_MIN_INTERVAL_MS = 500;

export interface ChatEntry {
  /** null for system messages */
  username: string | null;
  /** frozen at write time so history survives players leaving */
  displayName?: string | null;
  text: string;
  at: number;
}

interface Turn {
  answering: string;
  question: GameQuestion;
  askedAt: number;
  answerTimeMs: number;
  /** hidden until the reveal */
  answer: string | null;
  answeredInMs: number | null;
  bets: Map<string, PlacedBet>;
}

/**
 * "Ruski rulet" rules, turn-based:
 * a spin picks who answers first. Answer correctly and you pick the next
 * player to impose a question on — the chain continues, with questions
 * getting harder and the clock shorter the deeper it goes. Answer wrong
 * (or run out of time) and you lose $100, then the wheel spins again.
 * Everyone starts with $500; hit $0 and you're out. While a player answers,
 * the others may bet money on whether they'll get it right — from the moment
 * the question appears until the short "place your bets" pause closes.
 * Last player with money wins.
 */
export class GameRoom {
  readonly code: number;
  readonly roomName: string;
  lobbyId: string | null = null;

  phase: GamePhase = "lobby";
  players = new Map<string, GamePlayer>();
  private sockets = new Map<WebSocket, string>();

  private deck: QuestionDeck | null = null;
  private turn: Turn | null = null;
  private duel: {
    kind: "guess" | "code";
    players: [string, string];
    /** when the duel clock runs out — for reconnect resync */
    endsAt: number;
    // closest-guess duel
    question?: GuessQuestion;
    guesses: Map<string, number>;
    // code-breaker duel
    code?: string[];
    attempts?: Map<
      string,
      { guess: string[]; exact: number; partial: number }[]
    >;
  } | null = null;
  /** in-flight spin, so a refreshing client can rejoin the animation */
  private currentSpin: { target: string; endsAt: number } | null = null;
  /** in-flight pick prompt, same reason */
  private currentPick: {
    picker: string;
    choices: string[];
    endsAt: number;
  } | null = null;
  private round = 0;
  private chainDepth = 0;
  /** who the wheel picked last — their odds drop (but stay > 0) next spin */
  private lastSpinTarget: string | null = null;
  /** per-game stats for achievement checks, keyed by username */
  private gameStats = new Map<
    string,
    { betsWon: number; maxBetWin: number; wrongAnswers: number }
  >();
  private timers = new Set<NodeJS.Timeout>();
  private emptyTimer: NodeJS.Timeout | null = null;
  private chat: ChatEntry[] = [];
  private lastChatAt = new Map<string, number>();

  /** called once when a game finishes, for persistence */
  onGameOver?: (room: GameRoom) => void;
  /** called when the room has had no connections for a while */
  onEmpty?: (room: GameRoom) => void;
  /** called after the host kicks a player, for lobby-record cleanup */
  onPlayerKicked?: (room: GameRoom, username: string) => void;
  /** called when the host deletes the lobby */
  onTerminated?: (room: GameRoom) => void;

  constructor(code: number, roomName: string) {
    this.code = code;
    this.roomName = roomName;
  }

  // ---------------------------------------------------------------- players

  addPlayer(
    username: string,
    opts: {
      money?: number;
      isHost?: boolean;
      avatar?: string | null;
      displayName?: string | null;
    } = {}
  ): GamePlayer {
    const existing = this.players.get(username);
    if (existing) return existing;
    const player: GamePlayer = {
      username,
      displayName: opts.displayName ?? username,
      avatar: opts.avatar ?? null,
      money: opts.money ?? STARTING_MONEY,
      alive: this.phase === "lobby",
      connected: false,
      isHost: opts.isHost ?? false,
      streak: 0,
    };
    this.players.set(username, player);
    return player;
  }

  /** what to call a player in chat/announcements */
  nameOf(username: string): string {
    return this.players.get(username)?.displayName ?? username;
  }

  connect(
    ws: WebSocket,
    username: string,
    avatar: string | null = null,
    displayName: string | null = null
  ) {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
    const known = this.players.get(username);
    const isReconnect = known !== undefined && !known.connected;
    const isNew = known === undefined;
    const player = this.addPlayer(username, { avatar, displayName });
    player.connected = true;
    if (avatar) player.avatar = avatar;
    if (displayName) player.displayName = displayName;
    this.sockets.set(ws, username);
    if (![...this.players.values()].some((p) => p.isHost && p.connected)) {
      this.reassignHost();
    }
    this.broadcastLobbyState();
    // catch the new socket up on the conversation so far
    this.send(ws, { type: "chat_history", messages: this.chat });
    if (isNew) this.systemChat(`${this.nameOf(username)} joined the room`);
    else if (isReconnect) this.systemChat(`${this.nameOf(username)} reconnected`);
    // rejoining mid-turn: resync whatever is in flight, with remaining time
    this.resyncSocket(ws, username);
  }

  /** replay the current phase to a (re)connecting socket */
  private resyncSocket(ws: WebSocket, username: string) {
    if (
      (this.phase === "question" || this.phase === "betting") &&
      this.turn
    ) {
      this.send(ws, this.turnQuestionMessage());
      return;
    }
    if (this.phase === "spin" && this.currentSpin) {
      this.send(ws, {
        type: "spin",
        target: this.currentSpin.target,
        spinTimeMs: Math.max(200, this.currentSpin.endsAt - Date.now()),
      });
      return;
    }
    if (this.phase === "picking" && this.currentPick) {
      this.send(ws, {
        type: "pick_start",
        picker: this.currentPick.picker,
        choices: this.currentPick.choices,
        pickTimeMs: Math.max(500, this.currentPick.endsAt - Date.now()),
      });
      return;
    }
    if (this.phase === "duel" && this.duel) {
      const remaining = Math.max(500, this.duel.endsAt - Date.now());
      if (this.duel.kind === "guess" && this.duel.question) {
        this.send(ws, {
          type: "duel_question",
          round: this.round,
          questionText: this.duel.question.text,
          players: this.duel.players,
          answerTimeMs: remaining,
        });
      } else if (this.duel.kind === "code" && this.duel.attempts) {
        this.send(ws, {
          type: "code_duel_start",
          round: this.round,
          players: this.duel.players,
          symbols: CODE_SYMBOLS,
          codeLength: CODE_LENGTH,
          maxAttempts: CODE_MAX_ATTEMPTS,
          answerTimeMs: remaining,
        });
        // replay everyone's progress; the reconnector's own attempts
        // include the symbols so their board is fully restored
        for (const [player, attempts] of this.duel.attempts) {
          attempts.forEach((a, i) => {
            if (player === username) {
              this.send(ws, {
                type: "code_feedback",
                guess: a.guess,
                exact: a.exact,
                partial: a.partial,
                attempt: i + 1,
                attemptsLeft: CODE_MAX_ATTEMPTS - attempts.length,
              });
            } else {
              this.send(ws, {
                type: "code_progress",
                username: player,
                attempt: i + 1,
                exact: a.exact,
                partial: a.partial,
              });
            }
          });
        }
      }
    }
  }

  disconnect(ws: WebSocket) {
    const username = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (username) {
      const player = this.players.get(username);
      if (player) {
        player.connected = false;
        // in the lobby there is nothing to rejoin, so drop them entirely
        if (this.phase === "lobby") {
          this.players.delete(username);
          if (player.isHost) this.reassignHost();
          this.systemChat(`${player.displayName} left the room`);
        } else {
          this.systemChat(`${player.displayName} lost connection`);
        }
      }
      this.broadcastLobbyState();
    }
    if (this.sockets.size === 0) {
      this.emptyTimer = setTimeout(() => {
        this.destroy();
        this.onEmpty?.(this);
      }, EMPTY_ROOM_GRACE_MS);
    }
  }

  removePlayer(username: string, opts: { silent?: boolean } = {}) {
    const player = this.players.get(username);
    if (!player) return;
    this.players.delete(username);
    if (player.isHost) this.reassignHost();
    if (!opts.silent) this.systemChat(`${player.displayName} left the room`);
    this.turn?.bets.delete(username);

    if (this.phase !== "lobby" && this.phase !== "gameover") {
      if (this.alivePlayers().length <= 1) {
        this.gameOver();
        return;
      }
      // the player everyone was watching left — restart the chain
      if (
        this.turn?.answering === username &&
        (this.phase === "question" ||
          this.phase === "betting" ||
          this.phase === "picking")
      ) {
        this.clearTimers();
        this.broadcastLobbyState();
        this.spin();
        return;
      }
      // a duelist walked out mid-duel
      if (this.phase === "duel" && this.duel?.players.includes(username)) {
        this.clearTimers();
        this.duel = null;
        this.broadcastLobbyState();
        this.spin();
        return;
      }
    }
    this.broadcastLobbyState();
  }

  private reassignHost() {
    const players = [...this.players.values()];
    players.forEach((p) => (p.isHost = false));
    const next = players.find((p) => p.connected) ?? players[0];
    if (next) next.isHost = true;
  }

  private alivePlayers(): GamePlayer[] {
    return [...this.players.values()].filter((p) => p.alive);
  }

  // ---------------------------------------------------------------- messaging

  private send(ws: WebSocket, msg: object) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private publicPlayers() {
    return [...this.players.values()].map((p) => ({
      username: p.username,
      displayName: p.displayName,
      avatar: p.avatar,
      money: p.money,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      streak: p.streak,
    }));
  }

  /** lobby-card metadata that lives in the wallet (streak, avatar) */
  setPlayerProfile(username: string, streak: number, avatar: string | null) {
    const player = this.players.get(username);
    if (!player) return;
    const changed =
      player.streak !== streak || (avatar !== null && player.avatar !== avatar);
    player.streak = streak;
    if (avatar !== null) player.avatar = avatar;
    if (changed) this.broadcastLobbyState();
  }

  announce(text: string) {
    this.systemChat(text);
  }

  private ensureStats(username: string) {
    let s = this.gameStats.get(username);
    if (!s) {
      s = { betsWon: 0, maxBetWin: 0, wrongAnswers: 0 };
      this.gameStats.set(username, s);
    }
    return s;
  }

  getGameStats(winner: string | null) {
    return [...this.players.values()].map((p) => {
      const s = this.gameStats.get(p.username) ?? {
        betsWon: 0,
        maxBetWin: 0,
        wrongAnswers: 0,
      };
      return {
        username: p.username,
        wonGame: p.username === winner,
        betsWon: s.betsWon,
        maxBetWin: s.maxBetWin,
        wrongAnswers: s.wrongAnswers,
      };
    });
  }

  broadcastLobbyState() {
    this.broadcast({
      type: "lobby_state",
      phase: this.phase,
      roomName: this.roomName,
      code: this.code,
      minPlayers: MIN_PLAYERS,
      round: this.round,
      players: this.publicPlayers(),
    });
  }

  private turnQuestionMessage() {
    const t = this.turn!;
    return {
      type: "turn_question",
      round: this.round,
      chainDepth: this.chainDepth,
      answering: t.answering,
      questionText: t.question.text,
      options: t.question.options,
      difficulty: t.question.difficulty,
      answerTimeMs: Math.max(0, t.askedAt + t.answerTimeMs - Date.now()),
    };
  }

  handleMessage(ws: WebSocket, msg: any) {
    const username = this.sockets.get(ws);
    if (!username) return;
    switch (msg.type) {
      case "start_game":
        this.startGame(username);
        break;
      case "submit_answer":
        this.submitAnswer(username, String(msg.answer ?? ""));
        break;
      case "submit_guess":
        this.submitGuess(username, Number(msg.value));
        break;
      case "submit_code":
        this.submitCode(
          username,
          Array.isArray(msg.guess) ? msg.guess.map(String) : []
        );
        break;
      case "place_bet":
        this.placeBet(username, msg.bet, Number(msg.amount));
        break;
      case "pick_player":
        this.pickNext(username, String(msg.target ?? ""));
        break;
      case "chat":
        this.receiveChat(username, String(msg.text ?? ""));
        break;
      case "play_again":
        this.playAgainRequest(username);
        break;
      case "kick_player":
        this.kickPlayer(username, String(msg.target ?? ""));
        break;
      case "terminate_lobby":
        this.terminate(username);
        break;
      case "leave":
        this.sockets.delete(ws);
        this.removePlayer(username);
        break;
    }
  }

  // ---------------------------------------------------------------- chat

  private pushChat(entry: ChatEntry) {
    this.chat.push(entry);
    if (this.chat.length > CHAT_HISTORY_LIMIT) {
      this.chat.splice(0, this.chat.length - CHAT_HISTORY_LIMIT);
    }
    this.broadcast({ type: "chat_message", ...entry });
  }

  private systemChat(text: string) {
    this.pushChat({ username: null, text, at: Date.now() });
  }

  private receiveChat(username: string, rawText: string) {
    const text = rawText.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;
    const now = Date.now();
    const last = this.lastChatAt.get(username) ?? 0;
    if (now - last < CHAT_MIN_INTERVAL_MS) return; // basic flood control
    this.lastChatAt.set(username, now);
    this.pushChat({
      username,
      displayName: this.nameOf(username),
      text,
      at: now,
    });
  }

  // ---------------------------------------------------------------- game flow

  private setTimer(fn: () => void, ms: number): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  async startGame(byUsername: string) {
    const starter = this.players.get(byUsername);
    if (this.phase !== "lobby" || !starter?.isHost) return;

    const connected = [...this.players.values()].filter((p) => p.connected);
    if (connected.length < MIN_PLAYERS) {
      this.broadcast({
        type: "error",
        message: `Need at least ${MIN_PLAYERS} players to start.`,
      });
      return;
    }

    const questions = await loadQuestions();
    if (questions.length === 0) {
      this.broadcast({ type: "error", message: "No questions available." });
      return;
    }
    this.deck = new QuestionDeck(questions);

    // only players present at the start participate
    for (const p of [...this.players.values()]) {
      if (!p.connected) this.players.delete(p.username);
    }
    for (const p of this.players.values()) {
      p.alive = true;
      p.money = STARTING_MONEY;
    }

    this.round = 0;
    this.gameStats.clear();
    this.lastSpinTarget = null;
    this.phase = "countdown";
    this.broadcastLobbyState();

    let remaining = COUNTDOWN_SECONDS;
    const tick = () => {
      this.broadcast({ type: "game_countdown", seconds: remaining });
      remaining -= 1;
      if (remaining >= 0) {
        this.setTimer(tick, 1000);
      } else {
        this.spin();
      }
    };
    tick();
  }

  /** the roulette: pick who has to answer, then ask */
  private spin() {
    if (this.phase === "gameover") return;
    const alive = this.alivePlayers();
    if (alive.length <= 1) {
      this.gameOver();
      return;
    }
    this.chainDepth = 0;
    // head-to-head: sometimes the wheel calls a duel instead
    if (alive.length === 2 && Math.random() < DUEL_CHANCE) {
      const pair: [string, string] = [alive[0].username, alive[1].username];
      if (Math.random() < 0.5) this.startDuel(pair);
      else this.startCodeDuel(pair);
      return;
    }
    // weighted pick: whoever was picked last time is less likely (not impossible)
    const weights = alive.map((p) =>
      p.username === this.lastSpinTarget ? 0.4 : 1
    );
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    let target = alive[alive.length - 1];
    for (let i = 0; i < alive.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        target = alive[i];
        break;
      }
    }
    this.lastSpinTarget = target.username;
    this.phase = "spin";
    this.currentSpin = {
      target: target.username,
      endsAt: Date.now() + SPIN_TIME_MS,
    };
    this.broadcast({
      type: "spin",
      target: target.username,
      spinTimeMs: SPIN_TIME_MS,
    });
    this.setTimer(() => this.askQuestion(target.username), SPIN_TIME_MS);
  }

  private askQuestion(answering: string) {
    if (this.phase === "gameover" || !this.deck) return;
    this.currentSpin = null;
    this.currentPick = null;
    const player = this.players.get(answering);
    if (!player || !player.alive) {
      this.spin();
      return;
    }
    this.round += 1;
    // deeper chain -> harder tier, shorter clock
    const difficulty = 1 + Math.floor(this.chainDepth / 2);
    const answerTimeMs = Math.max(
      MIN_QUESTION_TIME_MS,
      BASE_QUESTION_TIME_MS - this.chainDepth * 1000
    );
    this.turn = {
      answering,
      question:
        Math.random() < MATH_QUESTION_CHANCE
          ? generateMathQuestion(difficulty)
          : this.deck.draw(difficulty),
      askedAt: Date.now(),
      answerTimeMs,
      answer: null,
      answeredInMs: null,
      bets: new Map(),
    };
    this.phase = "question";
    this.broadcast(this.turnQuestionMessage());
    this.setTimer(() => this.resolveTurn(), answerTimeMs);
  }

  private submitAnswer(username: string, answer: string) {
    const t = this.turn;
    if (this.phase !== "question" || !t) return;
    if (username !== t.answering || t.answer !== null) return;

    t.answer = answer;
    t.answeredInMs = Date.now() - t.askedAt;
    this.clearTimers();

    // answer stays hidden: last call for bets
    const canBet = this.bettors().filter((p) => !t.bets.has(p.username));
    if (canBet.length > 0) {
      this.phase = "betting";
      this.broadcast({
        type: "bet_start",
        target: t.answering,
        betTimeMs: BETTING_TIME_MS,
      });
      this.setTimer(() => this.resolveTurn(), BETTING_TIME_MS);
    } else {
      this.resolveTurn();
    }
  }

  /** everyone alive with money, except whoever is answering */
  private bettors(): GamePlayer[] {
    const t = this.turn;
    if (!t) return [];
    return this.alivePlayers().filter(
      (p) => p.username !== t.answering && p.money >= MIN_BET
    );
  }

  private placeBet(username: string, rawBet: unknown, rawAmount: number) {
    const t = this.turn;
    if ((this.phase !== "question" && this.phase !== "betting") || !t) return;
    if (rawBet !== "correct" && rawBet !== "wrong") return;
    if (username === t.answering || t.bets.has(username)) return;
    const player = this.players.get(username);
    if (!player || !player.alive) return;

    const amount = Math.min(
      player.money,
      Math.max(MIN_BET, Math.floor(rawAmount) || 0)
    );
    if (amount < MIN_BET || player.money < MIN_BET) return;

    t.bets.set(username, { bet: rawBet, amount });
    this.broadcast({
      type: "player_bet",
      username,
      betCount: t.bets.size,
      eligibleCount: this.bettors().length + t.bets.size,
    });
    // in the final betting pause, close early once every bettor is in
    if (this.phase === "betting" && this.bettors().every((p) => t.bets.has(p.username))) {
      this.clearTimers();
      this.resolveTurn();
    }
  }

  private resolveTurn() {
    const t = this.turn;
    if (
      (this.phase !== "question" && this.phase !== "betting") ||
      !t
    )
      return;
    this.clearTimers();

    const answering = this.players.get(t.answering);
    const timedOut = t.answer === null;
    const correct = !timedOut && t.answer === t.question.answer;

    let answererDelta = 0;
    if (!correct && answering) {
      answererDelta = -Math.min(WRONG_ANSWER_COST, answering.money);
      answering.money += answererDelta;
      this.ensureStats(answering.username).wrongAnswers += 1;
    }

    const betResults: BetResult[] = [];
    for (const [bettor, placed] of t.bets) {
      const player = this.players.get(bettor);
      if (!player) continue;
      const won = (placed.bet === "correct") === correct;
      const stake = Math.min(placed.amount, player.money);
      const moneyDelta = won ? stake : -stake;
      player.money += moneyDelta;
      if (won) {
        const s = this.ensureStats(bettor);
        s.betsWon += 1;
        s.maxBetWin = Math.max(s.maxBetWin, stake);
      }
      betResults.push({
        username: bettor,
        bet: placed.bet,
        amount: stake,
        won,
        moneyDelta,
      });
    }

    // broke players are out
    const eliminated: string[] = [];
    for (const p of this.players.values()) {
      if (p.alive && p.money <= 0) {
        p.money = 0;
        p.alive = false;
        eliminated.push(p.username);
      }
    }

    this.phase = "reveal";
    this.broadcast({
      type: "round_result",
      round: this.round,
      chainDepth: this.chainDepth,
      answering: t.answering,
      answer: t.answer,
      timedOut,
      correct,
      correctAnswer: t.question.answer,
      answererDelta,
      bets: betResults,
      eliminated,
      players: this.publicPlayers(),
    });

    if (correct) {
      this.systemChat(`${this.nameOf(t.answering)} answered correctly`);
    } else {
      this.systemChat(
        `${this.nameOf(t.answering)} ${timedOut ? "ran out of time" : "answered wrong"} and loses $${-answererDelta}`
      );
    }
    for (const name of eliminated) {
      this.systemChat(`💸 ${this.nameOf(name)} is broke and out of the game`);
    }

    this.setTimer(() => this.afterReveal(correct), REVEAL_MS);
  }

  private afterReveal(wasCorrect: boolean) {
    const t = this.turn;
    if (this.phase !== "reveal" || !t) return;

    if (this.alivePlayers().length <= 1) {
      this.gameOver();
      return;
    }

    const answerer = this.players.get(t.answering);
    if (wasCorrect && answerer?.alive) {
      const choices = this.alivePlayers()
        .filter((p) => p.username !== t.answering)
        .map((p) => p.username);
      if (choices.length === 1) {
        // no real choice to make
        this.pickNext(t.answering, choices[0], true);
        return;
      }
      this.phase = "picking";
      this.currentPick = {
        picker: t.answering,
        choices,
        endsAt: Date.now() + PICK_TIME_MS,
      };
      this.broadcast({
        type: "pick_start",
        picker: t.answering,
        choices,
        pickTimeMs: PICK_TIME_MS,
      });
      this.setTimer(() => {
        const random = choices[Math.floor(Math.random() * choices.length)];
        this.pickNext(t.answering, random, true);
      }, PICK_TIME_MS);
    } else {
      this.spin();
    }
  }

  private pickNext(username: string, target: string, forced = false) {
    const t = this.turn;
    if (!t) return;
    if (!forced && this.phase !== "picking") return;
    if (username !== t.answering) return;
    const targetPlayer = this.players.get(target);
    if (!targetPlayer || !targetPlayer.alive || target === username) return;

    this.clearTimers();
    this.chainDepth += 1;
    this.broadcast({
      type: "picked",
      picker: username,
      target,
      chainDepth: this.chainDepth,
    });
    this.systemChat(`${this.nameOf(username)} imposes the next question on ${this.nameOf(target)}`);
    this.askQuestion(target);
  }

  // ---------------------------------------------------------------- duels

  private startDuel(players: [string, string]) {
    this.round += 1;
    this.turn = null;
    this.currentSpin = null;
    this.duel = {
      kind: "guess",
      question: drawGuessQuestion(),
      players,
      endsAt: Date.now() + DUEL_TIME_MS,
      guesses: new Map(),
    };
    this.phase = "duel";
    this.broadcast({
      type: "duel_question",
      round: this.round,
      questionText: this.duel.question.text,
      players,
      answerTimeMs: DUEL_TIME_MS,
    });
    this.systemChat(`⚔️ Duel! ${this.nameOf(players[0])} vs ${this.nameOf(players[1])} — closest guess wins`);
    this.setTimer(() => this.resolveDuel(), DUEL_TIME_MS);
  }

  private submitGuess(username: string, value: number) {
    const d = this.duel;
    if (this.phase !== "duel" || !d || d.kind !== "guess") return;
    if (!d.players.includes(username) || d.guesses.has(username)) return;
    if (!Number.isFinite(value)) return;
    d.guesses.set(username, value);
    this.broadcast({
      type: "player_answered",
      username,
      answeredCount: d.guesses.size,
      aliveCount: d.players.length,
    });
    if (d.guesses.size === d.players.length) this.resolveDuel();
  }

  private resolveDuel() {
    const d = this.duel;
    if (this.phase !== "duel" || !d || d.kind !== "guess" || !d.question)
      return;
    this.clearTimers();

    const question = d.question;
    const guesses = d.players.map((username) => {
      const guess = d.guesses.get(username) ?? null;
      return {
        username,
        guess,
        diff: guess === null ? null : Math.abs(guess - question.value),
      };
    });
    const [a, b] = guesses;
    const diffA = a.diff ?? Infinity;
    const diffB = b.diff ?? Infinity;
    const tie = diffA === diffB;
    const winner = tie ? null : diffA < diffB ? a.username : b.username;
    const loser = tie ? null : diffA < diffB ? b.username : a.username;

    let loserDelta = 0;
    if (loser) {
      const player = this.players.get(loser);
      if (player) {
        loserDelta = -Math.min(DUEL_LOSER_COST, player.money);
        player.money += loserDelta;
      }
    }

    const eliminated: string[] = [];
    for (const p of this.players.values()) {
      if (p.alive && p.money <= 0) {
        p.money = 0;
        p.alive = false;
        eliminated.push(p.username);
      }
    }

    this.phase = "reveal";
    this.broadcast({
      type: "duel_result",
      round: this.round,
      questionText: question.text,
      correctValue: question.value,
      guesses,
      winner,
      loser,
      tie,
      loserDelta,
      eliminated,
      players: this.publicPlayers(),
    });
    if (tie) {
      this.systemChat(`⚔️ The duel is a tie — nobody loses money`);
    } else {
      this.systemChat(
        `⚔️ ${this.nameOf(winner!)} wins the duel! ${this.nameOf(loser!)} loses $${-loserDelta}`
      );
    }
    for (const name of eliminated) {
      this.systemChat(`💸 ${this.nameOf(name)} is broke and out of the game`);
    }
    this.duel = null;

    this.setTimer(() => {
      if (this.alivePlayers().length <= 1) {
        this.gameOver();
      } else {
        this.spin();
      }
    }, REVEAL_MS);
  }

  // ------------------------------------------------------------ code duel

  private sendToPlayer(username: string, msg: object) {
    for (const [ws, name] of this.sockets) {
      if (name === username) this.send(ws, msg);
    }
  }

  private startCodeDuel(players: [string, string]) {
    this.round += 1;
    this.turn = null;
    this.currentSpin = null;
    const code = Array.from(
      { length: CODE_LENGTH },
      () => CODE_SYMBOLS[Math.floor(Math.random() * CODE_SYMBOLS.length)]
    );
    this.duel = {
      kind: "code",
      players,
      code,
      endsAt: Date.now() + CODE_DUEL_TIME_MS,
      guesses: new Map(),
      attempts: new Map(players.map((p) => [p, []])),
    };
    this.phase = "duel";
    this.broadcast({
      type: "code_duel_start",
      round: this.round,
      players,
      symbols: CODE_SYMBOLS,
      codeLength: CODE_LENGTH,
      maxAttempts: CODE_MAX_ATTEMPTS,
      answerTimeMs: CODE_DUEL_TIME_MS,
    });
    this.systemChat(
      `🧩 Code duel! ${this.nameOf(players[0])} vs ${this.nameOf(players[1])} — crack the code first`
    );
    this.setTimer(() => this.resolveCodeDuel(), CODE_DUEL_TIME_MS);
  }

  /** standard mastermind feedback: exact = right symbol+place,
   *  partial = right symbol wrong place */
  private codeFeedback(code: string[], guess: string[]) {
    let exact = 0;
    const codeRest: string[] = [];
    const guessRest: string[] = [];
    for (let i = 0; i < code.length; i++) {
      if (guess[i] === code[i]) exact++;
      else {
        codeRest.push(code[i]);
        guessRest.push(guess[i]);
      }
    }
    let partial = 0;
    for (const g of guessRest) {
      const idx = codeRest.indexOf(g);
      if (idx !== -1) {
        partial++;
        codeRest.splice(idx, 1);
      }
    }
    return { exact, partial };
  }

  private submitCode(username: string, guess: string[]) {
    const d = this.duel;
    if (this.phase !== "duel" || !d || d.kind !== "code") return;
    if (!d.players.includes(username) || !d.code || !d.attempts) return;
    const mine = d.attempts.get(username)!;
    if (mine.length >= CODE_MAX_ATTEMPTS) return;
    if (
      guess.length !== CODE_LENGTH ||
      guess.some((s) => !CODE_SYMBOLS.includes(s))
    )
      return;

    const { exact, partial } = this.codeFeedback(d.code, guess);
    mine.push({ guess, exact, partial });
    // the guesser sees their own symbols; everyone else only sees numbers
    this.sendToPlayer(username, {
      type: "code_feedback",
      guess,
      exact,
      partial,
      attempt: mine.length,
      attemptsLeft: CODE_MAX_ATTEMPTS - mine.length,
    });
    this.broadcast({
      type: "code_progress",
      username,
      attempt: mine.length,
      exact,
      partial,
    });

    if (exact === CODE_LENGTH) {
      this.resolveCodeDuel(username);
      return;
    }
    const everyoneDone = d.players.every(
      (p) => (d.attempts!.get(p)?.length ?? 0) >= CODE_MAX_ATTEMPTS
    );
    if (everyoneDone) this.resolveCodeDuel();
  }

  private resolveCodeDuel(cracker?: string) {
    const d = this.duel;
    if (this.phase !== "duel" || !d || d.kind !== "code" || !d.code) return;
    this.clearTimers();

    let winner: string | null = cracker ?? null;
    let tie = false;
    if (!winner) {
      // nobody cracked it — best attempt (most exact, then most partial) wins
      const best = d.players.map((p) => {
        const attempts = d.attempts?.get(p) ?? [];
        return attempts.reduce(
          (acc, a) =>
            a.exact > acc.exact ||
            (a.exact === acc.exact && a.partial > acc.partial)
              ? a
              : acc,
          { exact: -1, partial: -1 }
        );
      });
      const [a, b] = best;
      if (a.exact === b.exact && a.partial === b.partial) tie = true;
      else
        winner =
          a.exact > b.exact || (a.exact === b.exact && a.partial > b.partial)
            ? d.players[0]
            : d.players[1];
    }
    const loser = tie
      ? null
      : d.players.find((p) => p !== winner) ?? null;

    let loserDelta = 0;
    if (loser) {
      const player = this.players.get(loser);
      if (player) {
        loserDelta = -Math.min(DUEL_LOSER_COST, player.money);
        player.money += loserDelta;
      }
    }

    const eliminated: string[] = [];
    for (const p of this.players.values()) {
      if (p.alive && p.money <= 0) {
        p.money = 0;
        p.alive = false;
        eliminated.push(p.username);
      }
    }

    this.phase = "reveal";
    this.broadcast({
      type: "code_duel_result",
      round: this.round,
      code: d.code,
      winner,
      loser,
      tie,
      cracked: Boolean(cracker),
      attempts: Object.fromEntries(
        d.players.map((p) => [p, d.attempts?.get(p)?.length ?? 0])
      ),
      loserDelta,
      eliminated,
      players: this.publicPlayers(),
    });
    if (tie) {
      this.systemChat(`🧩 The code duel is a tie — nobody loses money`);
    } else {
      this.systemChat(
        `🧩 ${this.nameOf(winner!)} wins the code duel! ${this.nameOf(loser!)} loses $${-loserDelta}`
      );
    }
    for (const name of eliminated) {
      this.systemChat(`💸 ${this.nameOf(name)} is broke and out of the game`);
    }
    this.duel = null;

    this.setTimer(() => {
      if (this.alivePlayers().length <= 1) {
        this.gameOver();
      } else {
        this.spin();
      }
    }, REVEAL_MS);
  }

  private gameOver() {
    this.clearTimers();
    this.phase = "gameover";
    const standings = this.publicPlayers().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.money - a.money;
    });
    const winner = standings[0]?.username ?? null;
    this.broadcast({
      type: "game_over",
      winner,
      rounds: this.round,
      standings,
    });
    if (winner) this.systemChat(`🏆 ${this.nameOf(winner)} wins the game!`);
    this.onGameOver?.(this);
  }

  // ---------------------------------------------------------------- host moderation

  private kickPlayer(byUsername: string, target: string) {
    const by = this.players.get(byUsername);
    if (!by?.isHost || byUsername === target) return;
    if (!this.players.has(target)) return;

    for (const [ws, name] of [...this.sockets]) {
      if (name === target) {
        this.send(ws, { type: "kicked" });
        this.sockets.delete(ws);
        ws.close();
      }
    }
    this.systemChat(`${this.nameOf(target)} was removed from the lobby by the host`);
    this.removePlayer(target, { silent: true });
    this.onPlayerKicked?.(this, target);
  }

  private terminate(byUsername: string) {
    const by = this.players.get(byUsername);
    if (!by?.isHost) return;
    this.broadcast({ type: "lobby_terminated" });
    this.clearTimers();
    for (const ws of this.sockets.keys()) ws.close();
    this.sockets.clear();
    this.destroy();
    this.onTerminated?.(this);
  }

  playAgainRequest(byUsername: string) {
    if (this.phase !== "gameover") return;
    if (!this.players.get(byUsername)) return;
    for (const p of [...this.players.values()]) {
      if (!p.connected) {
        this.players.delete(p.username);
        continue;
      }
      p.alive = true;
      p.money = STARTING_MONEY;
    }
    this.reassignHost();
    this.round = 0;
    this.chainDepth = 0;
    this.turn = null;
    this.phase = "lobby";
    this.broadcastLobbyState();
  }

  destroy() {
    this.clearTimers();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
  }
}
