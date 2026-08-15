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
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || "Connections";
const GAME_STATE_TABLE = process.env.GAME_STATE_TABLE || "GameState";
const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE || "Questions";
const PHASE_TIMER_ARN =
  process.env.PHASE_TIMER_ARN ||
  "arn:aws:states:eu-west-3:637423486388:stateMachine:ipakSeOkrecePhaseTimer";
/**
 * Where postToConnection sends. A WebSocket invocation derives this from its
 * own event; a Step Functions invocation has no requestContext, so the timer
 * path needs it configured.
 */
const WS_ENDPOINT =
  process.env.WS_ENDPOINT ||
  "https://j803en0pf7.execute-api.eu-west-3.amazonaws.com/prod";
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

// ─── scoring constants, also from room.ts ──────────────────────────────────
/** share of questions that are generated arithmetic rather than deck draws */
const MATH_QUESTION_CHANCE = 0.3;
/** what a wrong answer or a timeout costs the answerer */
const WRONG_ANSWER_COST = 100;
/** smallest stake, and the floor for being counted as an eligible bettor */
const MIN_BET = 10;

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
/**
 * Pseudo-observations of a 50% player mixed into every accuracy estimate, so a
 * player with no history quotes exactly even money and the odds firm up as
 * evidence arrives instead of swinging on a single answer. 4 means one correct
 * answer moves the estimate to 0.6, not to 1.0 — a min-sample fallback that
 * degrades smoothly rather than switching on at a threshold.
 */
const QUOTA_PRIOR_WEIGHT = 4;

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
  const domainName = event?.requestContext?.domainName;
  const stage = event?.requestContext?.stage;
  // a custom domain already carries its own base path; the default
  // execute-api domain needs the stage appended. A phase-timer invocation
  // arrives from Step Functions with no requestContext at all, so it falls
  // back to the configured endpoint.
  const endpoint =
    domainName && stage ? `https://${domainName}/${stage}` : WS_ENDPOINT;
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
    // phaseSeq must exist from the very first phase: the scheduler's guard
    // compares against it, and an undefined here makes the first timer think
    // it is stale and exit, leaving the match parked in countdown forever
    phaseSeq: 1,
    phaseEndsAt: now + COUNTDOWN_MS,
    executionArn: null,
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
    // which SIDE each player took stays hidden while betting is open — it is
    // live strategic information — and is revealed once the turn resolves
    bets: (s.bets ?? []).map((b) => ({
      username: b.username,
      amount: b.amount,
      quota: b.quota,
      ...(s.phase === "reveal" || s.phase === "gameover" ? { side: b.side } : {}),
    })),
    // the price on offer right now, so a client can label the two buttons
    quotas:
      s.phase === "question" || s.phase === "betting" ? quotasFor(s) : null,
    betResults: s.phase === "reveal" ? s.betResults ?? [] : null,
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

// ═══════════════════════════════════════════════════════════════════════════
// QUESTIONS — ported from src/server/game/questions.ts
// ═══════════════════════════════════════════════════════════════════════════

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let mathCounter = 0;
/** generated arithmetic, harder tiers get harder forms (questions.ts) */
function generateMathQuestion(difficulty) {
  let text, answer;
  if (difficulty <= 1) {
    const a = randInt(3, 60), b = randInt(2, 40);
    if (Math.random() < 0.5) { text = `${a} + ${b} = ?`; answer = a + b; }
    else { const [hi, lo] = a >= b ? [a, b] : [b, a]; text = `${hi} - ${lo} = ?`; answer = hi - lo; }
  } else if (difficulty === 2) {
    if (Math.random() < 0.5) {
      const a = randInt(3, 12), b = randInt(3, 12);
      text = `${a} × ${b} = ?`; answer = a * b;
    } else {
      const b = randInt(2, 12), q = randInt(2, 12);
      text = `${b * q} ÷ ${b} = ?`; answer = q;
    }
  } else {
    const form = randInt(0, 2), a = randInt(2, 9), b = randInt(2, 9), c = randInt(2, 9);
    if (form === 0) { text = `${a} + ${b} × ${c} = ?`; answer = a + b * c; }
    else if (form === 1) { text = `(${a} + ${b}) × ${c} = ?`; answer = (a + b) * c; }
    else { const x = randInt(2, 12); text = `${a}x + ${b} = ${a * x + b}, x = ?`; answer = x; }
  }
  const options = new Set([answer]);
  while (options.size < 4) {
    const spread = Math.max(2, Math.round(Math.abs(answer) / 5));
    const candidate = answer + (Math.random() < 0.5 ? -1 : 1) * randInt(1, spread + 2);
    if (candidate !== answer && candidate >= 0) options.add(candidate);
  }
  return {
    id: `math-${++mathCounter}`,
    text,
    options: shuffle([...options].map(String)),
    answer: String(answer),
    difficulty: Math.min(3, Math.max(1, difficulty)),
  };
}

