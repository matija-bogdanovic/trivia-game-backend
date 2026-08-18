/**
 * ===========================================================================
 * avatarUpload — POST /avatar
 * ===========================================================================
 * Stores the player's profile picture in S3 and stamps the wallet's avatar
 * pointer. The pointer write is what makes the new picture actually appear —
 * the frontend reads it off the wallet and appends the version as ?v=.
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
 *   AVATAR_BUCKET          ipak-se-okrece-avatars
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
 *         "Action": ["s3:PutObject"],
 *         "Resource": "arn:aws:s3:::ipak-se-okrece-avatars/avatars/*" },
 *       { "Effect": "Allow",
 *         "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Players" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /avatar
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
 *   Request:  POST /avatar   { "image": "data:image/jpeg;base64,..." }
 *             jpeg | png | webp, data URL at most 700 000 chars (~500 KB)
 *   Response: 200 { avatar: "u|<epoch-ms>" }
 *             400 { message: "Image missing or too large" }
 *             400 { message: "Unsupported image format" }
 *             500 { message: "Internal server error" }
 *   Side effects: s3://ipak-se-okrece-avatars/avatars/{username}.jpg
 *                 Players.avatar = "u|<epoch-ms>"
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * ── NOTE ───────────────────────────────────────────────────────────────────
 *   The wallet pointer is written with a targeted UpdateExpression rather
 *   than the Express getWallet/saveWallet round-trip. Same end state, but a
 *   whole-item rewrite can clobber a coins/streak write from a match
 *   finishing at the same moment. If the player has no wallet row yet the
 *   conditional update fails and the full default row is created — those
 *   defaults mirror freshWallet() in src/server/game/wallet.ts, so keep the
 *   two in sync.
 *
 * Ported from: uploadAvatarHandler in src/server/apis/avatars.ts
 * ===========================================================================
 */

import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const AVATAR_BUCKET = process.env.AVATAR_BUCKET || "ipak-se-okrece-avatars";
const PLAYERS_TABLE = process.env.PLAYERS_TABLE || "Players";

// clients at module scope so warm invocations reuse the connections
const s3 = new S3Client({ region: REGION });
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

// uploads arrive as a browser-downscaled 256x256 JPEG data URL
const MAX_DATA_URL_LENGTH = 700_000; // ~500 KB decoded
const CREDIT_CAP = 5;

/** mirrors freshWallet() in src/server/game/wallet.ts */
function freshWallet(username, avatar) {
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
    avatar,
    displayName: null,
  };
}

/** writes only the avatar attribute; creates the row if the player has none */
async function setAvatarPointer(username, avatar) {
  const update = (guarded) =>
    ddb.send(
      new UpdateCommand({
        TableName: PLAYERS_TABLE,
        Key: { username },
        UpdateExpression: "SET avatar = :avatar",
        ExpressionAttributeValues: { ":avatar": avatar },
        ...(guarded ? { ConditionExpression: "attribute_exists(username)" } : {}),
      })
    );

  try {
    await update(true);
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
    try {
      await ddb.send(
        new PutCommand({
          TableName: PLAYERS_TABLE,
          Item: freshWallet(username, avatar),
          ConditionExpression: "attribute_not_exists(username)",
        })
      );
    } catch (putErr) {
      if (putErr?.name !== "ConditionalCheckFailedException") throw putErr;
      // lost the race against a wallet created in between — just set the field
      await update(false);
    }
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
    const { image } = body;
    if (typeof image !== "string" || image.length > MAX_DATA_URL_LENGTH) {
      return json(event, 400, { message: "Image missing or too large" });
    }
    const match = image.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!match) {
      return json(event, 400, { message: "Unsupported image format" });
    }

    const bytes = Buffer.from(match[2], "base64");
    await s3.send(
      new PutObjectCommand({
        Bucket: AVATAR_BUCKET,
        // url-encoded so a username with a space or slash cannot reshape the
        // key; the extension stays .jpg even for png/webp because the key is
        // an identity pointer, not a filename
        Key: `avatars/${encodeURIComponent(username)}.jpg`,
        Body: bytes,
        ContentType: `image/${match[1]}`,
      })
    );

    // the wallet is the source of truth for the avatar pointer — no Cognito
    // attribute write needed (federated tokens can't do those without extra
    // scopes)
    const avatar = `u|${Date.now()}`;
    await setAvatarPointer(username, avatar);

    return json(event, 200, { avatar });
  } catch (err) {
    console.error("avatar upload error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
