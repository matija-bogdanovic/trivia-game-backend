/**
 * ===========================================================================
 * lib/handlers/room.mjs — leave, close, the host gate, and kick_player
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../aws.mjs";
import { CONNECTIONS_TABLE, GAME_STATE_TABLE, LOBBIES_TABLE } from "../config.mjs";
import {
  broadcast,
  connectionsInLobby,
  deleteConnection,
  postTo,
  ttlFromNow,
} from "../connections.mjs";
import { resolveLobby } from "../lobbies.mjs";
import { broadcastPhase, systemChat } from "../messages.mjs";
import { enterGameOver } from "../phases.mjs";
import { broadcastLobbyState } from "../presence.mjs";
import { rearmPhaseTimer } from "../scheduler.mjs";
import { mutateGameState, readGameState } from "../state.mjs";
import { livingPlayers } from "../turn.mjs";

/**
 * Close a room for good: tell everyone first, then tear down.
 *
 * Order matters. The room_closed broadcast goes out BEFORE the Lobbies item
 * and the Connections rows are deleted, because the fan-out reads the
 * lobby-index to find who to tell — reap first and there is nobody left to
 * notify.
 *
 * The sockets themselves are left open. room_closed is the client's cue to
 * navigate away; forcibly closing the connection would deny it the chance to
 * show anything. Their Connections rows go, so nothing is bound to a room
 * that no longer exists — and because `join` writes with UpdateCommand, a
 * client that joins somewhere else simply recreates its row.
 */
async function closeRoom(event, lobbyId, reason) {
  await broadcast(event, lobbyId, { type: "room_closed", reason });

  await ddb.send(
    new DeleteCommand({ TableName: LOBBIES_TABLE, Key: { lobby_id: lobbyId } })
  );
  // the match state dies with the room; without this a closed room leaves an
  // orphaned GameState item behind until its 24h TTL reaps it
  await ddb
    .send(new DeleteCommand({ TableName: GAME_STATE_TABLE, Key: { lobbyId } }))
    .catch((err) => console.error("failed to delete game state", lobbyId, err));

  const rows = await connectionsInLobby(lobbyId);
  await Promise.all(
    rows.map((r) => deleteConnection(r.connectionId).catch(() => {}))
  );
}

/** is this connection's user the room's Admin? */
async function isHostOf(lobby, username) {
  if (!username || !Array.isArray(lobby?.players)) return false;
  const host = lobby.players.find((p) => p?.role === "Admin");
  return Boolean(host && String(host.player) === username);
}

/**
 * HOST-ONLY GATE — a permanent rule, not a Phase 0 placeholder.
 *
 * Returns true when the sender may proceed; when it returns false it has
 * ALREADY answered the client, so the caller must simply stop.
 *
 * Why this cannot be bypassed from the client: the identity is not taken from
 * the message. It is `row.username`, written onto the connection at `join`
 * from a Cognito access token this function verified itself, and compared
 * against the Admin entry read fresh from the Lobbies table. A client can
 * claim any `type` it likes and none of it touches either side of that
 * comparison. Spoofing it would mean forging a Cognito RS256 signature.
 *
 * The lobby is re-read on every call rather than cached on the connection, so
 * a host transfer takes effect immediately and a stale socket cannot keep
 * host powers it no longer has.
 */
const HOST_ONLY_ACTIONS = new Set([
  "start_game",
  "kick_player",
  "terminate_lobby",
]);

/** English-neutral; the client localises off `reason` + `action` */
const HOST_ONLY_MESSAGE = {
  start_game: "Only the room host can start the game.",
  kick_player: "Only the room host can remove players.",
  terminate_lobby: "Only the room host can close the room.",
};

async function requireHost(event, connectionId, row, action) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error",
      reason: "not_joined",
      action,
      message: "Join the room before doing that.",
    });
    return false;
  }

  const lobby = await resolveLobby(row.lobbyId);
  if (!lobby) {
    await postTo(event, connectionId, {
      type: "error",
      reason: "room_not_found",
      action,
      message: "That room no longer exists.",
    });
    return false;
  }

  if (!(await isHostOf(lobby, row.username))) {
    await postTo(event, connectionId, {
      type: "error",
      reason: "not_host",
      action,
      message: HOST_ONLY_MESSAGE[action] ?? "Only the room host can do that.",
    });
    return false;
  }
  return true;
}