/** the same tolerant normaliser questions.ts uses */
function normalizeQuestion(raw, fallbackId) {
  if (!raw || typeof raw.question_text !== "string") return null;
  const rawOptions = Array.isArray(raw.question_options) ? raw.question_options : [];
  const options = rawOptions
    .map((o) => (typeof o === "string" ? o : o?.question_option_text ?? null))
    .filter((o) => typeof o === "string" && o.length > 0);
  const answer = typeof raw.answer === "string" ? raw.answer : null;
  if (options.length < 2 || !answer || !options.includes(answer)) return null;
  const difficulty = Number(raw.difficulty);
  return {
    id: String(raw.question_id ?? fallbackId),
    text: raw.question_text,
    options,
    answer,
    difficulty: difficulty >= 1 && difficulty <= 3 ? Math.round(difficulty) : 1,
  };
}

// cached at module scope: a warm container scans the table once, not per turn
let questionPool = null;
async function loadQuestionPool() {
  if (questionPool) return questionPool;
  const res = await ddb.send(new ScanCommand({ TableName: QUESTIONS_TABLE }));
  const list = (res.Items ?? [])
    .map((item, i) => normalizeQuestion(item, `db-${i}`))
    .filter(Boolean);
  questionPool = { byId: new Map(list.map((q) => [q.id, q])), ids: list.map((q) => q.id) };
  return questionPool;
}

/**
 * Draw for the requested tier. The deck persists as id lists on the state so a
 * match does not repeat a question until the pool is exhausted; the drawn
 * question itself is copied into `turn` so nothing has to be re-resolved.
 */
