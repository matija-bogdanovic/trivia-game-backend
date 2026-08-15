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
 * │           lobby presence (`lobby_state`), `chat`, `leave`, `ping`,      │
 * │           and host-leaves-closes-the-room (`room_closed`).              │
 * │ ENFORCES: host-only actions — `start_game`, `kick_player` and           │
 * │           `terminate_lobby` are refused with reason "not_host" unless   │
 * │           the sender is the room's Admin. Server-side and permanent:    │
 * │           the gate stays in front of the turn engine in Phase 2.        │
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
 *   It also needs GetItem + DeleteItem on Lobbies and Query on
 *   Lobbies/index/code-index. DeleteItem is what lets a host closing the room
 *   actually delete it — without it the room_closed broadcast still goes out
 *   and the room silently survives.
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
const GAME_STATE_TABLE = process.env.GAME_STATE_TABLE || "GameState";
const LOBBY_INDEX = process.env.CONNECTIONS_LOBBY_INDEX || "lobby-index";
const LOBBIES_TABLE = process.env.LOBBIES_TABLE || "Lobbies";
const WALLETS_TABLE = process.env.WALLETS_TABLE || "Wallets";
const CONNECTION_TTL_SECONDS = Number(process.env.CONNECTION_TTL_SECONDS || 7200);

// clients at module scope so warm invocations reuse the connections.
// removeUndefinedValues: the game state has genuinely optional branches (turn,
// duel, currentPick) and an undefined would otherwise fail the whole write.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

// ─── game constants (mirrors src/server/game/room.ts) ──────────────────────
const MIN_PLAYERS = 2;
/** fallback capacity for rooms written before `maxPlayers` was a stored field */
const MAX_PLAYERS = 6;

/**
 * A room's seat count. Every capacity decision goes through here so the number
 * the client is shown in lobby_state and the number the seat cap enforces on
 * join can never drift apart.
 */
function capacityOf(lobby) {
  const n = Math.floor(Number(lobby?.maxPlayers));
  return Number.isFinite(n) && n > 0 ? n : MAX_PLAYERS;
}
const STARTING_MONEY = 500;
const CHAT_MAX_LENGTH = 300;
const CHAT_MIN_INTERVAL_MS = 500;
const CHAT_HISTORY_LIMIT = 50;

// ─── phase clocks, ported verbatim from src/server/game/room.ts ─────────────
// Every one becomes an ABSOLUTE `phaseEndsAt` in the stored state rather than
// a setTimeout, because a Lambda that has returned cannot hold a timer. P2.1
// points a scheduler at that timestamp.
const COUNTDOWN_MS = 3000;      // room.ts ticks 3,2,1,0 then spins at t=3s
const SPIN_TIME_MS = 5000;
const BASE_QUESTION_TIME_MS = 15000;
const MIN_QUESTION_TIME_MS = 8000;
const BETTING_TIME_MS = 4500;   // room.ts has NO endsAt for this one — we do
const REVEAL_MS = 5000;
const PICK_TIME_MS = 15000;
const DUEL_TIME_MS = 20000;
const CODE_DUEL_TIME_MS = 90000;

/** a question's clock shrinks as the chain deepens (room.ts askQuestion) */
function questionTimeFor(chainDepth) {
  return Math.max(MIN_QUESTION_TIME_MS, BASE_QUESTION_TIME_MS - chainDepth * 1000);
}

// ─── P2 design constants (state is seeded now, logic lands in later steps) ──
/**
 * SPIN WEIGHTS — the decaying model Matija locked in, replacing room.ts's
 * single `lastSpinTarget` flag (which only dampened the immediately previous
 * target, to a flat 0.4, with no memory).
 *
 * Every player carries `spinWeight`, persisted in the state. On each spin:
 *   picked player      weight = max(MIN, weight * PICKED_DECAY)
 *   everyone else      weight = min(MAX, weight * RECOVERY)
 * then a weighted draw over the living players. The clamp at MIN is what
 * keeps a re-pick possible rather than impossible; the clamp at MAX stops a
 * long-ignored player becoming a certainty. Seeded equal at start_game.
 */
