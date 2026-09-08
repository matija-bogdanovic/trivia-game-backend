/**
 * ===========================================================================
 * lib/lobbies.mjs — reads against the Lobbies and Players tables
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import { LOBBIES_TABLE, PLAYERS_TABLE } from "./config.mjs";

// ─── the Lobbies table (shared with the REST stack) ────────────────────────
/** accepts a lobby_id (UUID, the URL form) or a numeric room code */
async function resolveLobby(idOrCode) {
  const key = String(idOrCode ?? "").trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: LOBBIES_TABLE,
        IndexName: "code-index",
        KeyConditionExpression: "#code = :val",
        ExpressionAttributeNames: { "#code": "code" },
        ExpressionAttributeValues: { ":val": Number(key) },
      })
    );
    return res.Items?.[0] ?? null;
  }
  const res = await ddb.send(
    new GetCommand({ TableName: LOBBIES_TABLE, Key: { lobby_id: key } })
  );
  return res.Item ?? null;
}

/** cosmetic only: streak badge + avatar. Never fatal. */
async function walletProfile(username) {
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: PLAYERS_TABLE, Key: { username } })
    );
    return {
      streak: Number(res.Item?.currentStreak ?? 0),
      avatar: res.Item?.avatar ?? null,
    };
  } catch {
    return { streak: 0, avatar: null };
  }
}

/**
 * The username on a Lobbies roster seat.
 *
 * A seat is written by createRoom and joinRoom as
 *   { id, player, role, points, joinedAt }
 * — `player` is the name, and there is NO `username` field. succession.mjs and
 * isHostOf below have always read `player`; invite.mjs read `p?.username`,
 * which is undefined on every real seat, so its "already at this table" guard
 * compared undefined to a name and never fired once in production. Its own
 * test passed because the fixture invented a `username` key the writers do
 * not produce.
 *
 * `id` and the string form are accepted too: `id` carried a client-supplied
 * number on rooms made before it was changed to the verified username, and the
 * oldest rooms stored bare strings.
 */
function seatName(seat) {
  if (typeof seat === "string") return seat;
  const name = seat?.player ?? seat?.username ?? seat?.id;
  return name == null ? null : String(name);
}

/**
 * Is this player the room's Admin?
 *
 * Lives here rather than in a handler because TWO of them need it now: the
 * host-only gate in room.mjs, and invite.mjs, where being the host is what
 * lets you name someone who is not on your friends list. One definition, so
 * the two can never come to disagree about who is holding the room.
 *
 * The `players` roster is the authority, not the top-level `owner` field:
 * succession rewrites both, but the Admin ROLE on the seat is what every
 * existing check has always read, and a room written before `owner` existed
 * still has a correct role.
 */
function isHostOf(lobby, username) {
  if (!username || !Array.isArray(lobby?.players)) return false;
  const host = lobby.players.find((p) => p?.role === "Admin");
  return Boolean(host && seatName(host) === String(username));
}

export {
  isHostOf,
  seatName,
  resolveLobby,
  walletProfile,
};