function drawQuestion(state, difficulty, pool) {
  if (Math.random() < MATH_QUESTION_CHANCE) return generateMathQuestion(difficulty);
  if (!state.deck) state.deck = { fresh: [], used: [] };
  if (!state.deck.fresh.length) {
    state.deck.fresh = shuffle(state.deck.used);
    state.deck.used = [];
  }
  if (!state.deck.fresh.length) return generateMathQuestion(difficulty);

  const want = Math.min(3, Math.max(1, difficulty));
  const at = (d) => state.deck.fresh.findIndex((id) => pool.byId.get(id)?.difficulty === d);
  let idx = at(want);
  if (idx < 0) idx = at(want - 1);
  if (idx < 0) idx = 0;
  const [id] = state.deck.fresh.splice(idx, 1);
  state.deck.used.push(id);
  return pool.byId.get(id) ?? generateMathQuestion(difficulty);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ROUND LOOP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every phase change goes through here. `phaseSeq` is what makes the scheduler
 * idempotent: a timer carries the seq it was armed for, and a timer whose seq
 * no longer matches the state is one whose phase already moved on — it exits
 * without touching anything.
 */
function setPhase(state, phase, durationMs) {
  state.phase = phase;
  state.phaseSeq = Number(state.phaseSeq ?? 0) + 1;
  state.phaseEndsAt = nowMs() + durationMs;
  return state;
}

const livingPlayers = (s) => (s.players ?? []).filter((p) => p.alive && !p.isSpectator);

/**
 * SPIN WEIGHTS — Matija's decaying model.
 *
 *   picked      w := max(MIN, w * PICKED_DECAY)     0.35×, floored at 0.15
 *   everyone    w := min(MAX, w * RECOVERY)         1.25×, capped at 2.5
 *   else
 *
 * The floor is the whole point: a just-picked player's weight drops hard but
 * never reaches zero, so an immediate re-pick stays possible — just unlikely.
 * The cap stops someone ignored for ten spins becoming a certainty. Weights
 * are persisted per player, so unlike room.ts's single `lastSpinTarget` the
 * distribution remembers the whole match, and a player skipped repeatedly
 * climbs while the recently-picked sink.
 */
function applySpinWeights(state, pickedUsername) {
  for (const p of state.players ?? []) {
    if (!p.alive || p.isSpectator) continue;
    const w = Number(p.spinWeight ?? SPIN_WEIGHT_INITIAL);
    const next =
      p.username === pickedUsername
        ? Math.max(SPIN_WEIGHT_MIN, w * SPIN_WEIGHT_PICKED_DECAY)
        : Math.min(SPIN_WEIGHT_MAX, w * SPIN_WEIGHT_RECOVERY);
    // keep the stored numbers tidy — DynamoDB happily persists float drift
    p.spinWeight = Math.round(next * 1e6) / 1e6;
  }
}

function weightedPick(alive) {
  const w = (p) => Math.max(SPIN_WEIGHT_MIN, Number(p.spinWeight ?? SPIN_WEIGHT_INITIAL));
  const total = alive.reduce((sum, p) => sum + w(p), 0);
  let roll = Math.random() * total;
  for (const p of alive) {
    roll -= w(p);
    if (roll <= 0) return p;
  }
  return alive[alive.length - 1];
}

// ═══════════════════════════════════════════════════════════════════════════
// THE POT — betting, quotas, settlement
// ═══════════════════════════════════════════════════════════════════════════
//
// THE INVARIANT, and the whole point of this step:
//
//     sum(players[].money) + pot   is constant for the entire match
//
// Nothing is created and nothing is destroyed. A stake leaves the bettor and
// enters the pot; a payout leaves the pot and enters the winner; a wrong
// answer's penalty leaves the answerer and ENTERS THE POT rather than
// vanishing. room.ts did the opposite on both counts — it paid winners out of
// nowhere and deleted the wrong-answer penalty — which is why money there
// could inflate and why nothing guaranteed anyone reached zero.
//
// Money still concentrates: individuals are eliminated at 0 and the survivor
// ends up holding it. That is the poker model Matija asked for, and it needs
// no house edge to terminate.

/** alive, not the one answering, and holding at least the minimum stake */
function bettorsFor(state) {
  const t = state.turn;
  if (!t) return [];
  return livingPlayers(state).filter(
    (p) => p.username !== t.answering && p.money >= MIN_BET
  );
}

/** eligible players who have not yet declared (a stake OR an abstain) */
function pendingBettors(state) {
  const placed = new Set((state.bets ?? []).map((b) => b.username));
  return bettorsFor(state).filter((p) => !placed.has(p.username));
}

/** smoothed in-match accuracy of a player: correct / (correct + wrong) */
function accuracyOf(player) {
  const c = Number(player?.stats?.correct ?? 0);
  const w = Number(player?.stats?.wrong ?? 0);
  return (c + QUOTA_PRIOR_WEIGHT * 0.5) / (c + w + QUOTA_PRIOR_WEIGHT);
}

/**
 * Quotas for the current turn, derived from the ANSWERING player's accuracy.
 *
 * A quota is the GROSS return multiple: the stake has already gone into the
 * pot, so a winner receives stake × quota back. The fair price of an outcome
 * with probability q is 1/q — which makes an even-money 50/50 pay exactly 2.0,
 * the cap. Betting the likely outcome therefore pays LESS than double, and the
 * unlikely one is pinned at the 2.0 ceiling.
 *
 *   answerer 80% accurate →  correct 1.25×   wrong 2.00× (capped from 5.0)
 *   answerer 50% accurate →  correct 2.00×   wrong 2.00×
 *   answerer 20% accurate →  correct 2.00×   wrong 1.25×
 *
 * The quota is LOCKED onto each bet when it is placed, never recomputed at
 * settlement — by then the answerer's stats already include the very outcome
 * being paid out, which would price the bet using its own result.
 */
function quotasFor(state) {
  const t = state.turn;
  const answerer = t
    ? (state.players ?? []).find((p) => p.username === t.answering)
    : null;
  const p = answerer ? accuracyOf(answerer) : 0.5;
  const price = (q) =>
    Math.round(Math.min(QUOTA_MAX, Math.max(QUOTA_MIN, 1 / Math.max(q, 0.01))) * 100) / 100;
  return {
    correct: price(p),
    wrong: price(1 - p),
    accuracy: Math.round(p * 1000) / 1000,
  };
}

/**
 * Pay the winners out of the pot, exactly once per turn.
 *
 * If the pot cannot cover everything owed, every payout is scaled down by the
 * same factor — the pot is a hard ceiling, so it can never be overdrawn. Any
 * remainder (losers' stakes, rounding dust, an unclaimed surplus) simply stays
 * in the pot and carries into the next round.
 */
function settleBets(state) {
  const t = state.turn;
  if (!t || t.betsSettled) return [];

  const staked = (state.bets ?? []).filter(
    (b) => b.side === "correct" || b.side === "wrong"
  );
  const isWinner = (b) => (b.side === "correct") === Boolean(t.correct);

  const owed = staked
    .filter(isWinner)
    .reduce((sum, b) => sum + b.amount * b.quota, 0);
  const pot = Number(state.pot ?? 0);
  const payable = Math.min(owed, pot);
  const scale = owed > 0 ? payable / owed : 0;

  const results = [];
  for (const b of staked) {
    const won = isWinner(b);
    let payout = 0;
    if (won) {
      // floor, so the sum of payouts can never exceed `payable`
      payout = Math.floor(b.amount * b.quota * scale);
      const p = (state.players ?? []).find((x) => x.username === b.username);
      if (p) {
        p.money += payout;
        state.pot = Number(state.pot ?? 0) - payout;
        p.stats = p.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
        p.stats.betsWon = Number(p.stats.betsWon ?? 0) + 1;
        p.stats.maxBetWin = Math.max(Number(p.stats.maxBetWin ?? 0), payout - b.amount);
      }
    }
    results.push({
      username: b.username,
      side: b.side,
      amount: b.amount,
      quota: b.quota,
      won,
      payout,
      net: payout - b.amount,
    });
  }

  t.betsSettled = true;
  t.betScale = Math.round(scale * 1000) / 1000;
  state.betResults = results;
  return results;
}

function enterBetting(state) {
  setPhase(state, "betting", BETTING_TIME_MS);
  return state;
}

function enterGameOver(state) {
  const ranked = [...(state.players ?? [])]
    .filter((p) => !p.isSpectator)
    .sort((a, b) => (a.alive !== b.alive ? (a.alive ? -1 : 1) : b.money - a.money));
  state.winner = ranked[0]?.username ?? null;
  state.turn = null;
  state.currentSpin = null;
  state.currentPick = null;
  setPhase(state, "gameover", 0);
  state.phaseEndsAt = 0;
  return state;
}

/** the wheel: decide the FINAL target up front, then animate for 5s */
function enterSpin(state) {
  const alive = livingPlayers(state);
  if (alive.length <= 1) return enterGameOver(state);

  state.chainDepth = 0;
  const target = weightedPick(alive);
  applySpinWeights(state, target.username);
  state.lastSpinTarget = target.username;
  state.turn = null;
  state.currentPick = null;
  setPhase(state, "spin", SPIN_TIME_MS);
  state.currentSpin = {
    target: target.username,
    startedAt: nowMs(),
    endsAt: state.phaseEndsAt,
  };
  return state;
}

function enterQuestion(state, username, pool) {
  const player = (state.players ?? []).find((p) => p.username === username);
  if (!player || !player.alive) return enterSpin(state);

  state.round = Number(state.round ?? 0) + 1;
  // room.ts credits the round to everyone still standing (creditRound)
  for (const p of livingPlayers(state)) {
    p.stats = p.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
    p.stats.roundsPlayed = Number(p.stats.roundsPlayed ?? 0) + 1;
  }

  const difficulty = Math.min(3, Math.max(1, 1 + Math.floor(Number(state.chainDepth ?? 0) / 2)));
  const answerTimeMs = questionTimeFor(Number(state.chainDepth ?? 0));
  state.turn = {
    answering: username,
    question: drawQuestion(state, difficulty, pool),
    askedAt: nowMs(),
    answerTimeMs,
    answer: null,
    answeredInMs: null,
    correct: null,
    timedOut: null,
    answererDelta: 0,
  };
  // a fresh betting book each turn; the POT deliberately carries over
  state.bets = [];
  state.betResults = [];
  state.currentSpin = null;
  state.currentPick = null;
  setPhase(state, "question", answerTimeMs);
  return state;
}

/** resolve the turn: correctness, stats, money. P2.2 settles the pot here. */
function enterReveal(state) {
  const t = state.turn;
  if (!t) return enterSpin(state);

  const timedOut = t.answer === null || t.answer === undefined;
  const correct = !timedOut && t.answer === t.question?.answer;
  t.timedOut = timedOut;
  t.correct = correct;

  const player = (state.players ?? []).find((p) => p.username === t.answering);
  if (player) {
    player.stats = player.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
    if (correct) {
      player.stats.correct = Number(player.stats.correct ?? 0) + 1;
    } else {
      player.stats.wrong = Number(player.stats.wrong ?? 0) + 1;
      const penalty = Math.min(WRONG_ANSWER_COST, player.money);
      player.money = Math.max(0, player.money - penalty);
      // INTO THE POT, not deleted. room.ts destroyed this money; keeping it in
      // the pot is what makes sum(money) + pot invariant, and it means a table
      // full of wrong answers funds the next round's winners.
      state.pot = Number(state.pot ?? 0) + penalty;
      t.answererDelta = -penalty;
    }
  }

  // pay the bets before checking for broke players, so a winner whose payout
  // rescues them from zero is not eliminated a moment before being paid
  settleBets(state);

  // elimination wiring — P2.4 finalises standings and persistence
  state.eliminated = [];
  for (const p of state.players ?? []) {
    if (p.alive && p.money <= 0) {
      p.money = 0;
      p.alive = false;
      state.eliminated.push(p.username);
    }
  }

  setPhase(state, "reveal", REVEAL_MS);
  return state;
}

/** correct → the answerer picks the next victim; wrong → back to the wheel */
function afterReveal(state, pool) {
  if (livingPlayers(state).length <= 1) return enterGameOver(state);

  const t = state.turn;
  const answerer = t ? (state.players ?? []).find((p) => p.username === t.answering) : null;
  if (t?.correct && answerer?.alive) {
    const choices = livingPlayers(state)
      .filter((p) => p.username !== t.answering)
      .map((p) => p.username);
    if (choices.length === 1) {
      state.chainDepth = Number(state.chainDepth ?? 0) + 1;
      return enterQuestion(state, choices[0], pool);
    }
    setPhase(state, "picking", PICK_TIME_MS);
    state.currentPick = { picker: t.answering, choices, endsAt: state.phaseEndsAt };
    return state;
  }
  return enterSpin(state);
}

/** what a fired deadline does, per phase */
function advanceOnDeadline(state, pool) {
  switch (state.phase) {
    case "countdown":
      return enterSpin(state);
    case "spin":
      return enterQuestion(state, state.currentSpin?.target, pool);
    case "question":
      // ran out of time without answering — room.ts holds no betting pause in
      // that case either, so whatever is on the book settles as it stands
      return enterReveal(state);
    case "betting":
      return enterReveal(state);
    case "reveal":
      return afterReveal(state, pool);
    case "picking": {
      const choices = state.currentPick?.choices ?? [];
      if (!choices.length) return enterSpin(state);
      const target = choices[Math.floor(Math.random() * choices.length)];
      state.chainDepth = Number(state.chainDepth ?? 0) + 1;
      return enterQuestion(state, target, pool);
    }
    default:
      return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════
const sfn = new SFNClient({ region: REGION });
/** a fired timer this far before its deadline is early — re-arm, don't advance */
const TIMER_TOLERANCE_MS = 400;

async function startPhaseTimer(lobbyId, phaseSeq, phaseEndsAt) {
  const res = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: PHASE_TIMER_ARN,
      input: JSON.stringify({
        source: "phase-timer",
        lobbyId,
        phaseSeq,
        waitUntil: new Date(phaseEndsAt).toISOString(),
      }),
    })
  );
  return res.executionArn;
}

