/**
 * ===========================================================================
 * lib/chatlog.mjs — every chat line, kept
 * ===========================================================================
 * Chat was broadcast and forgotten. Not "held briefly then expired" — the
 * `chat` array on the match state is declared `[]` by initialGameState and
 * NOTHING has ever appended to it, so a message existed only in the memory of
 * the clients that happened to be connected when it was sent. `chat_history`
 * on join has always answered with an empty list for that reason.
 *
 * ── THE STORE, AND WHY THIS ONE ────────────────────────────────────────────
 * One item per message in `ChatMessages`, keyed (lobbyId, message_id).
 *
 * The alternative was folding a transcript into the Matches archive at match
 * end — one write, no new table. It loses too much: everything said in the
 * lobby BEFORE the match starts, everything in a room that is abandoned
 * without ever finishing, and anything said after gameover. For a feature
 * whose whole purpose is to collect the messages, "only rooms that reached a
 * conclusion" is the wrong half.
 *
 * It also must NOT be an array on the Lobby item. Chat is unbounded by nature
 * and that item is rewritten whole by joins and leaves; an append-only list
 * there walks into the 400KB ceiling and takes room joining down with it.
 *
 * `message_id` is `<epoch ms>#<8 hex>` as a STRING, which is what makes a
 * Query on lobbyId come back already in order, and what stops two messages in
 * the same millisecond overwriting each other.
 *
 * ── FAILURE IS NOT THE CHAT'S PROBLEM ──────────────────────────────────────
 * Every write here is best-effort and awaited inside its own try/catch. A
 * logging table being slow or unreachable must never be the reason a message
 * fails to reach the room — the broadcast happens first and this follows it.
 *
 * ── NO TTL ─────────────────────────────────────────────────────────────────
 * Deliberately absent, unlike GameState (24h) and Connections (2h). These are
 * being collected, not cached.
 * ===========================================================================
 */

import crypto from "node:crypto";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import { CHAT_MESSAGES_TABLE, CHAT_MAX_LENGTH } from "./config.mjs";

/**
 * How much of a conversation a joiner is handed.
 *
 * The client keeps a display window of its own and trims to it, so sending
 * more than that would be paid for on the wire and thrown away on arrival.
 */
const CHAT_HISTORY_LIMIT = 60;

/** `<epoch ms>#<8 hex>` — ordered by time, unique within the millisecond */
function messageId(at) {
  return `${at}#${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Record one line.
 *
 * `kind` separates the two voices that share this table: "player" is somebody
 * typing, "system" is the room narrating itself (joins, eliminations,
 * achievement unlocks). Both are worth keeping and they are worth telling
 * apart — a transcript that cannot distinguish them reads as if the room were
 * talking to itself.
 *
 * Returns true when the write landed, so a caller that cares can tell; nothing
 * currently does, and nothing should have to.
 */
async function recordChatMessage({
  lobbyId,
  username = null,
  displayName = null,
  text,
  at = Date.now(),
  kind = "player",
  reason = null,
}) {
  if (!lobbyId || !text) return false;

  try {
    await ddb.send(
      new PutCommand({
        TableName: CHAT_MESSAGES_TABLE,
        Item: {
          lobbyId: String(lobbyId),
          message_id: messageId(at),
          at,
          kind,
          text: String(text).slice(0, CHAT_MAX_LENGTH),
          // a system line has no author; the attribute is omitted rather than
          // stored as null, so "who said this" is absent instead of empty
          ...(username ? { username: String(username) } : {}),
          ...(displayName ? { displayName: String(displayName) } : {}),
          ...(reason ? { reason: String(reason) } : {}),
        },
      })
    );
    return true;
  } catch (err) {
    // best effort: the room already has the message, this is the archive
    console.error("chat log write failed", lobbyId, err?.name ?? err);
    return false;
  }
}

/**
 * The room's conversation, oldest first.
 *
 * ── WHY THIS DID NOT EXIST UNTIL NOW ───────────────────────────────────────
 * It was written and never read. `join` answered every arrival with
 * `chat_history: []` under a comment saying no history was persisted — true
 * when that line was written, and untrue from the moment this file landed.
 * The table has been collecting messages the whole time.
 *
 * The cost was not a missing feature, it was a DESTRUCTIVE one: the client
 * REPLACES its list on chat_history, and a reconnect is a fresh join. So every
 * dropped connection wiped the chat for whoever reconnected, and the room's
 * own record of the conversation sat unread in DynamoDB.
 *
 * ScanIndexForward:false takes the NEWEST rows — a Query cannot ask for "the
 * last 60" any other way — and the result is reversed so the client receives
 * them in the order a conversation is read.
 */
async function loadChatHistory(lobbyId, limit = CHAT_HISTORY_LIMIT) {
  if (!lobbyId) return [];
  try {
    const res = await ddb.send(
      new QueryCommand({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: "lobbyId = :l",
        ExpressionAttributeValues: { ":l": String(lobbyId) },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items ?? [])
      .reverse()
      .map((item) => ({
        username: item.username ?? null,
        displayName: item.displayName ?? null,
        text: item.text ?? "",
        at: Number(item.at ?? 0),
        ...(item.kind === "system" ? { kind: "system" } : {}),
      }));
  } catch (err) {
    /*
     * An empty list, never a throw. Failing to read the backlog must not fail
     * the join — arriving in a room with no history is a worse outcome than
     * arriving in no room at all, but only slightly, and the live messages
     * still work.
     */
    console.error("chat history read failed", lobbyId, err?.name ?? err);
    return [];
  }
}

export { messageId, recordChatMessage, loadChatHistory };
