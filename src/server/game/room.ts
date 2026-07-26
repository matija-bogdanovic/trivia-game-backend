import { WebSocket } from "ws";
import {
  GamePhase,
  GamePlayer,
  GameQuestion,
  RoundResultEntry,
} from "./types.js";
import { loadQuestions, shuffle } from "./questions.js";

export const MIN_PLAYERS = 2;
const COUNTDOWN_SECONDS = 3;
const QUESTION_TIME_MS = 15000;
const REVEAL_MS = 6000;
const EMPTY_ROOM_GRACE_MS = 60000;
const STARTING_POINTS = 500;
const CORRECT_BASE_POINTS = 100;
const SPEED_BONUS_MAX = 100;
const WRONG_PENALTY = 100;

/**
 * One live game room ("ruski rulet" rules):
 * every alive player answers the same question at the same time, against the
 * clock. Wrong or missing answer = eliminated. If a round would eliminate
 * everyone, nobody is eliminated. If everyone answers correctly, the slowest
 * player is eliminated — being right isn't enough, you have to be fast.
 * Rounds repeat until one player remains.
 */
export class GameRoom {
  readonly code: number;
  readonly roomName: string;
  lobbyId: string | null = null;

  phase: GamePhase = "lobby";
  players = new Map<string, GamePlayer>();
  private sockets = new Map<WebSocket, string>();