async function stopPhaseTimer(executionArn) {
  if (!executionArn) return;
  try {
    await sfn.send(new StopExecutionCommand({ executionArn }));
  } catch (err) {
    // already finished, or never existed — the phaseSeq guard covers us anyway
    console.warn("stopExecution failed (harmless)", err?.name);
  }
}

/**
 * Re-arm after a transition driven by a PLAYER rather than a deadline.
 *
 * The running execution is asleep on the old deadline, so it is stopped and a
 * fresh one started. If the stop loses the race and the old execution fires
 * anyway, its phaseSeq no longer matches and it exits without acting — the
 * guard is what makes this safe rather than the stop.
 *
 * Runs AFTER the state write commits, then persists the new ARN in a second
 * write. That second write bumps `version` but not `phaseSeq`, so it cannot
 * invalidate the timer it just armed.
 */
async function rearmPhaseTimer(state, previousExecutionArn) {
  await stopPhaseTimer(previousExecutionArn);
  if (state.phase === "gameover") {
    await mutateGameState(state.lobbyId, (s) => { s.executionArn = null; return s; });
    return;
  }
  const arn = await startPhaseTimer(state.lobbyId, state.phaseSeq, state.phaseEndsAt);
  await mutateGameState(state.lobbyId, (s) => { s.executionArn = arn; return s; });
}

