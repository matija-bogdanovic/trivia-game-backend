/**
 * ===========================================================================
 * lib/handlers/connect.mjs — $connect and $disconnect
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { identityFromToken } from "../auth.mjs";
import { ddb } from "../aws.mjs";
import { CONNECTIONS_TABLE } from "../config.mjs";
import {
  broadcast,
  deleteConnection,
  getConnection,
  ttlFromNow,
} from "../connections.mjs";
import { systemChat } from "../messages.mjs";
import { broadcastLobbyState } from "../presence.mjs";

// ─── routes ────────────────────────────────────────────────────────────────
/**
 * $connect — deliberately dumb. The socket is recorded and nothing else; the
 * player is not authenticated and not in a lobby until they send `join`.
 *
 * A token MAY be passed as a query-string parameter (?token=...), in which
 * case it is verified here and a bad one is refused with 401 before the socket
 * opens. That is optional: browsers cannot set headers on a WebSocket
 * handshake, and putting an access token in a URL means it lands in access
 * logs, so `join` remains the intended place to authenticate.
 */
async function onConnect(event) {
  const connectionId = event.requestContext.connectionId;
  const qs = event.queryStringParameters || {};

  let username = null;
  if (qs.token) {
    const identity = await identityFromToken(qs.token);
    if (!identity) return { statusCode: 401, body: "Unauthorized" };
    username = identity.username;
  }

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        // a lobbyId on the query string is honoured, but `join` overrides it
        ...(qs.lobbyId ? { lobbyId: String(qs.lobbyId) } : {}),
        ...(username ? { username } : {}),
        connectedAt: Date.now(),
        expiresAt: ttlFromNow(),
      },
    })
  );
  return { statusCode: 200, body: "Connected" };
}

/**
 * $disconnect — best effort, and API Gateway ignores whatever we return. The
 * row goes first so a failed broadcast cannot leave a ghost behind; the TTL
 * attribute is the backstop for the invocations that never happen at all.
 *
 * ⚠ A HOST DISCONNECT DOES **NOT** CLOSE THE ROOM — deliberately.
 *   $disconnect cannot tell "the host quit" from "the host locked their
 *   phone", "the tunnel blipped", "API Gateway hit its 10-minute idle
 *   timeout" or "the connection hit its 2-hour maximum duration". All four
 *   arrive here identically, and there is no in-process grace timer on
 *   Lambda to wait out a reconnect the way the Express server's 60s
 *   EMPTY_ROOM_GRACE_MS does. Closing on any of them would let a host lose
 *   their room by backgrounding a browser tab.
 *
 *   So a disconnecting host is reported as simply not connected and keeps the
 *   room and the host role; nobody stands in for them, so the lobby shows no
 *   start button until they are back. Deleting the room is reserved for the
 *   two paths that carry real intent: the `leave` message below and
 *   POST /leaveRoom.
 */
async function onDisconnect(event) {
  const connectionId = event.requestContext.connectionId;
  const row = await getConnection(connectionId).catch(() => null);
  await deleteConnection(connectionId).catch((err) =>
    console.error("failed to delete connection row", connectionId, err)
  );

  if (row?.lobbyId) {
    try {
      // A DISCONNECT IS NOT A DEPARTURE. This handler deliberately keeps the
      // player on the roster, keeps their money and keeps the room — only an
      // explicit `leave` or POST /leaveRoom removes anyone. Saying "left the
      // room" here made an ordinary page refresh read as someone walking out.
      // The neutral line plus reason "disconnected" lets the client say
      // whatever it likes ("se rekonektuje…") without the server implying
      // something that did not happen.
      if (row.username) {
        await systemChat(
          event,
          row.lobbyId,
          `${row.displayName || row.username} disconnected`,
          "disconnected"
        );
      }
      // presence is unaffected: lobby_state still shows them as not connected
      await broadcastLobbyState(event, row.lobbyId);
    } catch (err) {
      console.error("disconnect broadcast failed", err);
    }
  }
  return { statusCode: 200, body: "Disconnected" };
}

export {
  onConnect,
  onDisconnect,
};
