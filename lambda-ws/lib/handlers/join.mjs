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
import {
  CONNECTIONS_TABLE,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  capacityOf,
} from "../config.mjs";
import { postTo, ttlFromNow } from "../connections.mjs";
import { resolveLobby, walletProfile } from "../lobbies.mjs";
import { loadChatHistory } from "../chatlog.mjs";
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
    /*
     * join_denied, not a bare error.
     *
     * "Room not found" arrived as a generic error string, which the client
     * could only render as a dismissible banner — leaving the reader parked on
     * the URL of a room that does not exist, with nothing to do but type
     * somewhere else. A reason code is something the client can ACT on, and
     * this one means "go back to the list".
     *
     * The error is still sent alongside it for any client that predates the
     * reason code and only knows how to show a message.
     */
    await postTo(event, connectionId, {
      type: "join_denied",
      reason: "room-gone",
      lobbyId,
    });
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
        "#streak = :s, #joinedAt = :j, #expiresAt = :e, #lang = :lang",
      ExpressionAttributeNames: {
        "#username": "username",
        "#displayName": "displayName",
        "#lobbyId": "lobbyId",
        "#avatar": "avatar",
        "#streak": "streak",
        "#joinedAt": "joinedAt",
        "#expiresAt": "expiresAt",
        "#lang": "lang",
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
        /*
         * The client's current i18n language, which is what start_game counts
         * to pick the match language. Validated against the supported list
         * rather than trusted: this is client-supplied, and an unknown value
         * must land on the default instead of creating a language nobody has
         * questions for.
         */
        ":lang": SUPPORTED_LANGUAGES.includes(String(msg.lang ?? ""))
          ? String(msg.lang)
          : DEFAULT_LANGUAGE,
      },
    })
  );

  /*
   * The conversation so far.
   *
   * This sent an EMPTY list under a comment saying no history was persisted.
   * That was true when it was written and stopped being true the moment
   * chatlog.mjs landed — the table has 61 rows and nothing had ever read one.
   *
   * The bug that hid behind it is worse than a missing feature. The client
   * REPLACES its chat list on this message, and a reconnect is a fresh join,
   * so every dropped connection wiped the chat for whoever came back. A
   * serverless socket reconnects on any blip, which made it common rather
   * than rare.
   */
  await postTo(event, connectionId, {
    type: "chat_history",
    messages: await loadChatHistory(canonicalId),
  });

  /*
   * The row we just wrote is handed to the broadcast rather than left to be
   * rediscovered. connectionsInLobby reads a GSI, GSIs are eventually
   * consistent, and this is the microsecond after the write — so without this
   * the joiner is missing from their own join: absent from the presence list
   * everyone else receives, and absent from the fan-out that would have told
   * them who is here. See presence.mjs.
   */
  await broadcastLobbyState(event, canonicalId, {
    connectionId,
    username,
    displayName,
    avatar: profile.avatar,
    streak: profile.streak,
    joinedAt: Date.now(),
    lobbyId: canonicalId,
  });

  // RESYNC — a socket joining mid-match is caught up on the spot. Every
  // deadline in the state is absolute, so the phase message below carries the
  // REMAINING time rather than the original duration: a client that reloads
  // two seconds into a five-second spin is told 3000ms, lands mid-animation
  // and stays in step. This is what room.ts's resyncSocket() did from memory,
  // except the memory now survives the process.
  const running = await readGameState(canonicalId);
  if (running && running.phase !== "gameover") {
    /*
     * SPECTATING. The resync above is already everything a spectator needs —
     * the same live state a player gets, with the remaining time on the
     * current phase. What they also need is to be TOLD, on the first message
     * rather than by inferring it from their own absence: a socket that
     * joined after the host started is not in `players` and never will be
     * until the next match reseats from the roster.
     *
     * Sent only on this per-socket push. The broadcast form of `game_state`
     * goes to the whole lobby and cannot carry a per-viewer answer, so the
     * client keeps deriving its own status from the roster after this — this
     * flag is the opening statement, not the running one.
     */
    const spectating = !(running.players ?? []).some(
      (p) => p.username === username
    );

    /*
     * SPECTATING IS THE HOST'S CHOICE. A room created with it off refuses
     * latecomers outright rather than seating them as silent watchers — the
     * socket is closed off with join_denied, the same way a full room or a
     * wrong password is, so the client already knows how to render it.
     *
     * Absent means allowed: every room created before the toggle existed was
     * watchable, and flipping them closed on deploy would be a change nobody
     * asked for.
     */
    if (spectating && lobby.spectateEnabled === false) {
      await postTo(event, connectionId, {
        type: "join_denied",
        reason: "spectating_disabled",
      });
      return;
    }
    await postTo(event, connectionId, {
      type: "game_state",
      state: publicGameState(running),
      spectating,
    });
    const pm = phaseMessage(running);
    if (pm) await postTo(event, connectionId, pm);
    if (spectating) {
      await postTo(event, connectionId, {
        type: "spectating",
        lobbyId: canonicalId,
        message: "The match is already running — you are watching it.",
      });
    }
  }
  if (isNew) {
    await systemChat(event, canonicalId, `${displayName} joined the room`, "joined");
  }
}

export {
  onJoin,
};