/** the phase-specific message that rides alongside game_state */
function phaseMessage(state) {
  switch (state.phase) {
    case "spin":
      return {
        type: "spin",
        target: state.currentSpin?.target,
        spinTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "question":
      return {
        type: "turn_question",
        round: state.round,
        chainDepth: state.chainDepth,
        answering: state.turn?.answering,
        questionText: state.turn?.question?.text,
        options: state.turn?.question?.options,
        difficulty: state.turn?.question?.difficulty,
        answerTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "betting":
      return {
        type: "bet_start",
        target: state.turn?.answering,
        betTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
        pot: Number(state.pot ?? 0),
        quotas: quotasFor(state),
      };
    case "reveal":
      return {
        type: "round_result",
        round: state.round,
        pot: Number(state.pot ?? 0),
        bets: state.betResults ?? [],
        betScale: Number(state.turn?.betScale ?? 1),
        chainDepth: state.chainDepth,
        answering: state.turn?.answering,
        answer: state.turn?.answer ?? null,
        timedOut: Boolean(state.turn?.timedOut),
        correct: Boolean(state.turn?.correct),
        correctAnswer: state.turn?.question?.answer ?? null,
        answererDelta: Number(state.turn?.answererDelta ?? 0),
        eliminated: state.eliminated ?? [],
      };
    case "picking":
      return {
        type: "pick_start",
        picker: state.currentPick?.picker,
        choices: state.currentPick?.choices ?? [],
        pickTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "gameover":
      return { type: "game_over", winner: state.winner ?? null, rounds: state.round };
    default:
      return null;
  }
}

/** state first so the client can render off it, then the phase event */
async function broadcastPhase(event, lobbyId, state) {
  await broadcastGameState(event, lobbyId, state);
  const msg = phaseMessage(state);
  if (msg) await broadcast(event, lobbyId, msg);
}

/**
 * The phaseAdvance entry point — invoked by Step Functions, not by a socket.
 * Returns the next {waitUntil, phaseSeq, done} so the state machine loops.
 */
async function onPhaseTimer(event) {
  const lobbyId = event.lobbyId;
  const firedFor = Number(event.phaseSeq);
  const pool = await loadQuestionPool();

  const res = await mutateGameState(lobbyId, (s) => {
    if (Number(s.phaseSeq ?? 0) !== firedFor) return null; // stale — phase moved
    if (s.phase === "gameover") return null;
    if (nowMs() < Number(s.phaseEndsAt ?? 0) - TIMER_TOLERANCE_MS) return null; // early
    return advanceOnDeadline(s, pool);
  });

  if (!res.ok) {
    const cur = await readGameState(lobbyId);
    if (!cur || cur.phase === "gameover") return { done: true, lobbyId };
    // somebody else now owns the timer for this match
    if (Number(cur.phaseSeq ?? 0) !== firedFor) return { done: true, lobbyId };
    // our phase is still current but the deadline moved out — wait again
    return {
      done: false,
      lobbyId,
      phaseSeq: cur.phaseSeq,
      waitUntil: new Date(Number(cur.phaseEndsAt)).toISOString(),
      source: "phase-timer",
    };
  }

  const s = res.state;
  await broadcastPhase(event, lobbyId, s);
  if (s.phase === "gameover") return { done: true, lobbyId };
  return {
    done: false,
    lobbyId,
    phaseSeq: s.phaseSeq,
    waitUntil: new Date(Number(s.phaseEndsAt)).toISOString(),
    source: "phase-timer",
  };
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
 * the scheduler: rearmPhaseTimer() starts a Step Functions execution that
 * sleeps until `phaseEndsAt` and then drives the match forward.
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
  // arm the countdown deadline; from here the scheduler drives the match
  await rearmPhaseTimer(state, existing?.executionArn);
}

/**
 * submit_answer — only the player the wheel landed on, only before the
 * deadline, only once. Everyone else's submission is silently ignored exactly
 * as room.ts ignores it.
 *
 * Answering early ends the question phase immediately, which is a
 * player-driven transition: the sleeping timer is stopped and re-armed on the
 * new reveal deadline.
 *
 * P2.2 inserts the betting pause between here and reveal; for now a submitted
 * answer resolves straight through.
 */
async function onSubmitAnswer(event, connectionId, row, msg) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error", reason: "not_joined", action: "submit_answer",
      message: "Join the room before doing that.",
    });
    return;
  }
  const answer = String(msg.answer ?? "");
  const pool = await loadQuestionPool();
  const before = await readGameState(row.lobbyId);

  const res = await mutateGameState(row.lobbyId, (s) => {
    if (s.phase !== "question" || !s.turn) return null;
    if (s.turn.answering !== row.username) return null;
    if (s.turn.answer !== null && s.turn.answer !== undefined) return null;
    if (nowMs() > Number(s.phaseEndsAt ?? 0)) return null; // too late — the timer owns it
    s.turn.answer = answer;
    s.turn.answeredInMs = nowMs() - Number(s.turn.askedAt ?? nowMs());
    // the answer stays hidden while the last bets come in — room.ts's "last
    // call" pause. If nobody is left to bet, resolve straight through.
    return pendingBettors(s).length > 0 ? enterBetting(s) : enterReveal(s);
  });

  if (!res.ok) return; // not their turn, already answered, or past the buzzer
  await broadcastPhase(event, row.lobbyId, res.state);
  await rearmPhaseTimer(res.state, before?.executionArn);
}

