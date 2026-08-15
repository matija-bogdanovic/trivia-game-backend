/**
 * ===========================================================================
 * leaveRoom — POST /leaveRoom
 * ===========================================================================
 * Removes the player from a lobby's roster. If the admin leaves, the next
 * player inherits the room.
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
 *         "Action": ["dynamodb:UpdateItem"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies" },
 *       { "Effect": "Allow",
 *         "Action": ["dynamodb:Query"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies/index/code-index" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /leaveRoom
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
 *   Request:  POST /leaveRoom   { "code": 123456 }
 *   Response: 200 { message: "User removed from room", player: "<username>" }
 *             404 { message: "User not found in any room" }
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * Ported from: leaveRoom in src/server/apis/post/room_operations/leave_room.ts
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const LOBBIES_TABLE = process.env.LOBBIES_TABLE || "Lobbies";

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

/**
 * Query a table by partition key, optionally through a secondary index.
 * Mirrors queryByKey() in src/server/helpers/query_db.ts, with one fix: the
 * original builds the placeholder name out of the VALUE
 * (`${keyName} = :${keyValue}`), which throws a ValidationException as soon
 * as the value contains a '.', '-' or a space — e.g. any username that isn't
 * plain alphanumeric. A constant ':val' behaves identically otherwise.
 */
async function queryByKey(tableName, keyName, keyValue, indexName) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      ...(indexName ? { IndexName: indexName } : {}),
      KeyConditionExpression: `${keyName} = :val`,
      ExpressionAttributeValues: { ":val": keyValue },
    })
  );
  return res.Items ?? [];
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
    const { code } = body;
    const scanResult = await queryByKey(LOBBIES_TABLE, "code", Number(code), "code-index");
    if (!scanResult[0] || scanResult[0].players.length === 0) {
      return json(event, 404, { message: "User not found in any room" });
    }
    const room = scanResult[0];

    const leavingPlayer = room.players.find((p) => p.player === username);
    if (!leavingPlayer) {
      return json(event, 404, { message: "User not found in any room" });
    }

    const isAdmin = leavingPlayer.role === "Admin";

    // THE HOST LEAVING CLOSES THE ROOM. The room does not survive its host and
    // is not inherited by the next player — deleting the item is what makes it
    // vanish from GET /lobbies and stops anyone joining a hostless room.
    //
    // The WS `leave` handler is what tells the other players (it broadcasts
    // room_closed); this route cannot, because posting to a WebSocket
    // connection needs execute-api:ManageConnections on the *other* API. The
    // frontend's leaveRoom() sends the WS `leave` AND calls this route, so
    // both halves run. Each is idempotent and order-independent: deleting an
    // already-deleted item succeeds, and the broadcast reads Connections, not
    // Lobbies.
    if (isAdmin) {
      await ddb.send(
        new DeleteCommand({
          TableName: LOBBIES_TABLE,
          Key: { lobby_id: String(room.lobby_id) },
        })
      );
      return json(event, 200, {
        message: "Room closed",
        player: username,
        roomClosed: true,
        reason: "host_left",
      });
    }

    const updatedPlayers = room.players.filter((p) => p.player !== username);

    await ddb.send(
      new UpdateCommand({
        TableName: LOBBIES_TABLE,
        Key: { lobby_id: String(room.lobby_id) },
        UpdateExpression: "SET players = :updatedPlayers",
        ExpressionAttributeValues: { ":updatedPlayers": updatedPlayers },
      })
    );

    return json(event, 200, {
      message: "User removed from room",
      player: username,
      roomClosed: false,
    });
  } catch (err) {
    console.error("Error in leaveRoom:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
