/**
 * ===========================================================================
 * createRoom — POST /createRoom
 * ===========================================================================
 * Creates a lobby. Costs one lobby credit (the anti-spam throttle).
 *
 * Paste-ready AWS Lambda handler. NO third-party dependencies: everything
 * used here either ships in the Node.js 18/20/22 Lambda runtime (AWS SDK v3)
 * or is built into Node (node:crypto, global fetch). Paste it and it runs —
 * no layer, no zip, no `npm install`.
 *
 * ┌── PASTE INSTRUCTIONS ───────────────────────────────────────────────────┐
 * │ The console file MUST be named  index.mjs  (the .mjs extension is what  │
 * │ makes `export const handler` work). Runtime: Node.js 22.x.              │
 * │ Handler: index.handler   Timeout: 15s   Memory: 512 MB                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ─────────────────────────────────────────
 *   LOBBIES_TABLE          Lobbies
 *   PLAYERS_TABLE          Players
 *   COGNITO_USER_POOL_ID   eu-west-3_Uylh5ZFUK
 *   COGNITO_CLIENT_ID      3j69q67dfk60kl92gukqhdlr91
 *   ALLOWED_ORIGIN         https://<your-vercel-domain>,http://localhost:3000
 *   AWS_REGION             set automatically by Lambda — do NOT add it by hand
 *                          (Lambda rejects reserved env var names).
 * Every one has a working default baked in below, so the function runs even
 * with no env vars set. Setting them is still the right thing to do.
 *
 * ── IAM (inline policy on this function's execution role) ──────────────────
 *   {
 *     "Version": "2012-10-17",
 *     "Statement": [
 *       { "Effect": "Allow",
 *         "Action": ["dynamodb:PutItem"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies" },
 *       { "Effect": "Allow",
 *         "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Players" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /createRoom
 *   Integration:   Lambda proxy integration (HTTP API payload 2.0, or REST
 *                  "Use Lambda Proxy integration" — this handler reads both).
 *   binaryMediaTypes: not needed — request and response are both JSON.
 *   Authorization: leave the route OPEN in API Gateway. This handler does
 *                  the Cognito check itself and answers 401 on its own.
 *
 * ── CORS ───────────────────────────────────────────────────────────────────
 *   This handler emits the CORS headers itself (from ALLOWED_ORIGIN) and
 *   answers the OPTIONS preflight, so a bare paste works with no API Gateway
 *   CORS configuration.
 *   ⚠ Do NOT also enable CORS in the API Gateway console — you would get
 *   duplicate Access-Control-Allow-Origin headers, which browsers reject.
 *   Either leave it off (recommended), or turn it on and set ALLOWED_ORIGIN
 *   to an empty string here.
 *
 * ── CONTRACT (matches the Express route exactly — do not change) ───────────
 *   Request:  POST /createRoom
 *             { "roomName": "...", "playerId": "...",   ← IGNORED; the owner
 *                                                       comes from the token
 *               "isPrivate"?: bool, "password"?: "..." (4+ chars if private),
 *               "categories"?: ["Science","History"] — array of strings;
 *                              missing or empty stores ["Mixed"], a non-array
 *                              or a non-string element answers 400,
 *               "maxPlayers"?: 4 — integer seat count; missing or unusable
 *                              stores 6, anything else is floored and clamped
 *                              to 2..8 rather than rejected,
 *               "startingMoney"?: 1500 — coins every player is seated with;
 *                              missing or unusable stores 500, anything else
 *                              is floored and clamped to 500..2500 rather
 *                              than rejected }
 *   Response: 200 { message: "Room created", roomCode, lobbyId, creditsLeft,
 *                   startingMoney }
 *             400 { error: "Missing required fields" }
 *             400 { error: "Private rooms need a password (4+ characters)" }
 *             403 { error: "Not enough credits", credits, nextCreditInMs }
 *             500 { error: "Failed to create room" }
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *

 * ── ⚠ PRIVATE-ROOM PASSWORDS: bcrypt IS GONE, scrypt REPLACES IT ───────────
 *   The Express server hashes private-room passwords with `bcrypt`, a NATIVE
 *   module. Native modules cannot be pasted into the console — they need a
 *   compiled binary shipped in a zip or layer built for the function's
 *   architecture. Rather than break the "paste and go" promise, this handler
 *   uses scrypt from Node's built-in node:crypto instead.
 *
 *   CONSEQUENCE, and you must decide what to do about it:
 *   Private rooms created by the Express server carry a bcrypt hash
 *   ("$2b$..."), which this code CANNOT verify. joinRoom.mjs detects those,
 *   logs them, and answers 500 { message: "legacy_password_hash" } rather
 *   than pretending the password was wrong. Private rooms created by these
 *   Lambdas carry a scrypt hash the Express server cannot verify either.
 *   So: do not run both for private rooms at once. Public rooms are
 *   unaffected — they have no password at all.
 *
 *   Options: (a) move private rooms to Lambda in one cut and let existing
 *   ones expire; (b) keep createRoom/joinRoom on Express and move only the
 *   other routes; (c) add bcrypt to both sides via a Lambda layer, which
 *   gives up console-pasting for these two functions.
 *
 * Ported from: createRoom in src/server/apis/post/room_operations/create_room.ts
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const LOBBIES_TABLE = process.env.LOBBIES_TABLE || "Lobbies";
const PLAYERS_TABLE = process.env.PLAYERS_TABLE || "Players";

// clients at module scope so warm invocations reuse the connections
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ─── request/response helpers (both API Gateway payload formats) ───────────
function header(event, name) {
  const headers = event.headers || {};
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || "POST";
}

/** echo back the caller's origin when it is on the allowed list */
function corsHeaders(event) {
  if (!ALLOWED_ORIGIN) return {}; // API Gateway is handling CORS instead
  const allowed = ALLOWED_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
  const origin = header(event, "origin");
  const match = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": match,
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function json(event, statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders(event) },
    body: JSON.stringify(body),
  };
}