/**
 * place_bet — stake on whether the answering player gets it right.
 *
 * Open from the moment the question appears until the betting pause closes.
 * ONE declaration per player per turn, no raising: the quota is locked when
 * the bet is placed, so allowing a raise would mean either re-pricing an
 * accepted bet or carrying two quotas for one player. Abstaining ("neutral")
 * counts as a declaration but stakes nothing — it is what lets the pause end
 * early once everyone has decided.
 *
 * The stake leaves the player and enters the pot here, not at settlement, so
 * the money is visibly committed and cannot be spent twice.
 */
async function onPlaceBet(event, connectionId, row, msg) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error", reason: "not_joined", action: "place_bet",
      message: "Join the room before doing that.",
    });
    return;
  }
  const side = String(msg.side ?? msg.bet ?? "");
  const before = await readGameState(row.lobbyId);
  let closedEarly = false;

  const res = await mutateGameState(row.lobbyId, (s) => {
    if (s.phase !== "question" && s.phase !== "betting") return null;
    if (!s.turn) return null;
    if (nowMs() > Number(s.phaseEndsAt ?? 0)) return null; // past the deadline
    if (!["correct", "wrong", "neutral"].includes(side)) return null;
    if (s.turn.answering === row.username) return null;    // can't bet on yourself

    s.bets = s.bets ?? [];
    if (s.bets.some((b) => b.username === row.username)) return null; // already declared

    const player = (s.players ?? []).find((p) => p.username === row.username);
    if (!player || !player.alive) return null;

    if (side === "neutral") {
      s.bets.push({ username: row.username, side: "neutral", amount: 0, quota: 0 });
    } else {
      if (player.money < MIN_BET) return null;
      const allIn = msg.amount === "all" || msg.allIn === true;
      const raw = allIn ? player.money : Math.floor(Number(msg.amount) || 0);
      const amount = Math.min(player.money, Math.max(MIN_BET, raw));
      const quota = quotasFor(s)[side];
      player.money -= amount;                          // out of the pocket…
      s.pot = Number(s.pot ?? 0) + amount;             // …and into the pot
      s.bets.push({ username: row.username, side, amount, quota });
    }

    // last one in during the pause? close it rather than burn the clock
    if (s.phase === "betting" && pendingBettors(s).length === 0) {
      closedEarly = true;
      return enterReveal(s);
    }
    return s;
  });

  if (!res.ok) return; // ineligible, already declared, or too late — silent
  await broadcast(event, row.lobbyId, {
    type: "player_bet",
    username: row.username,
    betCount: (res.state.bets ?? []).length,
    pot: res.state.pot,
  });
  await broadcastPhase(event, row.lobbyId, res.state);
  if (closedEarly) await rearmPhaseTimer(res.state, before?.executionArn);
}

