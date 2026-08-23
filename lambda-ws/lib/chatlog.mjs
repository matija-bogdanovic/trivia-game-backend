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
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import { CHAT_MESSAGES_TABLE, CHAT_MAX_LENGTH } from "./config.mjs";

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

export { messageId, recordChatMessage };
