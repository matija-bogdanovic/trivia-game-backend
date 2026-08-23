/**
 * ===========================================================================
 * friendsList — POST /friends/list
 * ===========================================================================
 * The player's friends and incoming friend requests.
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
 *         "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Players" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /friends/list
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
 * ── CONTRACT ───────────────────────────────────────────────────────────────
 *   Request:  POST /friends/list   (no body)
 *   Response: 200 {
 *               friends:  [{ username, displayName, online, points,
 *                            currentStreak, wins }],
 *               requests: [{ username, displayName, status: "pending",
 *                            createdAt }],
 *               outgoing: [{ username, displayName,
 *                            status: "pending" | "denied",
 *                            createdAt, updatedAt, retryAt }]
 *             }
 *
 *   `retryAt` is epoch ms — when a denied person may be asked again, from the
 *   cooldown friendsAction enforces. null on a pending row, and on a denial
 *   old enough to have expired.
 *
 *   `requests` is what was sent TO me and `outgoing` is what I sent — the two
 *   halves of pending, so both sides of a request can see it. A denied
 *   request stays in `outgoing` with status "denied" rather than vanishing,
 *   which is what makes "they said no" different from "you never asked".
 *
 *   ⚠ `requests` used to be an array of bare username STRINGS. It is objects
 *   now. The client reads both forms (helpers/friends.ts), so the two can be
 *   deployed in either order.
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * ── ⚠ DEGRADED vs THE EXPRESS SERVER ───────────────────────────────────────
 *   `online` is ALWAYS false here. The Express version answers it from
 *   isUserOnline(), which reads the live WebSocket room map held in the game
 *   server's memory — a Lambda has no access to that. Everything else in the
 *   response is exact. See docs/websocket-game-later.md.
 *
 * Ported from: friendsListHandler in src/server/apis/economy.ts
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  ScanCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const PLAYERS_TABLE = process.env.PLAYERS_TABLE || "Players";
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || "Connections";
const GAME_STATE_TABLE = process.env.GAME_STATE_TABLE || "GameState";

/*
 * Mirrors of the cooldown rule in friendsAction.mjs — this route only reports
 * when a denial expires, it never enforces anything. Keep the two in step;
 * friendsAction is the authority and the only place a request is refused.
 */
const DENY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const DENY_COOLDOWN_REPEAT_MS = 30 * 24 * 60 * 60 * 1000;
const DENY_ESCALATE_AFTER = 2;

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
    outgoingRequests: [],
    deniedRequests: [],
    requestLog: [],
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
  w.outgoingRequests ??= [];
  w.deniedRequests ??= [];
  w.requestLog ??= [];
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

// ─── handler ───────────────────────────────────────────────────────────────
/**
 * Where everybody currently holding a socket is, and what they are doing.
 *
 * `online` used to be the literal `false` for every friend, because presence
 * lived in the Express server's memory and a Lambda could not see it. It lives
 * in the Connections table now, so it can.
 *
 * FOUR STATES, and the distinction that matters is the last one:
 *   offline     no live socket
 *   online      connected, but no match running in their room — a lobby, or
 *               a room that has finished
 *   playing     a match is running and they are IN it
 *   spectating  a match is running in their room and they are NOT in it,
 *               which is exactly what a spectator is (see lambda-ws)
 *
 * One Scan of Connections rather than a query per friend: the table holds one
 * row per LIVE SOCKET, so it is a handful of items, and there is no username
 * index to query anyway. Then one GetItem per DISTINCT lobby — friends tend to
 * be in the same room, so that collapses further.
 *
 * Never throws. Presence is decoration on a friends list; a failure here
 * degrades everyone to offline rather than failing the request.
 */