/**
 * pick_player — the correct answerer chooses who faces the next question.
 * P2.3 adds the CHALLENGE / DUEL mode choice on top of this target choice.
 */
async function onPickPlayer(event, connectionId, row, msg) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error", reason: "not_joined", action: "pick_player",
      message: "Join the room before doing that.",
    });
    return;
  }
  const target = String(msg.target ?? "");
  const pool = await loadQuestionPool();
  const before = await readGameState(row.lobbyId);

  const res = await mutateGameState(row.lobbyId, (s) => {
    if (s.phase !== "picking" || !s.currentPick) return null;
    if (s.currentPick.picker !== row.username) return null;
    if (!(s.currentPick.choices ?? []).includes(target)) return null;
    s.chainDepth = Number(s.chainDepth ?? 0) + 1;
    return enterQuestion(s, target, pool);
  });

  if (!res.ok) return;
  await broadcastPhase(event, row.lobbyId, res.state);
  await rearmPhaseTimer(res.state, before?.executionArn);
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
      if (type === "submit_answer") {
        await onSubmitAnswer(event, connectionId, row, msg);
        break;
      }
      if (type === "place_bet") {
        await onPlaceBet(event, connectionId, row, msg);
        break;
      }
      if (type === "pick_player") {
        await onPickPlayer(event, connectionId, row, msg);
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
/**
 * Two entry points, one function.
 *
 *   API Gateway  → event.requestContext.routeKey is $connect/$disconnect/$default
 *   Step Functions → no requestContext; the execution input carries
 *                    source: "phase-timer"
 *
 * They share a function deliberately: a deadline firing and a player answering
 * early run the SAME transition code (enterReveal, afterReveal, enterSpin…).
 * Splitting them into two deployments would mean two copies of the engine and
 * the certainty that they drift.
 */
export const handler = async (event) => {
  if (event?.source === "phase-timer" && event.lobbyId) {
    try {
      return await onPhaseTimer(event);
    } catch (err) {
      console.error("phase timer failed", event.lobbyId, err);
      // let the state machine stop rather than spin on a poisoned match
      return { done: true, lobbyId: event.lobbyId, error: String(err?.message ?? err) };
    }
  }

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