/** parsed JSON body, or {} — Express's express.json() tolerates an empty body */
function parseBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// ─── Cognito access-token verification (no dependencies) ───────────────────
// Identical in every handler in this folder. If you change it, change it
// everywhere — or better, move to the single Lambda authorizer described in
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

function bearerFrom(event) {
  const raw = header(event, "authorization");
  if (!raw) return null;
  const [scheme, token] = raw.split(" ");
  if (!/^Bearer$/i.test(scheme || "") || !token) return null;
  return token.trim() || null;
}

// ─── wallet core (mirrors src/server/game/wallet.ts) ───────────────────────
const CREDIT_CAP = 5;
const CREDIT_REFILL_MS = 30 * 60 * 1000; // +1 credit every 30 min
const LOBBY_CREATE_COST = 1;

const ACHIEVEMENTS = [
  { id: "first_win", name: "First Blood — win your first game" },
  { id: "streak_10", name: "On Fire — win 10 games in a row" },
  { id: "streak_50", name: "Unstoppable — win 50 games in a row" },
  { id: "streak_100", name: "Legend — win 100 games in a row" },
  { id: "first_bet_win", name: "Gambler — win money on a bet" },
  { id: "bet_500", name: "High Roller — win $500+ on a single bet" },
  { id: "flawless_win", name: "Flawless — win without a single wrong answer" },
  { id: "games_50", name: "Veteran — play 50 games" },
];

// real photo uploads replaced the emoji avatars, so the shop sells credits
const SHOP_ITEMS = [
  { id: "credits3", name: "3 lobby credits", cost: 100, kind: "credits", value: "3" },
];

function freshWallet(username) {
  return {
    username,
    credits: CREDIT_CAP,
    lastRefillAt: Date.now(),
    coins: 0,
    ownedAvatars: [],
    wins: 0,
    gamesPlayed: 0,
    roundsPlayed: 0,
    matchHistory: [],
    points: 0,
    currentStreak: 0,
    bestStreak: 0,
    betsWon: 0,
    achievements: [],
    friends: [],
    friendRequests: [],
    avatar: null,
    displayName: null,
  };
}

/** older wallet rows may predate the streak/achievement/history fields */
function withDefaults(w) {
  w.roundsPlayed ??= 0;
  w.matchHistory ??= [];
  w.points ??= 0;
  w.currentStreak ??= 0;
  w.bestStreak ??= 0;
  w.betsWon ??= 0;
  w.achievements ??= [];
  w.friends ??= [];
  w.friendRequests ??= [];
  w.avatar ??= null;
  w.displayName ??= null;
  return w;
}

/** applies time-based credit refill in place */
function refill(wallet) {
  const now = Date.now();
  if (wallet.credits >= CREDIT_CAP) {
    wallet.lastRefillAt = now;
    return wallet;
  }
  const earned = Math.floor((now - wallet.lastRefillAt) / CREDIT_REFILL_MS);
  if (earned > 0) {
    wallet.credits = Math.min(CREDIT_CAP, wallet.credits + earned);
    wallet.lastRefillAt =
      wallet.credits >= CREDIT_CAP
        ? now
        : wallet.lastRefillAt + earned * CREDIT_REFILL_MS;
  }
  return wallet;
}

function msUntilNextCredit(wallet) {
  if (wallet.credits >= CREDIT_CAP) return null;
  return Math.max(0, wallet.lastRefillAt + CREDIT_REFILL_MS - Date.now());
}

