import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";

export const MATCHES_TABLE = "Matches";

/** one player's line in a finished match */
export interface MatchStanding {
  username: string;
  displayName: string;
  avatar: string | null;
  /** 1 = winner */
  placement: number;
  /** what they finished with */
  money: number;
  /** still had money when the match ended */
  survived: boolean;
  /** rounds they were still in the game for */
  roundsPlayed: number;
}

/**
 * The full record of one finished match, stored as its own item. Players keep
 * a trimmed copy of this in their own record (see MatchHistoryEntry) — this is
 * what a match-detail lookup reads.
 */
export interface MatchRecord {
  match_id: string;
  lobbyId: string | null;
  roomName: string;
  code: number;
  /** epoch ms the match ended */
  playedAt: number;
  durationMs: number;
  /** total rounds the match ran */
  rounds: number;
  winner: string | null;
  winnerName: string | null;
  /** how far ahead of the runner-up the winner finished ($) */
  margin: number;
  standings: MatchStanding[];
  /** usernames, for cheap participation checks */
  participants: string[];
}

export async function saveMatch(record: MatchRecord): Promise<void> {
  await docClient.send(
    new PutCommand({ TableName: MATCHES_TABLE, Item: record })
  );
}

export async function getMatch(matchId: string): Promise<MatchRecord | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: MATCHES_TABLE, Key: { match_id: matchId } })
  );
  return (res.Item as MatchRecord | undefined) ?? null;
}
