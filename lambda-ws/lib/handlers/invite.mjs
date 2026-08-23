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
 * ── OFFLINE IS NO LONGER A REFUSAL ─────────────────────────────────────────
 * It used to be: no live socket meant `invite_failed: "offline"` and nothing
 * was stored, because a write with no reader is worse than an honest no.
 *
 * The Notifications table is that reader. So the invite now goes through
 * notify(), which writes the durable row and pushes to whatever sockets exist
 * — and there is no branch on presence at all. A friend who is reading the
 * site gets the banner; a friend who is away finds the invite in their bell
 * when they come back. The sender is told which of the two happened, because
 * "they will see it later" and "they are looking at it now" are different
 * things to know.
 * ===========================================================================
 */

import { ScanCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { identityFromToken } from "../auth.mjs";
import { ddb } from "../aws.mjs";
import { CONNECTIONS_TABLE, PLAYERS_TABLE, capacityOf } from "../config.mjs";
import { postTo, ttlFromNow } from "../connections.mjs";
import { resolveLobby } from "../lobbies.mjs";
import { notify } from "../notify.mjs";

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

  /*
   * A full room cannot be invited into.
   *
   * The button is disabled once the seats are taken, but a disabled button is
   * a courtesy and not a rule: two people can press invite in the same second
   * on the last free seat, and an invite that arrives at a room with nowhere
   * to sit is a notification whose only outcome is join_denied. Checked
   * against the room's OWN capacity via capacityOf, not a constant, because
   * rooms are created with two to eight seats.
   */
  if (here.length >= capacityOf(lobby)) {
    await fail(event, connectionId, "room-full", target);
    return;
  }

  /*
   * What the invite carries: enough for the banner and the bell row to be
   * worth reading, plus the lobbyId an accept navigates to.
   *
   * It does NOT carry the room password. A private room is entered through the
   * invite itself, and a password sent over a socket to be echoed back is a
   * password handed out.
   *
   * No display sentence is stored either — the client owns the wording, and a
   * translated string written into the table would be frozen in whichever
   * language the SENDER happened to be reading.
   */
  const data = {
    lobbyId: String(lobbyId),
    code: lobby.code ?? null,
    roomName: lobby.roomName ?? "",
    isPrivate: Boolean(lobby.isPrivate),
    from,
    fromName: row?.displayName ?? from,
  };

  const saved = await notify(event, {
    username: target,
    kind: "room_invite",
    data,
  });
  if (!saved) {
    await fail(event, connectionId, "generic", target);
    return;
  }

  /*
   * The banner is the LIVE half and is sent separately, because it is a
   * different thing from the bell row: it demands an answer now, where the row
   * waits to be read. A friend who is away simply does not get one.
   */
  const sockets = await connectionsForUser(target);
  await Promise.all(
    sockets.map((s) =>
      postTo(event, s.connectionId, { type: "room_invite", ...data, at: saved.at })
    )
  );

  await postTo(event, connectionId, {
    type: "invite_sent",
    target,
    // false means "it is in their notifications", not "it failed"
    live: sockets.length > 0,
  });
}

export { onHello, onInviteFriend };