async function getWallet(username) {
  const res = await ddb.send(
    new GetCommand({ TableName: PLAYERS_TABLE, Key: { username } })
  );
  const wallet = withDefaults(res.Item ?? freshWallet(username));
  refill(wallet);
  return wallet;
}

/** like getWallet but returns null instead of inventing a row */
async function getWalletIfExists(username) {
  const res = await ddb.send(
    new GetCommand({ TableName: PLAYERS_TABLE, Key: { username } })
  );
  if (!res.Item) return null;
  const wallet = withDefaults(res.Item);
  refill(wallet);
  return wallet;
}

async function saveWallet(wallet) {
  await ddb.send(new PutCommand({ TableName: PLAYERS_TABLE, Item: wallet }));
}

// ─── private-room passwords: scrypt, not bcrypt ────────────────────────────
// See the ⚠ note at the top of this file. Format:
//   scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;

function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return [
    "scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P,
    salt.toString("base64"), key.toString("base64"),
  ].join("$");
}

/** returns true/false, or throws BcryptHashError for a legacy bcrypt hash */
function scryptVerify(password, stored) {
  if (typeof stored !== "string" || !stored) return false;
  if (stored.startsWith("$2")) {
    // a bcrypt hash written by the Express server — unverifiable here
    const err = new Error("legacy bcrypt hash");
    err.name = "BcryptHashError";
    throw err;
  }
  const [tag, n, r, p, saltB64, keyB64] = stored.split("$");
  if (tag !== "scrypt") return false;
  const key = crypto.scryptSync(password, Buffer.from(saltB64, "base64"),
    Buffer.from(keyB64, "base64").length,
    { N: Number(n), r: Number(r), p: Number(p) });
  const expected = Buffer.from(keyB64, "base64");
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// ─── question categories ───────────────────────────────────────────────────
/**
 * An EMPTY list means every category, and is the default.
 *
 * It used to be ["Mixed"], from before the question bank had real categories —
 * a sentinel that named no category and matched nothing. Empty says the same
 * thing without pretending to be a value, and the engine reads both alike so
 * rooms created under the old default still work.
 */
const DEFAULT_CATEGORIES = [];

/** the question bank has 24; the cap is headroom, not a limit anyone meets */
const MAX_CATEGORIES = 32;

/**
 * Whether latecomers may watch a match already in progress.
 *
 * Defaults TRUE. Spectating already shipped and works; defaulting it off would
 * silently switch off a live feature for every room created from here on, and
 * a host who wants a closed table can say so.
 */
const DEFAULT_SPECTATE_ENABLED = true;

/**
 * Normalises the `categories` field off the request body.
 *   missing / null / empty  -> [] (every category)
 *   array of strings        -> trimmed, de-duplicated, capped
 *   anything else           -> null, which the caller turns into a 400
 */
function normalizeCategories(raw) {
  if (raw === undefined || raw === null) return DEFAULT_CATEGORIES;
  if (!Array.isArray(raw)) return null;
  if (raw.some((c) => typeof c !== "string")) return null;
  const cleaned = [...new Set(raw.map((c) => c.trim()).filter(Boolean))].slice(
    0,
    MAX_CATEGORIES
  );
  return cleaned;
}

// ─── room capacity ─────────────────────────────────────────────────────────
const DEFAULT_MAX_PLAYERS = 6;
const MIN_ROOM_CAPACITY = 2;
const MAX_ROOM_CAPACITY = 8;

/**
 * Normalises `maxPlayers`. Deliberately forgiving in the same style as
 * normalizeCategories, with one difference: a bad capacity is CLAMPED rather
 * than rejected, because unlike a category list there is always a sensible
 * number to fall back to and a room is worth creating either way.
 *   missing / not a number / NaN  -> 6
 *   3.7                           -> 3   (floored)
 *   1 / 99                        -> 2 / 8 (clamped)
 */
function normalizeMaxPlayers(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_MAX_PLAYERS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_MAX_PLAYERS;
  return Math.min(MAX_ROOM_CAPACITY, Math.max(MIN_ROOM_CAPACITY, n));
}

// ─── starting coins ────────────────────────────────────────────────────────
const DEFAULT_STARTING_MONEY = 500;
const MIN_STARTING_MONEY = 500;
const MAX_STARTING_MONEY = 2500;

/**
 * Normalises `startingMoney` — what every player is seated with when the match
 * begins. Clamped rather than rejected, exactly like normalizeMaxPlayers:
 *   missing / not a number / NaN  -> 500
 *   300 / 5000                    -> 500 / 2500  (clamped to the range)
 *   1200.9                        -> 1200        (floored)
 *
 * The floor is 500 because it is the stake the whole economy is tuned around:
 * a wrong answer costs 100 and the minimum bet is 10, so a smaller bankroll
 * would make the first mistake close to fatal. The ceiling is 2500 to keep
 * matches finite — every unit of it has to be lost by somebody before the
 * match can end.
 */
function normalizeStartingMoney(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_STARTING_MONEY;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_STARTING_MONEY;
  return Math.min(MAX_STARTING_MONEY, Math.max(MIN_STARTING_MONEY, n));
}

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight, when API Gateway is not answering it for us
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  const identity = await identityFromToken(bearerFrom(event));
  if (!identity) {
    return json(event, 401, { message: "Authentication required" });
  }
  const username = identity.username;

  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(event, 400, { message: "Invalid JSON body" });
  }

  try {
    const {
      playerId, roomName, isPrivate, password, categories, maxPlayers, spectateEnabled,
      startingMoney,
    } = body;
    if (!roomName) {
      return json(event, 400, { error: "Missing required fields" });
    }
    const roomCategories = normalizeCategories(categories);
    // anything but an explicit false leaves watching on
    const roomSpectateEnabled = spectateEnabled === undefined
      ? DEFAULT_SPECTATE_ENABLED
      : Boolean(spectateEnabled);
    if (roomCategories === null) {
      return json(event, 400, {
        error: "categories must be an array of strings",
      });
    }
    const roomMaxPlayers = normalizeMaxPlayers(maxPlayers);
    const roomStartingMoney = normalizeStartingMoney(startingMoney);
    const roomIsPrivate = Boolean(isPrivate);
    if (roomIsPrivate) {
      if (typeof password !== "string" || password.length < 4) {
        return json(event, 400, {
          error: "Private rooms need a password (4+ characters)",
        });
      }
    }
    const passwordHash = roomIsPrivate ? scryptHash(String(password)) : null;

    // creating a lobby costs a credit — the anti-spam throttle
    const wallet = await getWallet(username);
    if (wallet.credits < LOBBY_CREATE_COST) {
      return json(event, 403, {
        error: "Not enough credits",
        credits: wallet.credits,
        nextCreditInMs: msUntilNextCredit(wallet),
      });
    }
    wallet.credits -= LOBBY_CREATE_COST;
    await saveWallet(wallet);

    const roomCode = Math.floor(Math.random() * 900000) + 100000;
    const lobbyId = crypto.randomUUID();
    await ddb.send(
      new PutCommand({
        TableName: LOBBIES_TABLE,
        Item: {
          lobby_id: lobbyId,
          createdAt: new Date().toISOString(),
          /*
           * Who this room belongs to, as a field of its own.
           *
           * Ownership was only ever implicit: every reader — lobbies.mjs,
           * leaveRoom, isHostOf, lobbyStateMessage, the WS state builder —
           * found it by scanning `players` for role "Admin". That works, but
           * it means the answer to "whose room is this" costs a linear search
           * of a nested array at every read, cannot be queried at all, and is
           * lost the moment the roster is rewritten by a join or a leave.
           *
           * Written from the VERIFIED token username, never from the body.
           */
          owner: username,
          roomName: String(roomName),
          code: Number(roomCode),
          isPrivate: roomIsPrivate,
          categories: roomCategories,
          spectateEnabled: roomSpectateEnabled,
          maxPlayers: roomMaxPlayers,
          // what every seat is worth when the match starts. The WebSocket
          // function reads this when it seeds the match state, so the number
          // chosen here is the number the game is actually played with.
          startingMoney: roomStartingMoney,
          ...(passwordHash ? { passwordHash } : {}),
          players: [
            {
              /*
               * `id` used to be String(playerId) — the value the CLIENT put in
               * the body — while `player` beside it was the username off the
               * verified token. Two fields for one thing, and the forgeable
               * one was the one named `id`.
               *
               * Nothing has ever read it: every ownership check in both
               * Lambdas goes through `player` and `role`. So it was a
               * forgeable field with no consumer, which is the kind of thing
               * that stays harmless right up until somebody uses it. Both
               * carry the verified username now.
               */
              id: username,
              player: username,
              role: "Admin",
              points: Number(roomStartingMoney),
              /*
               * When this seat was taken, so succession has something to sort
               * by. The host is by definition the first, but writing it here
               * anyway keeps every seat the same shape — a comparator that has
               * to special-case one entry is a comparator that will eventually
               * get that case wrong.
               */
              joinedAt: Date.now(),
            },
          ],
          // no rounds array — games always run until one player has money
          spectators: [],
        },
      })
    );

    return json(event, 200, {
      message: "Room created",
      roomCode: roomCode,
      lobbyId,
      creditsLeft: wallet.credits,
      // echoed back so the client can show what the clamp actually settled on
      // rather than what it asked for
      startingMoney: roomStartingMoney,
    });
  } catch (err) {
    console.error("Error creating room:", err);
    return json(event, 500, { error: "Failed to create room" });
  }
};
