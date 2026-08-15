/**
 * ===========================================================================
 * ipakseokrece — WebSocket Lambda  (Phase 0: connect · join · presence · chat)
 * ===========================================================================
 * ONE function behind an API Gateway **WebSocket** API, wired to all three
 * routes ($connect / $disconnect / $default). It is deliberately separate from
 * the REST function in `lambda/` — different event shape, different response
 * contract, different IAM.
 *
 * Zero dependencies: everything imported here ships inside the Lambda Node.js
 * runtime (AWS SDK v3) or is built into Node (node:crypto, global fetch).
 * Paste it and it runs.
 *
 * ┌── WHAT THIS DOES, AND WHAT IT DOES NOT ─────────────────────────────────┐
 * │ DOES:     connect/disconnect bookkeeping, authenticated `join`, live    │
 * │           lobby presence (`lobby_state`), `chat`, `leave`, `ping`.      │
 * │ DOES NOT: the turn engine. `start_game`, `submit_answer`, `place_bet`,  │
 * │           `pick_player`, `submit_guess`, `submit_code`, `play_again`,   │
 * │           `kick_player`, `terminate_lobby` all answer                   │
 * │           { type: "not_implemented" } — on purpose, so the plumbing is  │
 * │           provable end-to-end before any of that is written.            │
 * │           Why: docs/websocket-game-later.md — the phases are driven by  │
 * │           in-process setTimeout()s, which a Lambda cannot hold. That    │
 * │           needs Step Functions (or EventBridge Scheduler) and a room    │
 * │           item written with a version + conditional update. Phase 1+.   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ── ENVIRONMENT VARIABLES ─────────────────────────────────────────────────
 *   CONNECTIONS_TABLE        Connections          (this file's own table)
 *   CONNECTIONS_LOBBY_INDEX  lobby-index          (GSI, partition key lobbyId)
 *   LOBBIES_TABLE            Lobbies              (shared with REST)
 *   WALLETS_TABLE            Wallets              (shared with REST; optional —
 *                                                  only hydrates avatar+streak)
 *   COGNITO_USER_POOL_ID     eu-west-3_Uylh5ZFUK
 *   COGNITO_CLIENT_ID        3j69q67dfk60kl92gukqhdlr91
 *   COGNITO_REGION           defaults to the function's region
 *   CONNECTION_TTL_SECONDS   7200   (safety net for rows the $disconnect missed)
 *   All have working defaults. Do NOT set AWS_REGION — it is reserved.
 *
 * ── IAM ───────────────────────────────────────────────────────────────────
 *   Attach lambda-ws/iam-policy.json. Three things it must have that the REST
 *   role does not:
 *     execute-api:ManageConnections on  <ws-api-id>/<stage>/POST/@connections/*
 *     dynamodb R/W                 on  table/Connections
 *     dynamodb:Query               on  table/Connections/index/lobby-index
 *   It also needs GetItem on Lobbies and Query on Lobbies/index/code-index,
 *   which the REST policy does not currently grant.
 *
 * ── HOW TO ATTACH ─────────────────────────────────────────────────────────
 *   API Gateway → WebSocket API → route selection expression  $request.body.type
 *   Attach this ONE function as a Lambda (proxy) integration to ALL THREE of
 *   $connect, $disconnect and $default, then deploy to stage `prod`.
 *   Full click-by-click walkthrough: lambda-ws/README.md
 *
 * ── FRONTEND (one required change — see README) ────────────────────────────
 *   The lobby id currently rides on the socket PATH (`wss://host/game/<id>`).
 *   API Gateway WebSocket APIs have no path routing, so it must move into the
 *   `join` message body: { type: "join", token, lobbyId, displayName }.
 *
 * Ported from: handleGameConnection() in src/server/game/manager.ts and the
 * presence/chat half of GameRoom in src/server/game/room.ts.
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || "Connections";
const LOBBY_INDEX = process.env.CONNECTIONS_LOBBY_INDEX || "lobby-index";
const LOBBIES_TABLE = process.env.LOBBIES_TABLE || "Lobbies";
const WALLETS_TABLE = process.env.WALLETS_TABLE || "Wallets";
const CONNECTION_TTL_SECONDS = Number(process.env.CONNECTION_TTL_SECONDS || 7200);

// clients at module scope so warm invocations reuse the connections
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── game constants (mirrors src/server/game/room.ts) ──────────────────────
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const STARTING_MONEY = 500;
const CHAT_MAX_LENGTH = 300;
const CHAT_MIN_INTERVAL_MS = 500;

/** the 9 socket actions that belong to the turn engine — Phase 1+ */
const TURN_ENGINE_ACTIONS = new Set([
  "start_game",
  "submit_answer",
  "place_bet",
  "pick_player",
  "submit_guess",
  "submit_code",
  "play_again",
  "kick_player",
  "terminate_lobby",
]);

