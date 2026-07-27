export type GamePhase =
  | "lobby"
  | "countdown"
  | "spin"
  | "question"
  | "betting"
  | "reveal"
  | "picking"
  | "duel"
  | "gameover";

/** numeric closest-guess question used in duels */
export interface GuessQuestion {
  text: string;
  value: number;
}

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
  /** unique account id (Cognito username) — the identity key */
  username: string;
  /** what other players see (Google name, chosen name, ...) */
  displayName: string;
  /** chosen profile picture ("e|🦊|200" = emoji+hue), null = initials */
  avatar: string | null;
  money: number;
  alive: boolean;
  connected: boolean;
  isHost: boolean;
  /** lifetime consecutive-win streak, shown in the lobby */
  streak: number;
}

export interface GameQuestion {
  id: string;
  text: string;
  options: string[];
  answer: string;
  /** 1 = easy … 3 = hard; untagged questions default to 1 */
  difficulty: number;
}
