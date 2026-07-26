import { WebSocket } from "ws";
import {
  BetResult,
  GamePhase,
  GamePlayer,
  GameQuestion,
  PlacedBet,
} from "./types.js";
import { loadQuestions, QuestionDeck } from "./questions.js";

export const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;
const SPIN_TIME_MS = 3500;
const BASE_QUESTION_TIME_MS = 15000;
const MIN_QUESTION_TIME_MS = 8000;
const BETTING_TIME_MS = 4500;
const REVEAL_MS = 5000;
const PICK_TIME_MS = 15000;
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
  private round = 0;
  private chainDepth = 0;
  private timers = new Set<NodeJS.Timeout>();
  private emptyTimer: NodeJS.Timeout | null = null;
  private chat: ChatEntry[] = [];
  private lastChatAt = new Map<string, number>();

  /** called once when a game finishes, for persistence */
  onGameOver?: (room: GameRoom) => void;
  /** called when the room has had no connections for a while */
  onEmpty?: (room: GameRoom) => void;

  constructor(code: number, roomName: string) {
    this.code = code;
    this.roomName = roomName;
  }

  // ---------------------------------------------------------------- players

  addPlayer(
    username: string,
    opts: { money?: number; isHost?: boolean } = {}
  ): GamePlayer {
    const existing = this.players.get(username);
    if (existing) return existing;
    const player: GamePlayer = {
      username,
      money: opts.money ?? STARTING_MONEY,
      alive: this.phase === "lobby",
      connected: false,
      isHost: opts.isHost ?? false,
    };
    this.players.set(username, player);
    return player;
  }

  connect(ws: WebSocket, username: string) {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
    const known = this.players.get(username);
    const isReconnect = known !== undefined && !known.connected;
    const isNew = known === undefined;
    const player = this.addPlayer(username);
    player.connected = true;
    this.sockets.set(ws, username);
    if (![...this.players.values()].some((p) => p.isHost && p.connected)) {
      this.reassignHost();
    }
    this.broadcastLobbyState();
    // catch the new socket up on the conversation so far
    this.send(ws, { type: "chat_history", messages: this.chat });
    if (isNew) this.systemChat(`${username} joined the room`);
    else if (isReconnect) this.systemChat(`${username} reconnected`);
    // rejoining mid-turn: resend the current question so they see the board
    if (
      (this.phase === "question" || this.phase === "betting") &&
      this.turn
    ) {
      this.send(ws, this.turnQuestionMessage());
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
          this.systemChat(`${username} left the room`);
        } else {
          this.systemChat(`${username} lost connection`);
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

  removePlayer(username: string) {
    const player = this.players.get(username);
    if (!player) return;
    this.players.delete(username);
    if (player.isHost) this.reassignHost();
    this.systemChat(`${username} left the room`);
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
      money: p.money,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
    }));
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
    this.pushChat({ username, text, at: now });
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
    const target = alive[Math.floor(Math.random() * alive.length)];
    this.phase = "spin";
    this.broadcast({
      type: "spin",
      target: target.username,
      spinTimeMs: SPIN_TIME_MS,
    });
    this.setTimer(() => this.askQuestion(target.username), SPIN_TIME_MS);
  }

  private askQuestion(answering: string) {
    if (this.phase === "gameover" || !this.deck) return;
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
      question: this.deck.draw(difficulty),
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
    }

    const betResults: BetResult[] = [];
    for (const [bettor, placed] of t.bets) {
      const player = this.players.get(bettor);
      if (!player) continue;
      const won = (placed.bet === "correct") === correct;
      const stake = Math.min(placed.amount, player.money);
      const moneyDelta = won ? stake : -stake;
      player.money += moneyDelta;
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
      this.systemChat(`${t.answering} answered correctly`);
    } else {
      this.systemChat(
        `${t.answering} ${timedOut ? "ran out of time" : "answered wrong"} and loses $${-answererDelta}`
      );
    }
    for (const name of eliminated) {
      this.systemChat(`💸 ${name} is broke and out of the game`);
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
    this.systemChat(`${username} imposes the next question on ${target}`);
    this.askQuestion(target);
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
    if (winner) this.systemChat(`🏆 ${winner} wins the game!`);
    this.onGameOver?.(this);
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
