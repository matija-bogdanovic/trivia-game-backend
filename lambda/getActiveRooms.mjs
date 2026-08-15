/**
 * ===========================================================================
 * getActiveRooms — GET /getActiveRooms
 * ===========================================================================
 * How many lobbies are currently joinable. Public.
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
 *         "Action": ["dynamodb:Scan"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  GET /getActiveRooms
 *   Integration:   Lambda proxy integration (HTTP API payload 2.0, or REST
 *                  "Use Lambda Proxy integration" — this handler reads both).
 *   binaryMediaTypes: not needed — request and response are both JSON.
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
 *   Request:  GET /getActiveRooms
 *   Response: 200 { roundCount: <number> }
 *             500 { message: "Internal Server Error" }   (note the capitals)
 *
 * ── ⚠ DEGRADED vs THE EXPRESS SERVER ───────────────────────────────────────
 *   Counts the same degraded list as lobbies.mjs — see that file. Without
 *   the live game server the count is "lobbies created in the last hour"
 *   rather than "lobbies with players in them".
 *
 * Ported from: getActiveRooms in src/server/apis/get/get_lobby_count.ts
 * ===========================================================================
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
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
  return event.requestContext?.http?.method || event.httpMethod || "GET";
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

const FRESH_LOBBY_MS = 60 * 60 * 1000;

/** identical to listActiveLobbies() in lobbies.mjs — keep the two in sync */
async function listActiveLobbies() {
  const scan = await ddb.send(
    new ScanCommand({
      TableName: LOBBIES_TABLE,
      ProjectionExpression:
        "lobby_id, code, roomName, players, createdAt, isPrivate, #st, maxPlayers",
      ExpressionAttributeNames: { "#st": "state" },
    })
  );
  return (scan.Items ?? [])
    .filter((l) => l.state !== "finished")
    .map((l) => ({
      phase: "lobby",
      isLive: false,
      // roster length, not live sockets — see the note in lobbies.mjs
      playerCount: Array.isArray(l.players) ? l.players.length : 0,
      // carried for parity with lobbies.mjs; this route only returns a count,
      // so it is not surfaced — keep it so the two stay literally in sync
      maxPlayers: Number(l.maxPlayers ?? 6),
      createdAt: l.createdAt ?? null,
    }))
    .filter((l) => {
      if (l.phase !== "lobby" && l.phase !== "countdown") return false;
      // a room with a roster never ages out; only EMPTY rooms do
      if (l.playerCount > 0) return true;
      const age = Date.now() - new Date(l.createdAt ?? 0).getTime();
      return age < FRESH_LOBBY_MS;
    })
    .slice(0, 20);
}

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight, when API Gateway is not answering it for us
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  try {
    const lobbies = await listActiveLobbies();
    return json(event, 200, { roundCount: lobbies.length });
  } catch (err) {
    console.error("Failed to get lobby count:", err);
    return json(event, 500, { message: "Internal Server Error" });
  }
};
