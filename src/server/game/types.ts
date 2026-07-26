export type GamePhase =
  | "lobby"
  | "countdown"
  | "question"
  | "reveal"
  | "gameover";

export interface GamePlayer {
  username: string;
  points: number;
  alive: boolean;
  connected: boolean;
  isHost: boolean;
  /** answer given in the current round, null = not answered yet */
  answer: string | null;
  /** ms elapsed between round start and the answer */
  answeredInMs: number | null;
}

export interface GameQuestion {
  id: string;
  text: string;
  options: string[];
  answer: string;
}

export interface RoundResultEntry {
  username: string;
  answer: string | null;
  correct: boolean;
  timeMs: number | null;
  pointsDelta: number;
  eliminated: boolean;
}
