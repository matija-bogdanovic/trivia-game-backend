/**
 * ===========================================================================
 * lib/handlers/join.mjs — join — the only place identity is established
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { identityFromToken, scryptVerify } from "../auth.mjs";
import { ddb } from "../aws.mjs";
import { CONNECTIONS_TABLE, capacityOf } from "../config.mjs";
import { postTo, ttlFromNow } from "../connections.mjs";
import { resolveLobby, walletProfile } from "../lobbies.mjs";
import { phaseMessage, systemChat } from "../messages.mjs";
import { broadcastLobbyState } from "../presence.mjs";
import { publicGameState, readGameState } from "../state.mjs";

// ── $default message handlers ──────────────────────────────────────────────

/**
 * join — the only place identity is established. The username comes from the
 * verified token and NEVER from what the client claims, exactly as in
 * handleGameConnection().
 *
 * ⚠ The lobby id arrives in the message body. The Express server took it from
 * the socket path (`/game/<lobbyId>`); API Gateway WebSocket APIs have no path
 * routing, so the frontend must move it here. See README.
 */
async function onJoin(event, connectionId, msg, row) {
  const identity = await identityFromToken(msg.token);
  if (!identity) {
    await postTo(event, connectionId, {
      type: "join_denied",
      reason: "unauthenticated",
    });
    return;
  }
  const username = identity.username;

  const lobbyId = String(msg.lobbyId ?? row?.lobbyId ?? "").trim();
  if (!lobbyId) {
    await postTo(event, connectionId, {
      type: "error",
      message: "join requires a lobbyId",
    });
    return;
  }

  const lobby = await resolveLobby(lobbyId);
  if (!lobby) {
    await postTo(event, connectionId, {
      type: "error",
      message: "Room not found",
    });
    return;
  }
  // resolveLobby accepts a numeric code too; from here on use the real id so
  // the GSI partition and the roster always agree
  const canonicalId = String(lobby.lobby_id);

  const roster = Array.isArray(lobby.players) ? lobby.players : [];
  const onRoster = roster.some((p) => String(p.player) === username);

  // seat cap — mid-game arrivals would be spectators, but Phase 0 has no
  // mid-game, so a full room is simply full
  if (!onRoster && roster.length >= capacityOf(lobby)) {
    await postTo(event, connectionId, {
      type: "join_denied",
      reason: "room_full",
    });
    return;
  }

  // private rooms: players who did not come through the REST join must
  // present the password (existing members were already checked there)
  if (lobby.isPrivate && !onRoster) {
    let ok = false;
    try {
      ok = scryptVerify(String(msg.password ?? ""), lobby.passwordHash ?? "");
    } catch (err) {
      if (err.name === "BcryptHashError") {
        console.error("legacy bcrypt passwordHash on lobby", canonicalId);
        await postTo(event, connectionId, {
          type: "join_denied",
          reason: "legacy_password_hash",
        });
        return;
      }
      throw err;
    }
    if (!ok) {
      await postTo(event, connectionId, {
        type: "join_denied",
        reason: msg.password ? "wrong_password" : "password_required",
      });
      return;
    }
  }

  const displayName =
    typeof msg.displayName === "string" && msg.displayName.trim()
      ? msg.displayName.trim().slice(0, 50)
      : username;
  const profile = await walletProfile(username);
  const isNew = !row?.username || row.lobbyId !== canonicalId;

  await ddb.send(
    new UpdateCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
      UpdateExpression:
        "SET #username = :u, #displayName = :d, #lobbyId = :l, #avatar = :a, " +
        "#streak = :s, #joinedAt = :j, #expiresAt = :e",
      ExpressionAttributeNames: {
        "#username": "username",
        "#displayName": "displayName",
        "#lobbyId": "lobbyId",
        "#avatar": "avatar",
        "#streak": "streak",
        "#joinedAt": "joinedAt",
        "#expiresAt": "expiresAt",
      },
      ExpressionAttributeValues: {
        ":u": username,
        ":d": displayName,
        ":l": canonicalId,
        ":a": typeof msg.avatar === "string" && msg.avatar.length <= 24
          ? msg.avatar
          : profile.avatar,
        ":s": profile.streak,
        ":j": row?.joinedAt ?? Date.now(),
        ":e": ttlFromNow(),
      },
    })
  );

  // no per-room chat history is persisted yet, but the client clears its list
  // on this message, so send it and keep the contract honest
  await postTo(event, connectionId, { type: "chat_history", messages: [] });
  await broadcastLobbyState(event, canonicalId);

  // RESYNC — a socket joining mid-match is caught up on the spot. Every
  // deadline in the state is absolute, so the phase message below carries the
  // REMAINING time rather than the original duration: a client that reloads
  // two seconds into a five-second spin is told 3000ms, lands mid-animation
  // and stays in step. This is what room.ts's resyncSocket() did from memory,
  // except the memory now survives the process.
  const running = await readGameState(canonicalId);
  if (running && running.phase !== "gameover") {
    await postTo(event, connectionId, {
      type: "game_state",
      state: publicGameState(running),
    });
    const pm = phaseMessage(running);
    if (pm) await postTo(event, connectionId, pm);
  }
  if (isNew) {
    await systemChat(event, canonicalId, `${displayName} joined the room`, "joined");
  }
}

export {
  onJoin,
};