// ─── Cognito access-token verification (no dependencies) ───────────────────
// Copied verbatim from lambda/wallet.mjs. If you change it, change it there
// too — or better, move both to the single Lambda authorizer described in
// lambda/README.md.
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "eu-west-3_Uylh5ZFUK";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "3j69q67dfk60kl92gukqhdlr91";
const COGNITO_REGION = process.env.COGNITO_REGION || REGION;
const ISSUER = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/${USER_POOL_ID}`;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

let jwksCache = null;
let jwksFetchedAt = 0;
const JWKS_MIN_REFETCH_MS = 60_000; // don't hammer Cognito on an unknown kid

async function publicKeyForKid(kid) {
  const stale = !jwksCache || !jwksCache[kid];
  if (stale && Date.now() - jwksFetchedAt > JWKS_MIN_REFETCH_MS) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const { keys } = await res.json();
    jwksCache = Object.fromEntries(keys.map((k) => [k.kid, k]));
    jwksFetchedAt = Date.now();
  }
  const jwk = jwksCache?.[kid];
  if (!jwk) return null;
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * Verifies a Cognito ACCESS token and returns { username, sub }, or null when
 * it is missing, malformed, expired, signed by someone else, or issued for
 * another app client. Mirrors identityFromToken() in the Express server.
 */
async function identityFromToken(token) {
  if (!token) return null;
  try {
    const [rawHeader, rawPayload, rawSignature] = token.split(".");
    if (!rawHeader || !rawPayload || !rawSignature) return null;

    const header = JSON.parse(Buffer.from(rawHeader, "base64url").toString());
    // pinning RS256 is what stops an "alg":"none" or HMAC-confusion token
    if (header.alg !== "RS256" || !header.kid) return null;

    const key = await publicKeyForKid(header.kid);
    if (!key) return null;

    const signatureValid = crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${rawHeader}.${rawPayload}`),
      key,
      Buffer.from(rawSignature, "base64url")
    );
    if (!signatureValid) return null;

    const payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString());
    // an id token must not be accepted where an access token is required
    if (payload.token_use !== "access") return null;
    if (payload.iss !== ISSUER) return null;
    if (payload.client_id !== CLIENT_ID) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
      return null;
    }

    const username = payload.username ?? payload.sub;
    if (!username) return null;
    return { username: String(username), sub: String(payload.sub) };
  } catch {
    // malformed base64/JSON, bad key, anything else — all mean "no"
    return null;
  }
}

// ─── private-room passwords: scrypt, not bcrypt ────────────────────────────
// Same story as lambda/joinRoom.mjs — bcrypt is a native module and cannot be
// pasted into the console, so rooms created by the Lambda REST stack carry a
// scrypt hash. A room created by the old Express server carries a bcrypt hash
// that is unverifiable here; that case is reported honestly rather than as a
// wrong password. Format: scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;

/** returns true/false, or throws BcryptHashError for a legacy bcrypt hash */
function scryptVerify(password, stored) {
  if (typeof stored !== "string" || !stored) return false;
  if (stored.startsWith("$2")) {
    const err = new Error("legacy bcrypt hash");
    err.name = "BcryptHashError";
    throw err;
  }
  const [tag, n, r, p, saltB64, keyB64] = stored.split("$");
  if (tag !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = crypto.scryptSync(
    password,
    Buffer.from(saltB64, "base64"),
    expected.length,
    { N: Number(n) || SCRYPT_N, r: Number(r) || SCRYPT_R, p: Number(p) || SCRYPT_P }
  );
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ─── outbound: ApiGatewayManagementApi ─────────────────────────────────────
// The management endpoint is per-API-and-stage and arrives on every event, so
// it is derived from the event rather than configured. Cached per endpoint so
// a warm container reuses the HTTP connection.
const managementClients = new Map();

function managementClientFor(event) {
  const { domainName, stage } = event.requestContext;
  // a custom domain already carries its own base path; the default
  // execute-api domain needs the stage appended
  const endpoint = `https://${domainName}/${stage}`;
  let client = managementClients.get(endpoint);
  if (!client) {
    client = new ApiGatewayManagementApiClient({ region: REGION, endpoint });
    managementClients.set(endpoint, client);
  }
  return client;
}

function isGone(err) {
  return (
    err?.name === "GoneException" || err?.$metadata?.httpStatusCode === 410
  );
}

/**
 * Send one message to one connection. A 410 means the client is long gone and
 * API Gateway has already forgotten it — reap the row so presence stops
 * counting a ghost. Returns false when the connection was dropped.
 */
async function postTo(event, connectionId, message) {
  try {
    await managementClientFor(event).send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      })
    );
    return true;
  } catch (err) {
    if (isGone(err)) {
      await deleteConnection(connectionId).catch(() => {});
      return false;
    }
    // one bad socket must not fail the whole broadcast
    console.error("postToConnection failed", connectionId, err);
    return false;
  }
}

