/**
 * ===========================================================================
 * myActiveRoom — POST /myActiveRoom
 * ===========================================================================
 * "You dropped out of a live game — rejoin?" prompt on the home screen.
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
 *   COGNITO_USER_POOL_ID   eu-west-3_Uylh5ZFUK
 *   COGNITO_CLIENT_ID      3j69q67dfk60kl92gukqhdlr91
 *   ALLOWED_ORIGIN         https://<your-vercel-domain>,http://localhost:3000
 *   AWS_REGION             set automatically by Lambda — do NOT add it by hand
 *                          (Lambda rejects reserved env var names).
 * Every one has a working default baked in below, so the function runs even
 * with no env vars set. Setting them is still the right thing to do.
 *
 * ── IAM (inline policy on this function's execution role) ──────────────────
 *   None beyond AWSLambdaBasicExecutionRole (CloudWatch logs).
 *   This function touches no AWS resource at all.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /myActiveRoom
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
 *   Request:  POST /myActiveRoom   (no body)
 *   Response: 200 { room: { code, lobbyId, roomName, phase } | null }
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * ── ⚠ DEGRADED vs THE EXPRESS SERVER ───────────────────────────────────────
 *   ⚠⚠ THIS ENDPOINT ALWAYS RETURNS { room: null } IN LAMBDA. ⚠⚠
 *   It is the one route with NO database behind it at all: findDroppedGame()
 *   walks the live in-memory room map looking for a seat belonging to a
 *   disconnected player, and that map only exists inside the running
 *   WebSocket game server. There is nothing to read in DynamoDB.
 *
 *   Deploying this Lambda is therefore only useful to keep the route from
 *   404-ing while the rest of the API moves — the reconnect prompt will
 *   simply never appear. If you want the prompt to work, the route has to
 *   stay on the Express host, or the live room state has to move to
 *   DynamoDB first. See docs/websocket-game-later.md.
 *
 * Ported from: myActiveRoomHandler in economy.ts + findDroppedGame in game/manager.ts
 * ===========================================================================
 */

import crypto from "node:crypto";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";

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

  // Nothing to query: the answer lives in the game server's memory.
  // See the DEGRADED note at the top of this file.
  return json(event, 200, { room: null });
};
