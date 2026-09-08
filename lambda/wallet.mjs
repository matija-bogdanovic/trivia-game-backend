/**
 * ===========================================================================
 * wallet — POST /wallet
 * ===========================================================================
 * The player's wallet, stats, achievements catalog and shop.
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
 *   Route/Method:  POST /wallet
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
 *   Request:  POST /wallet   { "displayName"?: "...",   (optional rename)
 *                              "googlePicture"?: "https://…" }
 *                              — adopted as the avatar only when there is none
 *   Response: 200 { credits, coins, avatar, ownedAvatars, wins, gamesPlayed,
 *                  roundsPlayed, matchHistory, points, currentStreak,
 *                  currentLosingStreak, longestLosingStreak,
 *                  bestStreak, achievements, achievementCatalog,
 *                  nextCreditInMs, shop }
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * Ported from: walletHandler in src/server/apis/economy.ts
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || "ipak-se-okrece-avatars";
const s3 = new S3Client({ region: REGION });
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
    currentLosingStreak: 0,
    longestLosingStreak: 0,
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
  w.currentLosingStreak ??= 0;
  w.longestLosingStreak ??= 0;
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


/**
 * Take a copy of a federated profile picture, instead of pointing at it.
 *
 * ── WHY NOT JUST STORE THE URL ─────────────────────────────────────────────
 * Because Google rate-limits it. lh3.googleusercontent.com answers 429 to a
 * client that asks too often, and "too often" is a lobby: six tiles, each an
 * <img> at Google's CDN, re-requested on every render and every reconnect.
 * The browser then draws a broken image with the alt text spilling out of the
 * frame, which is exactly what it was doing.
 *
 * Hotlinking is also a promise somebody else can break. That URL rotates when
 * the user changes their Google picture, and nothing tells us — a stored
 * pointer would rot silently.
 *
 * So the picture is fetched ONCE, on the sign-in that adopts it, and written
 * to the same bucket and the same key an uploaded avatar uses. From then on it
 * is served by GET /avatar/img/<username> like any other, with our caching and
 * no third party in the path.
 *
 * Returns the "u|<version>" pointer, or null — a picture that will not
 * download is not a reason to fail a wallet load, and the caller leaves the
 * avatar unset so the initials render and the next sign-in tries again.
 */
async function adoptRemotePicture(username, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      console.error("picture fetch failed", username, res.status);
      return null;
    }

    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      console.error("picture was not an image", username, type);
      return null;
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    // a Google avatar at =s96-c is a few KB; anything far larger is not the
    // thing we asked for, and this is written to a bucket we pay for
    if (bytes.length === 0 || bytes.length > 2_000_000) {
      console.error("picture had an implausible size", username, bytes.length);
      return null;
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: AVATAR_BUCKET,
        // the SAME key an upload uses, so a later upload simply overwrites
        // this and there is only ever one avatar object per player
        Key: `avatars/${encodeURIComponent(username)}.jpg`,
        Body: bytes,
        ContentType: type,
      })
    );

    return `u|${Date.now()}`;
  } catch (err) {
    console.error("picture adoption failed", username, err?.name ?? err);
    return null;
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
    /*
     * ── THE ROW IS WRITTEN HERE, OR IT IS NEVER WRITTEN AT ALL ─────────────
     *
     * There is no signup Lambda: an account is created in Cognito by the
     * client, and nothing server-side hears about it. This route is the first
     * thing a signed-in app calls, so it is the only place a Players row can
     * come into existence.
     *
     * It did not create one. getWallet() INVENTS a fresh wallet when the item
     * is missing and returns it, and the two saveWallet() calls below are both
     * conditional — one on adopting a Google picture, one on a display name
     * that differs. A plain email-and-password signup sends neither, so the
     * invented row was serialised into the response and thrown away, every
     * single time.
     *
     * The effect was a person who had signed up, could sign in, and did not
     * exist: no leaderboard entry, nothing for a friend request to find, no
     * avatar to store. The accounts that DO have rows all got them some other
     * way — playing a match writes one from createRoom/joinRoom, and a Google
     * sign-in sends a display name, which is why the federated accounts and
     * the ones with games behind them are the only rows in the table.
     *
     * So: if it was not there, persist it now, before anything conditional.
     */
    const existing = await getWalletIfExists(username);
    const wallet = existing ?? withDefaults(freshWallet(username));
    if (!existing) await saveWallet(wallet);

    /*
     * A Google picture, adopted ONLY when there is nothing to lose.
     *
     * The client sends the `picture` claim from its ID token after a federated
     * sign-in. It is written as the avatar only when the player has none —
     * never over one they uploaded, never over an emoji they picked, and never
     * over a Google URL already stored, so re-signing in does not churn the
     * record. A default is what somebody gets before they choose; the moment
     * they choose, this stops having an opinion.
     *
     * Stored as "g|<url>" beside the existing "u|<version>" and
     * "e|<emoji>|<hue>" so the one decoder on the client keeps being the one
     * decoder. Only https is accepted and the length is capped: this string is
     * rendered as an <img src> by every screen that shows a player, and it
     * arrives from a token rather than from anything this service controls.
     */
    const picture = body.googlePicture;
    if (
      !wallet.avatar &&
      typeof picture === "string" &&
      picture.startsWith("https://") &&
      picture.length <= 500
    ) {
      /*
       * Copied, not linked. See adoptRemotePicture — Google rate-limits its
       * CDN, and a lobby full of <img> tags pointed at it is exactly the
       * traffic that triggers it.
       *
       * A failure leaves the avatar unset rather than storing a pointer we
       * know will break: the initials render, and the next sign-in tries
       * again, because this runs on every wallet load.
       */
      const pointer = await adoptRemotePicture(username, picture);
      if (pointer) {
        wallet.avatar = pointer;
        await saveWallet(wallet);
      }
    }

    const displayName = body.displayName;
    if (
      typeof displayName === "string" &&
      displayName.trim() &&
      wallet.displayName !== displayName.trim().slice(0, 50)
    ) {
      wallet.displayName = displayName.trim().slice(0, 50);
      await saveWallet(wallet);
    }
    return json(event, 200, {
      credits: wallet.credits,
      coins: wallet.coins,
      avatar: wallet.avatar,
      ownedAvatars: wallet.ownedAvatars,
      wins: wallet.wins,
      gamesPlayed: wallet.gamesPlayed,
      roundsPlayed: wallet.roundsPlayed,
      matchHistory: wallet.matchHistory,
      points: wallet.points,
      currentStreak: wallet.currentStreak,
      // the mirror of the win streak, written by the same match-end pass in
      // lambda-ws/lib/results.mjs. Returned so a screen can show it; nothing
      // renders it yet
      currentLosingStreak: wallet.currentLosingStreak,
      longestLosingStreak: wallet.longestLosingStreak,
      bestStreak: wallet.bestStreak,
      achievements: wallet.achievements,
      achievementCatalog: ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name })),
      nextCreditInMs: msUntilNextCredit(wallet),
      shop: SHOP_ITEMS,
    });
  } catch (err) {
    console.error("wallet error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