// ─── the Connections table ─────────────────────────────────────────────────
function ttlFromNow() {
  return Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS;
}

async function getConnection(connectionId) {
  const res = await ddb.send(
    new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
  return res.Item ?? null;
}

async function deleteConnection(connectionId) {
  await ddb.send(
    new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
}

/**
 * Every live connection in one lobby, via the lobby-index GSI.
 *
 * Attribute names go through ExpressionAttributeNames throughout this file —
 * DynamoDB's reserved-word list is long and unmemorable, and a collision is a
 * runtime ValidationException, not something the console catches at paste time.
 */
async function connectionsInLobby(lobbyId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: LOBBY_INDEX,
      KeyConditionExpression: "#lobbyId = :lobbyId",
      ExpressionAttributeNames: { "#lobbyId": "lobbyId" },
      ExpressionAttributeValues: { ":lobbyId": lobbyId },
    })
  );
  return res.Items ?? [];
}

/** fan out to a whole lobby, skipping one connection if asked */
async function broadcast(event, lobbyId, message, exceptConnectionId = null) {
  const rows = await connectionsInLobby(lobbyId);
  await Promise.all(
    rows
      .filter((r) => r.connectionId !== exceptConnectionId)
      .map((r) => postTo(event, r.connectionId, message))
  );
}

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
      new GetCommand({ TableName: WALLETS_TABLE, Key: { username } })
    );
    return {
      streak: Number(res.Item?.currentStreak ?? 0),
      avatar: res.Item?.avatar ?? null,
    };
  } catch {
    return { streak: 0, avatar: null };
  }
}

// ─── presence ──────────────────────────────────────────────────────────────
/**
 * The `lobby_state` the frontend renders, rebuilt from durable state on every
 * change. Two sources, merged the way GameRoom merges them in memory:
 *
 *   Lobbies.players  — the seat roster and who is Admin (host)
 *   Connections      — who is actually holding a socket right now
 *
 * A connected player who is not on the roster is still shown: in `lobby` phase
 * GameRoom.addPlayer() seats them rather than making them a spectator, and
 * Phase 0 is always in `lobby` phase because there is no turn engine yet.
 */
async function lobbyStateMessage(lobby, lobbyId) {
  const live = await connectionsInLobby(lobbyId);
  const byUsername = new Map();
  for (const row of live) {
    if (!row.username) continue; // connected but not yet joined
    const existing = byUsername.get(row.username);
    // a reconnect can briefly leave two rows; the newest wins
    if (!existing || (row.joinedAt ?? 0) > (existing.joinedAt ?? 0)) {
      byUsername.set(row.username, row);
    }
  }

  const roster = Array.isArray(lobby?.players) ? lobby.players : [];
  const seen = new Set();
  const players = [];

  for (const seat of roster) {
    const username = String(seat.player);
    if (seen.has(username)) continue;
    seen.add(username);
    const conn = byUsername.get(username);
    players.push({
      username,
      displayName: conn?.displayName || username,
      avatar: conn?.avatar ?? null,
      money: Number(seat.points ?? STARTING_MONEY),
      alive: true, // phase is always "lobby" in Phase 0
      connected: Boolean(conn),
      isHost: seat.role === "Admin",
      streak: Number(conn?.streak ?? 0),
      isSpectator: false,
    });
  }

  // connected but not on the roster (joined the socket without the REST join)
  for (const [username, conn] of byUsername) {
    if (seen.has(username)) continue;
    players.push({
      username,
      displayName: conn.displayName || username,
      avatar: conn.avatar ?? null,
      money: STARTING_MONEY,
      alive: true,
      connected: true,
      isHost: false,
      streak: Number(conn.streak ?? 0),
      isSpectator: false,
    });
  }

  // mirrors reassignHost(): if the Admin is not here, the longest-present
  // connected player holds the start button so the lobby is not stuck
  if (!players.some((p) => p.isHost && p.connected)) {
    const stand_in = players
      .filter((p) => p.connected)
      .sort(
        (a, b) =>
          (byUsername.get(a.username)?.joinedAt ?? 0) -
          (byUsername.get(b.username)?.joinedAt ?? 0)
      )[0];
    if (stand_in) stand_in.isHost = true;
  }

  return {
    type: "lobby_state",
    phase: "lobby",
    roomName: lobby?.roomName ?? `Room ${lobby?.code ?? ""}`.trim(),
    code: Number(lobby?.code ?? 0),
    isPrivate: Boolean(lobby?.isPrivate),
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    round: 0,
    players,
  };
}