/**
 * terminate_lobby — the host closes the room on purpose ("Zatvori sobu").
 *
 * Host-gated upstream by requireHost(), so the identity is a Cognito-verified
 * username compared against the Lobbies Admin — a non-host is refused with
 * reason "not_host" and nothing here runs.
 *
 * It is the SAME teardown the host walking out performs: closeRoom() tells
 * everyone, then deletes the Lobbies item, the GameState item and every
 * Connections row. Deliberately one shared function rather than two — a second
 * copy of "close a room" is a second place for the ordering to be got wrong.
 *
 * ⚠ THE REASON DIFFERS, ON PURPOSE: "host_closed", not "host_left". Both mean
 *   the room is gone, but they are different sentences to a player — "domaćin
 *   je zatvorio sobu" vs "domaćin je napustio sobu" — and the server is the
 *   only side that knows which happened. A client that only understands
 *   "host_left" still behaves correctly if it routes on `type` and treats the
 *   reason as a label.
 *
 * IDEMPOTENT. Every step is a delete of something that may already be gone, so
 * a double-click is harmless; the second call finds no room and is answered
 * with reason "room_not_found" rather than pretending to close it again.
 */
async function onTerminateLobby(event, connectionId, row) {
  const lobby = await resolveLobby(row.lobbyId);
  if (!lobby) {
    await postTo(event, connectionId, {
      type: "error", reason: "room_not_found", action: "terminate_lobby",
      message: "That room no longer exists.",
    });
    return;
  }
  // resolveLobby accepts a room code too; tear down by the real id so the
  // GSI partition, the Lobbies key and the GameState key all agree
  await closeRoom(event, String(lobby.lobby_id), "host_closed");
}

/**
 * leave — an explicit, intentional departure.
 *
 * WHEN THE HOST LEAVES, THE ROOM IS DELETED. Note this is a different case
 * from the host merely being disconnected, where the room and the host role
 * both survive untouched — see the $disconnect note above.
 *
 * A non-host leaving is presence-only, exactly as before.
 */
async function onLeave(event, connectionId, row) {
  if (!row?.lobbyId) return;
  const lobbyId = row.lobbyId;

  const lobby = await resolveLobby(lobbyId);
  if (await isHostOf(lobby, row.username)) {
    await closeRoom(event, lobbyId, "host_left");
    return;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
      UpdateExpression:
        "SET #expiresAt = :e REMOVE #lobbyId, #username, #displayName",
      ExpressionAttributeNames: {
        "#expiresAt": "expiresAt",
        "#lobbyId": "lobbyId",
        "#username": "username",
        "#displayName": "displayName",
      },
      ExpressionAttributeValues: { ":e": ttlFromNow() },
    })
  );
  // the ONE place that claims someone left, because it is the one place they did
  if (row.username) {
    await systemChat(
      event,
      lobbyId,
      `${row.displayName || row.username} left the room`,
      "left"
    );
  }
  await broadcastLobbyState(event, lobbyId);
}

/**
 * kick_player — the host removes someone from the room.
 *
 * Host-gated upstream by requireHost(), so the identity doing the kicking is a
 * Cognito-verified username compared against the Lobbies Admin, not anything
 * the message claims.
 *
 * FOUR THINGS HAVE TO HAPPEN, AND THE ORDER MATTERS:
 *   1. tell the kicked player  — their Connections rows are the only way to
 *      reach them, and step 3 deletes those rows. Message them first or the
 *      `kicked` event has nowhere to go, which is the same ordering bug
 *      closeRoom() documents.
 *   2. off the roster          — removed by INDEX with a condition asserting
 *      that index still holds that player, so a concurrent join or leave
 *      cannot be clobbered by a whole-list overwrite.
 *   3. drop their sockets      — the rows go, so presence stops counting them.
 *      The sockets stay OPEN: `kicked` is the client's cue to navigate to
 *      /rooms, and closing the connection would deny it the chance to act.
 *   4. tell everyone else      — a system line plus a fresh lobby_state.
 *
 * IDEMPOTENT. Kicking someone already gone does each step's no-op: nobody to
 * message, a conditional roster write that either finds nothing to remove or
 * fails its condition harmlessly, no rows to delete. It still re-broadcasts
 * presence and still answers the host, so a double-click is safe.
 *
 * THE ROOM SURVIVES and nobody else is touched. Self-kick is refused: the host
 * leaving is `leave`/POST /leaveRoom, which deliberately CLOSES the room —
 * quietly routing a self-kick into that would delete everyone's room from
 * under them.
 */
