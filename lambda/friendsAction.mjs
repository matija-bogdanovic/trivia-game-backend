/**
 * ===========================================================================
 * friendsAction — POST /friends/action
 * ===========================================================================
 * Send / accept / decline a friend request, or remove a friend.
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
 *   WALLETS_TABLE          Wallets
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
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Wallets" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /friends/action
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
 *   Request:  POST /friends/action
 *             { "target": "<username>",
 *               "action": "request" | "accept" | "decline" | "remove" }
 *   Response: 200 { status: "sent" | "accepted" | "declined" | "removed" }
 *             400 { message: "target and action required" | "Unknown action" |
 *                            "That's you" | "User not found" | "Already friends" |
 *                            "Request already sent" | "No such request" }
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * Ported from: friendActionHandler in economy.ts + the friends section of game/wallet.ts
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
const WALLETS_TABLE = process.env.WALLETS_TABLE || "Wallets";

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
    new GetCommand({ TableName: WALLETS_TABLE, Key: { username } })
  );
  const wallet = withDefaults(res.Item ?? freshWallet(username));
  refill(wallet);
  return wallet;
}

/** like getWallet but returns null instead of inventing a row */
async function getWalletIfExists(username) {
  const res = await ddb.send(
    new GetCommand({ TableName: WALLETS_TABLE, Key: { username } })
  );
  if (!res.Item) return null;
  const wallet = withDefaults(res.Item);
  refill(wallet);
  return wallet;
}

async function saveWallet(wallet) {
  await ddb.send(new PutCommand({ TableName: WALLETS_TABLE, Item: wallet }));
}

/** returns "accepted", or an error string */
async function acceptFriendRequest(username, from) {
  const me = await getWallet(username);
  if (!me.friendRequests.includes(from)) return "No such request";
  const other = await getWalletIfExists(from);
  if (!other) return "User not found";
  me.friendRequests = me.friendRequests.filter((u) => u !== from);
  if (!me.friends.includes(from)) me.friends.push(from);
  if (!other.friends.includes(username)) other.friends.push(username);
  await Promise.all([saveWallet(me), saveWallet(other)]);
  return "accepted";
}

/** returns "sent"/"accepted", or an error string */
async function sendFriendRequest(from, to) {
  if (from === to) return "That's you";
  const target = await getWalletIfExists(to);
  if (!target) return "User not found";
  if (target.friends.includes(from)) return "Already friends";

  const me = await getWallet(from);
  // they already asked us — treat this as an accept
  if (me.friendRequests.includes(to)) return acceptFriendRequest(from, to);
  if (target.friendRequests.includes(from)) return "Request already sent";
  target.friendRequests.push(from);
  await saveWallet(target);
  return "sent";
}

async function declineFriendRequest(username, from) {
  const me = await getWallet(username);
  me.friendRequests = me.friendRequests.filter((u) => u !== from);
  await saveWallet(me);
}

async function removeFriend(username, other) {
  const me = await getWallet(username);
  me.friends = me.friends.filter((u) => u !== other);
  await saveWallet(me);
  const them = await getWalletIfExists(other);
  if (them) {
    them.friends = them.friends.filter((u) => u !== username);
    await saveWallet(them);
  }
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
    const { target, action } = body;
    if (!target || !action) {
      return json(event, 400, { message: "target and action required" });
    }
    const me = username;
    const them = String(target);

    if (action === "request") {
      const result = await sendFriendRequest(me, them);
      if (result !== "sent" && result !== "accepted") {
        return json(event, 400, { message: result });
      }
      return json(event, 200, { status: result });
    }
    if (action === "accept") {
      const result = await acceptFriendRequest(me, them);
      if (result !== "accepted") return json(event, 400, { message: result });
      return json(event, 200, { status: result });
    }
    if (action === "decline") {
      await declineFriendRequest(me, them);
      return json(event, 200, { status: "declined" });
    }
    if (action === "remove") {
      await removeFriend(me, them);
      return json(event, 200, { status: "removed" });
    }
    return json(event, 400, { message: "Unknown action" });
  } catch (err) {
    console.error("friend action error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
