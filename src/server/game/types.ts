export type GamePhase =
  | "lobby"
  | "countdown"
  | "spin"
  | "question"
  | "betting"
  | "reveal"
  | "picking"
  | "gameover";

export type BetChoice = "correct" | "wrong";

export interface PlacedBet {
  bet: BetChoice;
  amount: number;
}

export interface BetResult {
  username: string;
  bet: BetChoice;
  amount: number;
  won: boolean;
  moneyDelta: number;
}

export interface GamePlayer {
  username: string;
  /** chosen profile picture ("e|🦊|200" = emoji+hue), null = initials */
  avatar: string | null;
  money: number;
  alive: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface GameQuestion {
  id: string;
  text: string;
  options: string[];
  answer: string;
  /** 1 = easy … 3 = hard; untagged questions default to 1 */
  difficulty: number;
}
