/**
 * ===========================================================================
 * lib/handlers/chat.mjs — chat
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../aws.mjs";
import {
  CHAT_MAX_LENGTH,
  CHAT_MIN_INTERVAL_MS,
  CONNECTIONS_TABLE,
} from "../config.mjs";
import { broadcast, postTo, ttlFromNow } from "../connections.mjs";
import { recordChatMessage } from "../chatlog.mjs";

/** chat — flood-controlled the same way GameRoom.receiveChat() is */
async function onChat(event, connectionId, msg, row) {
  if (!row?.username || !row.lobbyId) {
    await postTo(event, connectionId, {
      type: "error",
      message: "join first",
    });
    return;
  }
  const text = String(msg.text ?? "").trim().slice(0, CHAT_MAX_LENGTH);
  if (!text) return;

  const now = Date.now();
  if (now - Number(row.lastChatAt ?? 0) < CHAT_MIN_INTERVAL_MS) return;
  await ddb.send(
    new UpdateCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
      UpdateExpression: "SET #lastChatAt = :n, #expiresAt = :e",
      ExpressionAttributeNames: {
        "#lastChatAt": "lastChatAt",
        "#expiresAt": "expiresAt",
      },
      ExpressionAttributeValues: { ":n": now, ":e": ttlFromNow() },
    })
  );

  await broadcast(event, row.lobbyId, {
    type: "chat_message",
    username: row.username,
    displayName: row.displayName || row.username,
    text,
    at: now,
  });

  // the room has it; this keeps it. Recorded AFTER the broadcast and never
  // awaited for correctness — see chatlog.mjs on why a failure here is not
  // allowed to be the chat's problem
  await recordChatMessage({
    lobbyId: row.lobbyId,
    username: row.username,
    displayName: row.displayName || row.username,
    text,
    at: now,
    kind: "player",
  });
}

export {
  onChat,
};
