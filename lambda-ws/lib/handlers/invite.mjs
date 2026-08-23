/**
 * ===========================================================================
 * lib/handlers/invite.mjs — ask a friend into the room you are sitting in
 * ===========================================================================
 * Two actions, and the first exists only so the second can work.
 *
 * ── WHY `hello` ────────────────────────────────────────────────────────────
 * A socket only ever had one way to say who it was: `join`, which also puts
 * you in a lobby. So outside a game the app held NO connection, and there was
 * nothing to push an invite to — an invite would have reached only friends
 * already sitting in some other room, which is close to nobody.
 *
 * `hello` is `join` minus the lobby: verify the token, write the username onto
 * the Connections row, leave `lobbyId` absent. That shape is already
 * meaningful — friendsList reads a Connections row with no lobbyId as
 * "online", and until now essentially nothing ever produced one, which is why
 * a friend browsing the app has always read as offline.
 *
 * ── WHY THE SENDER'S LOBBY IS NOT IN THE MESSAGE ───────────────────────────
 * `invite_friend` carries a target and NOTHING else. The room is read from the
 * sender's own Connections row, the same row `join` wrote, so a client cannot
 * invite people into a room it is not in by naming one. The rule is the same
 * one `join` follows for identity: what the client claims is not evidence.
 *
 * ── FINDING THE TARGET'S SOCKETS ───────────────────────────────────────────
 * By Scan. Connections is keyed by connectionId with a lobby-index GSI and no
 * username index, and the table holds one row per LIVE socket under a 2h TTL —
 * so it is tens of items, not millions. lambda/friendsList.mjs already scans it
 * for exactly this reason and says so; this is that same read.
 *
 * ── OFFLINE IS A REFUSAL, NOT A QUEUE ──────────────────────────────────────
 * No live socket means `invite_failed { reason: "offline" }` and nothing is
 * stored. A durable invite belongs with the notification feed — a table, an
 * unread count, a way to read it later — and half of that (a write with no
 * reader) would be worse than the honest refusal.
 * ===========================================================================
 */

import { ScanCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { identityFromToken } from "../auth.mjs";
import { ddb } from "../aws.mjs";
import { CONNECTIONS_TABLE, PLAYERS_TABLE } from "../config.mjs";
import { postTo, ttlFromNow } from "../connections.mjs";
import { resolveLobby } from "../lobbies.mjs";

/**
 * hello — authenticate a socket that is not in a room.
 *
 * Idempotent: the app sends it on every connect and reconnect, and re-writing
 * the same username with a fresh TTL is the whole intent.
 */
async function onHello(event, connectionId, msg) {
  const identity = await identityFromToken(msg?.token);
  if (!identity) {
    await postTo(event, connectionId, {
      type: "hello_denied",
      reason: "unauthenticated",
    });
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId },
      UpdateExpression: "SET #u = :u, #e = :e",
      ExpressionAttributeNames: { "#u": "username", "#e": "expiresAt" },
      ExpressionAttributeValues: {
        ":u": identity.username,
        ":e": ttlFromNow(),
      },
    })
  );

  await postTo(event, connectionId, {
    type: "hello_ok",
    username: identity.username,
  });
}

/** every live socket belonging to one player */
async function connectionsForUser(username) {
  const res = await ddb.send(
    new ScanCommand({
      TableName: CONNECTIONS_TABLE,
      FilterExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "username" },
      ExpressionAttributeValues: { ":u": username },
      ProjectionExpression: "connectionId, lobbyId",
    })
  );
  return res.Items ?? [];
}

const fail = (event, connectionId, reason, target = null) =>
  postTo(event, connectionId, { type: "invite_failed", reason, target });

/**
 * invite_friend — push an invite to a friend's live sockets.
 *
 * The checks are ordered cheapest-first and each one is a distinct `reason`,
 * so the sender's UI can say what actually happened rather than "failed".
 */
async function onInviteFriend(event, connectionId, row, msg) {
  const from = row?.username;
  const lobbyId = row?.lobbyId;

  // the sender must be a joined socket sitting in a room
  if (!from || !lobbyId) {
    await fail(event, connectionId, "not-in-room");
    return;
  }

  const target = String(msg?.target ?? "").trim();
  if (!target) {
    await fail(event, connectionId, "no-target");
    return;
  }
  if (target === from) {
    await fail(event, connectionId, "self", target);
    return;
  }

  // friendship is read from the SENDER's record: you may only invite someone
  // who has already accepted you
  const me = await ddb.send(
    new GetCommand({ TableName: PLAYERS_TABLE, Key: { username: from } })
  );
  const friends = Array.isArray(me.Item?.friends) ? me.Item.friends : [];
  if (!friends.includes(target)) {
    await fail(event, connectionId, "not-friend", target);
    return;
  }

  const lobby = await resolveLobby(lobbyId);
  if (!lobby) {
    await fail(event, connectionId, "room-gone", target);
    return;
  }

  // already at this table — seated or watching
  const here = Array.isArray(lobby.players) ? lobby.players : [];
  if (here.some((p) => (typeof p === "string" ? p : p?.username) === target)) {
    await fail(event, connectionId, "already-here", target);
    return;
  }

  const sockets = await connectionsForUser(target);
  if (sockets.length === 0) {
    // no live socket: nothing to push to, and nothing is queued — see header
    await fail(event, connectionId, "offline", target);
    return;
  }

  /*
   * The invite carries what the banner needs to be worth reading — who is
   * asking and which room — plus the lobbyId the accept navigates to. It does
   * NOT carry the room password: a private room is entered through the invite
   * itself, and a password sent over a socket to be echoed back is a password
   * handed out.
   */
  const invite = {
    type: "room_invite",
    lobbyId: String(lobbyId),
    code: lobby.code ?? null,
    roomName: lobby.roomName ?? "",
    isPrivate: Boolean(lobby.isPrivate),
    from,
    fromName: row?.displayName ?? from,
    at: Date.now(),
  };

  await Promise.all(
    sockets.map((s) => postTo(event, s.connectionId, invite))
  );

  await postTo(event, connectionId, {
    type: "invite_sent",
    target,
    sockets: sockets.length,
  });
}

export { onHello, onInviteFriend };