  private questions: GameQuestion[] = [];
  private questionPos = 0;
  private currentQuestion: GameQuestion | null = null;
  private round = 0;
  private roundStartedAt = 0;
  private timers = new Set<NodeJS.Timeout>();
  private emptyTimer: NodeJS.Timeout | null = null;

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
    opts: { points?: number; isHost?: boolean } = {}
  ): GamePlayer {
    const existing = this.players.get(username);
    if (existing) return existing;
    const player: GamePlayer = {
      username,
      points: opts.points ?? STARTING_POINTS,
      alive: this.phase === "lobby",
      connected: false,
      isHost: opts.isHost ?? false,
      answer: null,
      answeredInMs: null,
    };
    this.players.set(username, player);
    return player;
  }

  connect(ws: WebSocket, username: string) {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
    const player = this.addPlayer(username);
    player.connected = true;
    this.sockets.set(ws, username);
    if (![...this.players.values()].some((p) => p.isHost && p.connected)) {
      this.reassignHost();
    }
    this.broadcastLobbyState();
    // late joiner mid-game still gets the current question so they can watch
    if (this.phase === "question" && this.currentQuestion) {
      this.send(ws, this.roundStartMessage());
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

    if (this.phase !== "lobby" && this.phase !== "gameover") {
      const alive = this.alivePlayers();
      if (alive.length <= 1) {
        this.gameOver();
        return;
      }
      if (this.phase === "question" && this.everyAliveAnswered()) {
        this.endRound();
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

  private everyAliveAnswered(): boolean {
    return this.alivePlayers().every((p) => p.answer !== null);
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
      points: p.points,
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

  private roundStartMessage() {
    const q = this.currentQuestion!;
    return {
      type: "round_start",
      round: this.round,
      questionText: q.text,
      options: q.options,
      answerTimeMs: Math.max(
        0,
        this.roundStartedAt + QUESTION_TIME_MS - Date.now()
      ),
      aliveCount: this.alivePlayers().length,
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
      case "play_again":
        this.playAgain(username);
        break;
      case "leave":
        this.sockets.delete(ws);
        this.removePlayer(username);
        break;
    }
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
    this.questions = shuffle(questions);
    this.questionPos = 0;

    // only players present at the start participate
    for (const p of [...this.players.values()]) {
      if (!p.connected) this.players.delete(p.username);
    }
    for (const p of this.players.values()) {
      p.alive = true;
      p.points = STARTING_POINTS;
      p.answer = null;
      p.answeredInMs = null;
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
        this.startRound();
      }
    };
    tick();
  }

  private nextQuestion(): GameQuestion {
    if (this.questionPos >= this.questions.length) {
      this.questions = shuffle(this.questions);
      this.questionPos = 0;
    }
    return this.questions[this.questionPos++];
  }

  private startRound() {
    if (this.phase === "gameover") return;
    this.round += 1;
    this.currentQuestion = this.nextQuestion();
    for (const p of this.players.values()) {
      p.answer = null;
      p.answeredInMs = null;
    }
    this.phase = "question";
    this.roundStartedAt = Date.now();
    this.broadcast(this.roundStartMessage());
    this.setTimer(() => this.endRound(), QUESTION_TIME_MS);
  }

  private submitAnswer(username: string, answer: string) {
    if (this.phase !== "question") return;
    const player = this.players.get(username);
    if (!player || !player.alive || player.answer !== null) return;

    player.answer = answer;
    player.answeredInMs = Date.now() - this.roundStartedAt;

    const alive = this.alivePlayers();
    this.broadcast({
      type: "player_answered",
      username,
      answeredCount: alive.filter((p) => p.answer !== null).length,
      aliveCount: alive.length,
    });

    if (this.everyAliveAnswered()) this.endRound();
  }

  private endRound() {
    if (this.phase !== "question" || !this.currentQuestion) return;
    this.clearTimers();
    const question = this.currentQuestion;
    const alive = this.alivePlayers();

    const results: RoundResultEntry[] = alive.map((p) => {
      const correct = p.answer === question.answer;
      const timeMs = p.answeredInMs;
      let pointsDelta: number;
      if (correct) {
        const speedBonus = Math.round(
          SPEED_BONUS_MAX * (1 - (timeMs ?? QUESTION_TIME_MS) / QUESTION_TIME_MS)
        );
        pointsDelta = CORRECT_BASE_POINTS + Math.max(0, speedBonus);
      } else {
        pointsDelta = -WRONG_PENALTY;
      }
      return {
        username: p.username,
        answer: p.answer,
        correct,
        timeMs,
        pointsDelta,
        eliminated: false,
      };
    });

    const wrong = results.filter((r) => !r.correct);
    let everyoneSpared = false;

    if (wrong.length === results.length) {
      // everyone failed — russian roulette clicks on an empty chamber
      everyoneSpared = true;
    } else if (wrong.length === 0) {
      // everyone was right — the slowest player is eliminated
      const slowest = [...results].sort(
        (a, b) => (b.timeMs ?? Infinity) - (a.timeMs ?? Infinity)
      )[0];
      if (results.length > 1) slowest.eliminated = true;
    } else {
      for (const r of wrong) r.eliminated = true;
    }

    for (const r of results) {
      const p = this.players.get(r.username);
      if (!p) continue;
      p.points += r.pointsDelta;
      if (r.eliminated) p.alive = false;
    }

    this.phase = "reveal";
    this.broadcast({
      type: "round_result",
      round: this.round,
      correctAnswer: question.answer,
      everyoneSpared,
      results,
      players: this.publicPlayers(),
    });

    this.setTimer(() => {
      if (this.alivePlayers().length <= 1) {
        this.gameOver();
      } else {
        this.startRound();
      }
    }, REVEAL_MS);
  }

  private gameOver() {
    this.clearTimers();
    this.phase = "gameover";
    const standings = this.publicPlayers().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.points - a.points;
    });
    const winner = standings[0]?.username ?? null;
    this.broadcast({
      type: "game_over",
      winner,
      rounds: this.round,
      standings,
    });
    this.onGameOver?.(this);
  }

  private playAgain(byUsername: string) {
    if (this.phase !== "gameover") return;
    if (!this.players.get(byUsername)) return;
    for (const p of [...this.players.values()]) {
      if (!p.connected) {
        this.players.delete(p.username);
        continue;
      }
      p.alive = true;
      p.points = STARTING_POINTS;
      p.answer = null;
      p.answeredInMs = null;
    }
    this.reassignHost();
    this.round = 0;
    this.phase = "lobby";
    this.broadcastLobbyState();
  }

  destroy() {
    this.clearTimers();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
  }
}