async function onKickPlayer(event, connectionId, row, msg) {
  const target = String(msg.target ?? msg.username ?? msg.player ?? "").trim();
  if (!target) {
    await postTo(event, connectionId, {
      type: "error", reason: "missing_target", action: "kick_player",
      message: "Name the player to remove.",
    });
    return;
  }
  if (target === row.username) {
    await postTo(event, connectionId, {
      type: "error", reason: "cannot_kick_self", action: "kick_player",
      message: "You cannot remove yourself — leave the room instead.",
    });
    return;
  }

  const lobby = await resolveLobby(row.lobbyId);
  if (!lobby) {
    await postTo(event, connectionId, {
      type: "error", reason: "room_not_found", action: "kick_player",
      message: "That room no longer exists.",
    });
    return;
  }
  const canonicalId = String(lobby.lobby_id);

  const roster = Array.isArray(lobby.players) ? lobby.players : [];
  const seatIndex = roster.findIndex((p) => String(p?.player) === target);
  const rows = (await connectionsInLobby(canonicalId)).filter(
    (r) => r.username === target
  );
  const displayName = rows[0]?.displayName || target;

  // 1 — reach them while they can still be reached
  for (const r of rows) {
    await postTo(event, r.connectionId, {
      type: "kicked",
      reason: "host",
      lobbyId: canonicalId,
      by: row.username,
    });
  }

  // 2 — off the roster, atomically at that seat
  let removedFromRoster = false;
  if (seatIndex >= 0) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: LOBBIES_TABLE,
          Key: { lobby_id: canonicalId },
          UpdateExpression: `REMOVE #players[${seatIndex}]`,
          ConditionExpression: `#players[${seatIndex}].#player = :t`,
          ExpressionAttributeNames: { "#players": "players", "#player": "player" },
          ExpressionAttributeValues: { ":t": target },
        })
      );
      removedFromRoster = true;
    } catch (err) {
      // the seat moved or emptied between our read and our write — somebody
      // else already removed them, which is the outcome we wanted anyway
      if (err?.name !== "ConditionalCheckFailedException") throw err;
      console.warn("kick lost the roster race (already gone)", target);
    }
  }

  // 3 — unbind their sockets
  for (const r of rows) {
    await deleteConnection(r.connectionId).catch((err) =>
      console.error("kick: failed to delete connection", r.connectionId, err)
    );
  }

  // 4 — a kicked player FORFEITS a match in progress. They keep their row in
  // the match state (deleting it would make sum(money) + pot jump) but stop
  // being alive, and their remaining money goes INTO THE POT exactly like a
  // wrong answer's penalty — so it is inherited by whoever is still playing
  // rather than stranded on a player who has left the building.
  const running = await readGameState(canonicalId);
  let forfeited = 0;
  if (running && running.phase !== "gameover") {
    const res = await mutateGameState(canonicalId, (s) => {
      const p = (s.players ?? []).find((x) => x.username === target);
      if (!p || !p.alive) return null; // never seated, or already out
      forfeited = Math.max(0, Number(p.money ?? 0));
      p.money = 0;
      p.alive = false;
      p.connected = false;
      s.pot = Number(s.pot ?? 0) + forfeited;
      s.kicked = [...(s.kicked ?? []), target];
      // the match cannot continue with one player standing
      return livingPlayers(s).length <= 1 ? enterGameOver(s) : s;
    });
    if (res.ok) {
      await broadcastPhase(event, canonicalId, res.state);
      if (res.state.phase === "gameover") {
        await rearmPhaseTimer(res.state, running.executionArn);
      }
      // NOTE: if the kicked player owned the live phase (their question, their
      // duel), the match is left to its EXISTING deadline rather than being
      // shoved forward here. That timer already resolves an unanswered
      // question as a timeout, so the cost is a wait of at most one phase and
      // the alternative is a second transition racing the one above.
    }
  }

  await systemChat(
    event,
    canonicalId,
    `${displayName} was removed by the host`,
    "kicked"
  );
  await broadcastLobbyState(event, canonicalId);

  await postTo(event, connectionId, {
    type: "kick_result",
    target,
    removedFromRoster,
    connectionsClosed: rows.length,
    forfeited,
  });
}

export {
  HOST_ONLY_ACTIONS,
  HOST_ONLY_MESSAGE,
  closeRoom,
  isHostOf,
  onKickPlayer,
  onLeave,
  onTerminateLobby,
  requireHost,
};