async function presenceByUsername() {
  const where = new Map();
  try {
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName: CONNECTIONS_TABLE,
          ProjectionExpression: "username, lobbyId",
          ExclusiveStartKey,
        })
      );
      for (const row of page.Items ?? []) {
        if (row?.username) where.set(String(row.username), row.lobbyId ?? null);
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  } catch (err) {
    console.error("presence scan failed:", err);
    return new Map();
  }

  const lobbyIds = [...new Set([...where.values()].filter(Boolean))].map(String);
  const matches = new Map();
  await Promise.all(
    lobbyIds.map(async (lobbyId) => {
      try {
        const res = await ddb.send(
          new GetCommand({
            TableName: GAME_STATE_TABLE,
            Key: { lobbyId },
            ProjectionExpression: "phase, players",
          })
        );
        if (res.Item) matches.set(lobbyId, res.Item);
      } catch {
        // this lobby's status is simply unknown; its members read as online
      }
    })
  );

  const status = new Map();
  for (const [username, lobbyId] of where) {
    const state = lobbyId ? matches.get(String(lobbyId)) : null;
    const running = state && state.phase !== "lobby" && state.phase !== "gameover";
    if (!running) {
      status.set(username, "online");
      continue;
    }
    const seated = (state.players ?? []).some((p) => p?.username === username);
    status.set(username, seated ? "playing" : "spectating");
  }
  return status;
}

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

  try {
    const me = await getWallet(username);
    const presence = await presenceByUsername();

    /*
     * One read per name, and a name can appear in only one of the three
     * lists, so nobody is fetched twice. The lookup is for displayName: the
     * arrays store usernames, and a username is not what anyone should be
     * shown when the player has chosen a name.
     */
    const nameOf = async (name) => {
      const w = await getWalletIfExists(name);
      return { w, displayName: w?.displayName ?? name };
    };

    const [friends, incoming, outgoing] = await Promise.all([
      Promise.all(
        (me.friends ?? []).map(async (name) => {
          const { w, displayName } = await nameOf(name);
          const status = presence.get(name) ?? "offline";
          return {
            username: name,
            displayName,
            status,
            // kept so a client that predates `status` keeps working; it is
            // now truthful rather than hardcoded false
            online: status !== "offline",
            points: w?.points ?? 0,
            currentStreak: w?.currentStreak ?? 0,
            wins: w?.wins ?? 0,
          };
        })
      ),
      // requests sent TO me, awaiting my answer
      Promise.all(
        (me.friendRequests ?? []).map(async (name) => ({
          username: name,
          displayName: (await nameOf(name)).displayName,
          status: "pending",
          // the pending arrays hold bare usernames; only a denial is stamped
          createdAt: null,
        }))
      ),
      /*
       * My own half: what I have asked for and not yet been answered on, and
       * what was turned down. Both belong here because both are things only I
       * can see about myself — the recipient's copy of a pending request is
       * their `friendRequests`, and a denial is recorded on the sender alone.
       */
      Promise.all([
        ...(me.outgoingRequests ?? []).map(async (name) => ({
          username: name,
          displayName: (await nameOf(name)).displayName,
          status: "pending",
          createdAt: null,
          updatedAt: null,
          retryAt: null,
        })),
        /*
         * A name can be in BOTH lists: the ledger entry survives a
         * re-request, because the denial count is what escalates the
         * cooldown. Pending is the live state and wins — the denial behind it
         * is history, not something to show twice.
         */
        ...(me.deniedRequests ?? [])
          .filter((entry) => {
            const name = typeof entry === "string" ? entry : entry?.username;
            return name && !(me.outgoingRequests ?? []).includes(name);
          })
          .map(async (entry) => {
            const name = typeof entry === "string" ? entry : entry?.username;
            const at = typeof entry?.at === "number" ? entry.at : null;
            const count = Number(entry?.count ?? 1);
            // the same rule friendsAction enforces, mirrored so the screen can
            // say WHEN rather than only that it was refused
            const cooldown =
              count >= DENY_ESCALATE_AFTER
                ? DENY_COOLDOWN_REPEAT_MS
                : DENY_COOLDOWN_MS;
            return {
              username: name,
              displayName: (await nameOf(name)).displayName,
              status: "denied",
              createdAt: null,
              updatedAt: at,
              /** epoch ms this person may be asked again; null = right now */
              retryAt: at ? at + cooldown : null,
            };
          }),
      ]),
    ]);

    return json(event, 200, {
      friends: friends.sort(
        (a, b) => Number(b.online) - Number(a.online) || b.points - a.points
      ),
      requests: incoming,
      // pending first, then the denials, newest denial first
      outgoing: outgoing
        .filter(Boolean)
        .sort(
          (a, b) =>
            Number(a.status === "denied") - Number(b.status === "denied") ||
            (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        ),
    });
  } catch (err) {
    console.error("friends list error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
