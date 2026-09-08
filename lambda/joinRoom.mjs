/**
 * ===========================================================================
 * joinRoom — POST /joinRoom
 * ===========================================================================
 * Adds the player to a lobby's roster (password-checked if private).
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
 *   Route/Method:  POST /joinRoom
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
 *   Request:  POST /joinRoom   { "roomCode": 123456, "id": "<playerId>",
 *                                "password"?: "..." }
 *   Response: 200 { lobbyId }
 *             400 { message: "Invalid room code" | "Invalid or missing player ID" }
 *             401 { message: "password_required" }
 *             403 { message: "wrong_password" }
 *             404 { message: "Room not found" }
 *             409 { message: "room_full" }
 *             500 { message: "Server error" }
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * ── ⚠ DEGRADED vs THE EXPRESS SERVER ───────────────────────────────────────
 *   The full-room check. Express asks isLiveRoomFull() first — the live
 *   in-memory seat count — and only falls back to the stored roster length.
 *   A Lambda has no live count, so only the stored roster is used. A player
 *   who left mid-game without the roster being rewritten still occupies a
 *   seat here. The cap is the room's own `maxPlayers`, falling back to 6 for
 *   rooms written before that field existed.
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
 * Ported from: joinRoom in src/server/apis/post/room_operations/join_room.ts
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
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

/** fallback capacity for rooms written before `maxPlayers` was a stored field */
const MAX_PLAYERS = 6;

/** a room's seat count — the stored capacity, or the old hardcoded 6 */
function capacityOf(room) {
  const n = Math.floor(Number(room?.maxPlayers));
  return Number.isFinite(n) && n > 0 ? n : MAX_PLAYERS;
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
    const { roomCode, id, password } = body;
    if (isNaN(roomCode)) {
      return json(event, 400, { message: "Invalid room code" });
    }

    const items = await queryByKey(LOBBIES_TABLE, "code", Number(roomCode), "code-index");
    const data = items[0];
    if (!data) return json(event, 404, { message: "Room not found" });

    const primaryKey = data.lobby_id;
    const players = data.players || [];
    const playerExists = players.some((p) => p.player === username);

    // members who already joined don't re-enter the password
    if (data.isPrivate && !playerExists) {
      if (typeof password !== "string" || password.length === 0) {
        return json(event, 401, { message: "password_required" });
      }
      let ok;
      try {
        ok = scryptVerify(password, data.passwordHash ?? "");
      } catch (err) {
        if (err?.name === "BcryptHashError") {
          // room created by the Express server — see the ⚠ note in the header
          console.error(
            "legacy bcrypt passwordHash on lobby",
            primaryKey,
            "— this room cannot be joined through Lambda; recreate it"
          );
          return json(event, 500, { message: "legacy_password_hash" });
        }
        throw err;
      }
      if (!ok) return json(event, 403, { message: "wrong_password" });
    }

    if (playerExists) return json(event, 200, { lobbyId: primaryKey });
    if (players.length >= capacityOf(data)) {
      return json(event, 409, { message: "room_full" });
    }
    if (!id || typeof id !== "string") {
      return json(event, 400, { message: "Invalid or missing player ID" });
    }

    await ddb.send(
      new UpdateCommand({
        TableName: LOBBIES_TABLE,
        Key: { lobby_id: String(primaryKey) },
        UpdateExpression:
          "SET players = list_append(if_not_exists(players, :emptyList), :newPlayerList)",
        ExpressionAttributeValues: {
          ":newPlayerList": [
            {
              // the verified username, as in createRoom — `id` used to be the
              // value the client put in the body, beside a `player` taken from
              // the token. Nothing reads it; nothing should be able to forge it
              // either.
              id: username,
              player: username,
              /*
               * When this seat was taken. This is what decides who inherits
               * the room if the host walks out: the longest-present player
               * left, which is the fairest answer available and the only one
               * that does not need a vote.
               */
              joinedAt: Date.now(),
              // the room's own starting stake, not a hardcoded 500 — otherwise
              // a joiner shows a different bankroll in the lobby from the host
              // who created it. Rooms written before the setting existed have
              // no attribute and fall back to what they were created under.
              points: Number(data.startingMoney ?? 500),
              role: String("Member"),
            },
          ],
          ":emptyList": [],
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return json(event, 200, { lobbyId: primaryKey });
  } catch (err) {
    console.error("Something went wrong:", err);
    return json(event, 500, { message: "Server error" });
  }
};