const SPIN_WEIGHT_INITIAL = 1.0;
const SPIN_WEIGHT_MIN = 0.15;
const SPIN_WEIGHT_MAX = 2.5;
const SPIN_WEIGHT_PICKED_DECAY = 0.35;
const SPIN_WEIGHT_RECOVERY = 1.25;

/**
 * QUOTA — betting odds derived from the target's IN-MATCH accuracy, which is
 * why every player carries `stats.correct` / `stats.wrong`. room.ts counted
 * only wrong answers, so there was no denominator to compute this from.
 * Betting into a central `pot` and paying winners out of it is what conserves
 * money and makes elimination inevitable; there is no separate house edge.
 */
const QUOTA_MIN = 1.1;
const QUOTA_MAX = 2.0;

/** a stale match should not outlive the day it was played */
const STATE_TTL_SECONDS = 24 * 60 * 60;
/** how many times a version-conflicted write is retried before giving up */
const STATE_MAX_ATTEMPTS = 5;

/**
 * Turn-engine actions still awaiting P2.2+. `start_game` used to be the tenth
 * entry here; it is handled for real now (it seeds the match state), so it is
 * dispatched before this set is consulted.
 */
const TURN_ENGINE_ACTIONS = new Set([
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

// ═══════════════════════════════════════════════════════════════════════════
// GAME STATE — the P2.0 backbone
// ═══════════════════════════════════════════════════════════════════════════
//
// One item per lobby in the GameState table, PK `lobbyId`, holding everything
// GameRoom kept in memory. The shape below is ported field-for-field from
// src/server/game/room.ts, with the P2 additions Matija locked in marked NEW.
//
//   lobbyId        S   partition key, the same id used everywhere else
//   version        N   optimistic lock — every write asserts the value it read
//   matchId        S   fresh per start_game, not per lobby (room.ts matchId)
//   phase          S   lobby|countdown|spin|question|betting|reveal|
//                      picking|duel|gameover  (the 9 from types.ts GamePhase)
//   phaseEndsAt    N   NEW absolute epoch ms. room.ts used setTimeout, which a
//                      Lambda cannot hold; this is what P2.1's scheduler fires
//                      on, and it is why every phase now has a real deadline —
//                      including `betting`, which room.ts never gave one.
//   round          N   rounds elapsed
//   chainDepth     N   drives difficulty (1 + floor(depth/2)) and the clock
//   pot            N   NEW central pot. Stakes go in, winners are paid out of
//                      it, scaled down if it cannot cover — money conserved.
//   players[]          username, displayName, avatar, money, alive, connected,
//                      isHost, isSpectator, streak,
//                      spinWeight  NEW per-player decaying selection weight
//                      stats { correct NEW, wrong, betsWon, maxBetWin,
//                              roundsPlayed }  — correct/wrong feed the quota
//   lastSpinTarget S   kept for continuity; spinWeight supersedes it
//   turn               { answering, question{...}, askedAt, answerTimeMs,
//                        answer, answeredInMs } — `answer` is the submitted
//                        answer, held hidden until reveal exactly as room.ts
//                        does during the betting pause
//   bets[]             NEW { username, side: correct|wrong, amount, quota }
//                      — a list, not a Map, because Maps do not serialise
//   duel               { kind: guess|code, players[2], endsAt, question,
//                        guesses{}, code[], attempts{} }
//   currentSpin        { target, endsAt }        for reconnect resync
//   currentPick        { picker, choices[], endsAt }
//   deck               { fresh[], used[] } question ids — populated in P2.2
//   chat[]             ring buffer, last CHAT_HISTORY_LIMIT entries
//   startedAt/updatedAt N
//   expiresAt      N   TTL, 24h
//
// Nothing here runs the game yet. P2.0 proves the state exists, round-trips,
// and cannot be corrupted by two writers.

function nowMs() { return Date.now(); }
function ttlFrom(now) { return Math.floor(now / 1000) + STATE_TTL_SECONDS; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fresh match, seeded from the Lobbies roster.
 *
 * Only players who are BOTH on the roster and currently holding a socket are
 * seated — room.ts does the same thing ("only players present at the start
 * participate") by deleting disconnected players in startGame().
 */
function initialGameState(lobby, lobbyId, connRows) {
  const now = nowMs();
  const live = new Map();
  for (const c of connRows) if (c.username) live.set(c.username, c);

  const roster = Array.isArray(lobby?.players) ? lobby.players : [];
  const players = roster
    .filter((seat) => live.has(String(seat.player)))
    .map((seat) => {
      const username = String(seat.player);
      const conn = live.get(username);
      return {
        username,
        displayName: conn?.displayName || username,
        avatar: conn?.avatar ?? null,
        money: STARTING_MONEY,
        alive: true,
        connected: true,
        isHost: seat.role === "Admin",
        isSpectator: false,
        streak: Number(conn?.streak ?? 0),
        // NEW — equal at the start, diverges from the first spin onward
        spinWeight: SPIN_WEIGHT_INITIAL,
        // `correct` is the counter room.ts never kept; without it there is no
        // denominator for an accuracy-derived quota
        stats: { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 },
      };
    });

  return {
    lobbyId,
    version: 0,
    matchId: crypto.randomUUID(),
    code: Number(lobby?.code ?? 0),
    roomName: lobby?.roomName ?? `Room ${lobby?.code ?? ""}`.trim(),
    maxPlayers: capacityOf(lobby),
    minPlayers: MIN_PLAYERS,

    phase: "countdown",
    phaseEndsAt: now + COUNTDOWN_MS,
    round: 0,
    chainDepth: 0,
    pot: 0,

    players,
    lastSpinTarget: null,

    turn: null,
    bets: [],
    duel: null,
    currentSpin: null,
    currentPick: null,
    deck: { fresh: [], used: [] },
    chat: [],

    startedAt: now,
    updatedAt: now,
    expiresAt: ttlFrom(now),
  };
}

/** what goes over the wire — secrets stripped, never the raw item */
function publicGameState(s) {
  return {
    lobbyId: s.lobbyId,
    version: s.version,
    matchId: s.matchId,
    phase: s.phase,
    phaseEndsAt: s.phaseEndsAt,
    round: s.round,
    chainDepth: s.chainDepth,
    pot: s.pot,
    code: s.code,
    roomName: s.roomName,
    minPlayers: s.minPlayers,
    maxPlayers: s.maxPlayers,
    players: (s.players ?? []).map((p) => ({
      username: p.username,
      displayName: p.displayName,
      avatar: p.avatar,
      money: p.money,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      isSpectator: p.isSpectator,
      streak: p.streak,
      spinWeight: p.spinWeight,
      stats: p.stats,
    })),
    // the submitted answer and the duel code stay server-side until reveal,
    // mirroring room.ts hiding `turn.answer` through the betting pause
    turn: s.turn
      ? {
          answering: s.turn.answering,
          question: s.turn.question
            ? {
                text: s.turn.question.text,
                options: s.turn.question.options,
                difficulty: s.turn.question.difficulty,
              }
            : null,
          askedAt: s.turn.askedAt,
          answerTimeMs: s.turn.answerTimeMs,
          hasAnswered: s.turn.answer !== null && s.turn.answer !== undefined,
        }
      : null,
    bets: (s.bets ?? []).map((b) => ({
      username: b.username,
      amount: b.amount,
      quota: b.quota,
    })),
    duel: s.duel
      ? { kind: s.duel.kind, players: s.duel.players, endsAt: s.duel.endsAt }
      : null,
    currentSpin: s.currentSpin,
    currentPick: s.currentPick,
  };
}

async function readGameState(lobbyId) {
  const res = await ddb.send(
    new GetCommand({ TableName: GAME_STATE_TABLE, Key: { lobbyId } })
  );
  return res.Item ?? null;
}

/** create-once. Two simultaneous start_game calls: exactly one wins. */
async function createGameState(state) {
  await ddb.send(
    new PutCommand({
      TableName: GAME_STATE_TABLE,
      Item: state,
      ConditionExpression: "attribute_not_exists(lobbyId)",
    })
  );
  return state;
}

/**
 * THE CONCURRENCY BACKBONE — read → modify → conditional write on `version`.
 *
 * Six players can act in the same instant and each acts through its own
 * Lambda, so "read the room, change a field, write it back" is a lost-update
 * race by default. Every write here asserts that `version` still holds the
 * value this invocation read; if another writer got in first the condition
 * fails, and we re-read and replay the mutation against the NEW state rather
 * than clobbering it. That is what turns each field mutation in room.ts into
 * something safe to run twelve times concurrently.
 *
 * `mutate(state)` receives a private copy and returns the next state, or null
 * to abort without writing (used for "the rules say no" outcomes).
 *
 * Returns { ok, state, attempts } or { ok: false, reason }.
 */
async function mutateGameState(lobbyId, mutate) {
  for (let attempt = 1; attempt <= STATE_MAX_ATTEMPTS; attempt++) {
    const current = await readGameState(lobbyId);
    if (!current) return { ok: false, reason: "no_state" };

    const expected = Number(current.version ?? 0);
    const next = await mutate(structuredClone(current));
    if (!next) return { ok: false, reason: "aborted", state: current, attempts: attempt };

    next.version = expected + 1;
    next.updatedAt = nowMs();
    next.expiresAt = ttlFrom(next.updatedAt);

    try {
      await ddb.send(
        new PutCommand({
          TableName: GAME_STATE_TABLE,
          Item: next,
          ConditionExpression: "#v = :expected",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":expected": expected },
        })
      );
      return { ok: true, state: next, attempts: attempt };
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException") throw err;
      // somebody else wrote between our read and our write — jittered backoff
      // so six retrying writers do not synchronise into a thundering herd
      console.warn(
        `version conflict on ${lobbyId} (expected ${expected}), attempt ${attempt}`
      );
      await sleep(15 * attempt + Math.floor(Math.random() * 25));
    }
  }
  return { ok: false, reason: "contended" };
}

/** push the current state to everyone in the lobby */
async function broadcastGameState(event, lobbyId, state) {
  await broadcast(event, lobbyId, {
    type: "game_state",
    state: publicGameState(state),
  });
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

  // NO STAND-IN HOST. `isHost` above comes from the Lobbies roster and
  // nothing promotes a connected player on top of it, so this flag and
  // requireHost() read the same source and cannot disagree.
  //
  // There used to be a reassignHost fallback here that handed the flag to the
  // longest-present connected player whenever the Admin was away, so a lobby
  // was never left without a start button. Harmless while nothing enforced
  // host-ness — but once start_game became host-only it started rendering a
  // start button for someone the server then refused with not_host. It was
  // also volatile (the flag moved as sockets opened and closed) and could
  // report two isHost players at once. Showing no start button while the host
  // is away is the honest state: that is exactly who is allowed to press it.

  return {
    type: "lobby_state",
    phase: "lobby",
    roomName: lobby?.roomName ?? `Room ${lobby?.code ?? ""}`.trim(),
    code: Number(lobby?.code ?? 0),
    isPrivate: Boolean(lobby?.isPrivate),
    minPlayers: MIN_PLAYERS,
    // the room's own capacity, not the global cap. Rooms written before
    // maxPlayers existed fall back to 6, which is what they were created under.
    maxPlayers: capacityOf(lobby),
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
  "advance_phase", // P2.0 scaffold — goes away with the scheduler
]);

/** English-neutral; the client localises off `reason` + `action` */
const HOST_ONLY_MESSAGE = {
  start_game: "Only the room host can start the game.",
  kick_player: "Only the room host can remove players.",
  terminate_lobby: "Only the room host can close the room.",
  advance_phase: "Only the room host can advance the match.",
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
 * start_game — P2.0: build the state item, announce it, return.
 *
 * Host-gated upstream by requireHost(). No turn logic runs here: the match is
 * created in `countdown` with a real deadline and stops. What advances it is
 * P2.1's scheduler; until then, `advance_phase` below does it by hand.
 */
async function onStartGame(event, connectionId, row) {
  const lobbyId = row.lobbyId;
  const lobby = await resolveLobby(lobbyId);
  if (!lobby) {
    await postTo(event, connectionId, {
      type: "error", reason: "room_not_found", action: "start_game",
      message: "That room no longer exists.",
    });
    return;
  }

  const conns = await connectionsInLobby(lobbyId);
  const draft = initialGameState(lobby, lobbyId, conns);
  if (draft.players.length < MIN_PLAYERS) {
    await postTo(event, connectionId, {
      type: "error", reason: "too_few_players", action: "start_game",
      message: `Need at least ${MIN_PLAYERS} connected players to start.`,
    });
    return;
  }

  const existing = await readGameState(lobbyId);
  if (existing && existing.phase !== "lobby" && existing.phase !== "gameover") {
    await postTo(event, connectionId, {
      type: "error", reason: "already_running", action: "start_game",
      message: "A match is already in progress in this room.",
    });
    return;
  }

  let state;
  if (existing) {
    // a finished match is replaced under the lock, so two hosts hitting start
    // at once cannot both seed a match
    const res = await mutateGameState(lobbyId, () => draft);
    if (!res.ok) {
      await postTo(event, connectionId, {
        type: "error", reason: res.reason, action: "start_game",
        message: "Could not start the match, please try again.",
      });
      return;
    }
    state = res.state;
  } else {
    try {
      state = await createGameState(draft);
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        await postTo(event, connectionId, {
          type: "error", reason: "already_running", action: "start_game",
          message: "A match is already in progress in this room.",
        });
        return;
      }
      throw err;
    }
  }

  await broadcastGameState(event, lobbyId, state);
  await systemChat(event, lobbyId, "The match is starting…");
}

/**
 * advance_phase — P2.0 SCAFFOLD, host-gated, to be deleted in P2.1.
 *
 * Moves the phase machine one step and re-stamps `phaseEndsAt`, so state
 * transitions and the version lock can be exercised end-to-end before a
 * scheduler exists. It runs NO game logic: nothing is drawn, nobody is picked,
 * no money moves. P2.1 replaces this with Step Functions firing on
 * `phaseEndsAt`, and the per-phase logic lands with it.
 */
const NEXT_PHASE = {
  countdown: "spin",
  spin: "question",
  question: "betting",
  betting: "reveal",
  reveal: "picking",
  picking: "spin",
  duel: "reveal",
};

function phaseDuration(phase, chainDepth) {
  switch (phase) {
    case "countdown": return COUNTDOWN_MS;
    case "spin": return SPIN_TIME_MS;
    case "question": return questionTimeFor(chainDepth);
    case "betting": return BETTING_TIME_MS;
    case "reveal": return REVEAL_MS;
    case "picking": return PICK_TIME_MS;
    case "duel": return DUEL_TIME_MS;
    default: return 0;
  }
}

async function onAdvancePhase(event, connectionId, row) {
  const res = await mutateGameState(row.lobbyId, (s) => {
    const next = NEXT_PHASE[s.phase];
    if (!next) return null; // gameover / lobby — nothing to advance
    s.phase = next;
    s.phaseEndsAt = nowMs() + phaseDuration(next, s.chainDepth);
    if (next === "question") s.round += 1;
    return s;
  });

  if (!res.ok) {
    await postTo(event, connectionId, {
      type: "error", reason: res.reason, action: "advance_phase",
      message: res.reason === "no_state"
        ? "No match is running in this room."
        : "Could not advance the phase.",
    });
    return;
  }
  await broadcastGameState(event, row.lobbyId, res.state);
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
      // the host gate runs BEFORE anything else these actions would do, and
      // stays in front of the turn engine when Phase 2 lands here
      if (HOST_ONLY_ACTIONS.has(type) && !(await requireHost(event, connectionId, row, type))) {
        break;
      }
      if (type === "start_game") {
        await onStartGame(event, connectionId, row);
        break;
      }
      if (type === "advance_phase") {
        await onAdvancePhase(event, connectionId, row);
        break;
      }
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