/** rebuild presence and push it to everyone still in the lobby */
async function broadcastLobbyState(event, lobbyId) {
  const lobby = await resolveLobby(lobbyId);
  const message = await lobbyStateMessage(lobby, lobbyId);
  await broadcast(event, lobbyId, message);
}

/** the system-voice chat line GameRoom.systemChat() writes */
async function systemChat(event, lobbyId, text) {
  await broadcast(event, lobbyId, {
    type: "chat_message",
    username: null,
    text,
    at: Date.now(),
  });
}

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
 */
async function onDisconnect(event) {
  const connectionId = event.requestContext.connectionId;
  const row = await getConnection(connectionId).catch(() => null);
  await deleteConnection(connectionId).catch((err) =>
    console.error("failed to delete connection row", connectionId, err)
  );

  if (row?.lobbyId) {
    try {
      // in `lobby` phase the Express server drops the player outright rather
      // than holding a seat, and says so in chat
      if (row.username) {
        await systemChat(
          event,
          row.lobbyId,
          `${row.displayName || row.username} left the room`
        );
      }
      await broadcastLobbyState(event, row.lobbyId);
    } catch (err) {
      console.error("disconnect broadcast failed", err);
    }
  }
  return { statusCode: 200, body: "Disconnected" };
}

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
  if (!onRoster && roster.length >= MAX_PLAYERS) {
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
  if (isNew) {
    await systemChat(event, canonicalId, `${displayName} joined the room`);
  }
}

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
}

/**
 * leave — presence only, so it belongs to Phase 0 even though the Express
 * version also removes the player from the running match. The client sends
 * this and then closes the socket; doing it here means the rest of the lobby
 * sees them go immediately rather than waiting for $disconnect.
 */
async function onLeave(event, connectionId, row) {
  if (!row?.lobbyId) return;
  const lobbyId = row.lobbyId;
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
  if (row.username) {
    await systemChat(
      event,
      lobbyId,
      `${row.displayName || row.username} left the room`
    );
  }
  await broadcastLobbyState(event, lobbyId);
}

/**
 * $default — every message lands here. The API's route selection expression is
 * $request.body.type, but with only $connect/$disconnect/$default configured
 * there is nothing else for a typed message to match, which is what makes one
 * function enough.
 */
async function onDefault(event) {
  const connectionId = event.requestContext.connectionId;

  let msg;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    msg = JSON.parse(raw);
  } catch {
    await postTo(event, connectionId, {
      type: "error",
      message: "Invalid JSON message",
    });
    return { statusCode: 200, body: "" };
  }

  const type = String(msg?.type ?? "");
  const row = await getConnection(connectionId);

  switch (type) {
    case "join":
      await onJoin(event, connectionId, msg, row);
      break;
    case "chat":
      await onChat(event, connectionId, msg, row);
      break;
    case "leave":
      await onLeave(event, connectionId, row);
      break;
    case "ping":
      // plumbing check: works before `join`, and echoes anything sent with it
      await postTo(event, connectionId, {
        type: "pong",
        at: Date.now(),
        connectionId,
        echo: msg.echo ?? null,
        joined: Boolean(row?.username),
        lobbyId: row?.lobbyId ?? null,
      });
      break;
    default:
      if (TURN_ENGINE_ACTIONS.has(type)) {
        await postTo(event, connectionId, {
          type: "not_implemented",
          action: type,
          message:
            `"${type}" is part of the turn engine, which does not run on ` +
            "Lambda yet. Phase 0 covers connect, join, presence and chat. " +
            "See docs/websocket-game-later.md.",
        });
      } else {
        await postTo(event, connectionId, {
          type: "error",
          message: `Unknown message type: ${type || "(none)"}`,
        });
      }
  }
  return { statusCode: 200, body: "" };
}

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  const routeKey = event.requestContext?.routeKey;
  try {
    switch (routeKey) {
      case "$connect":
        return await onConnect(event);
      case "$disconnect":
        return await onDisconnect(event);
      case "$default":
        return await onDefault(event);
      default:
        console.error("unexpected routeKey", routeKey);
        return { statusCode: 400, body: "Unknown route" };
    }
  } catch (err) {
    console.error(`${routeKey} failed`, err);
    // a thrown error on $connect refuses the socket, which is right; on
    // $default the socket should survive one bad message
    if (routeKey === "$default") {
      await postTo(event, event.requestContext.connectionId, {
        type: "error",
        message: "Internal server error",
      }).catch(() => {});
      return { statusCode: 200, body: "" };
    }
    return { statusCode: 500, body: "Internal server error" };
  }
};
