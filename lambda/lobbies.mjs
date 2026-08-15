/**
 * ===========================================================================
 * lobbies — GET /lobbies
 * ===========================================================================
 * The joinable-lobby list behind the Join Room screen. Public.
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
 *   Route/Method:  GET /lobbies
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
 *   Request:  GET /lobbies
 *   Response: 200 { lobbies: [{ lobbyId, code, roomName, isPrivate,
 *                               playerCount, maxPlayers, startingMoney, phase,
 *                               isLive, createdAt, host, categories }] }
 *   Free seats are playerCount subtracted from maxPlayers. Rooms created
 *   before maxPlayers existed report 6, the cap they were created under.
 *
 * ── ⚠ PARTIALLY DEGRADED vs THE EXPRESS SERVER ─────────────────────────────
 *   phase is always "lobby" and isLive always false: the Express version
 *   fills those from getLiveRoomSummaries(), the live WebSocket room map in
 *   the game server's memory, which a Lambda cannot see.
 *
 *   playerCount is NOT degraded any more. It is the length of the `players`
 *   roster in DynamoDB — everyone who joined through POST /joinRoom. That
 *   differs from the Express number, which counts sockets connected RIGHT
 *   NOW; a player who joined and closed their tab still counts here.
 *
 *   The filter follows from that: a room with a non-empty roster stays
 *   listed regardless of age, and only EMPTY rooms age out after an hour.
 *   Previously the "has players" arm was gated on isLive, which is always
 *   false here, so a room full of players vanished an hour after creation.
 *   Sort order and the 20-item cap are unchanged.
 *   See docs/websocket-game-later.md.
 *
 * Ported from: lobbiesHandler + listActiveLobbies in src/server/apis/economy.ts
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
/** capacity for rooms written before `maxPlayers` was a stored field */
const DEFAULT_MAX_PLAYERS = 6;
/** stake for rooms written before `startingMoney` was a stored field */
const DEFAULT_STARTING_MONEY = 500;

/**
 * The single definition of an "active" lobby, shared with getActiveRooms.mjs:
 * joinable (waiting/countdown) AND either someone is connected right now or it
 * was created within the last hour. The "connected right now" arm needs the
 * live game server — see the DEGRADED note above.
 */
async function listActiveLobbies() {
  const scan = await ddb.send(
    new ScanCommand({
      TableName: LOBBIES_TABLE,
      ProjectionExpression:
        "lobby_id, code, roomName, players, createdAt, isPrivate, #st, #cat, maxPlayers, startingMoney",
      ExpressionAttributeNames: { "#st": "state", "#cat": "categories" },
    })
  );
  return (scan.Items ?? [])
    .filter((l) => l.state !== "finished")
    .map((l) => {
      const players = Array.isArray(l.players) ? l.players : [];
      const host = players.find((p) => p?.role === "Admin");
      return {
        lobbyId: String(l.lobby_id),
        code: Number(l.code),
        roomName: l.roomName ?? `Room ${l.code}`,
        isPrivate: Boolean(l.isPrivate),
        // the roster in DynamoDB is the only player source a Lambda has; the
        // live "connected right now" count needs the game server (Phase 2)
        playerCount: players.length,
        // rooms created before maxPlayers existed have no attribute — 6 was
        // the hardcoded cap they were created under, so it is the right default
        maxPlayers: Number(l.maxPlayers ?? DEFAULT_MAX_PLAYERS),
        // the stake this room is played for, so the join screen can show it
        // before anyone commits a credit to entering
        startingMoney: Number(l.startingMoney ?? DEFAULT_STARTING_MONEY),
        phase: "lobby",
        isLive: false,
        createdAt: l.createdAt ?? null,
        host: host ? String(host.player) : null,
        categories: Array.isArray(l.categories)
          ? l.categories.map(String)
          : ["Mixed"],
      };
    })
    .filter((l) => {
      if (l.phase !== "lobby" && l.phase !== "countdown") return false;
      // a room with a roster stays listed however old it is — it is only
      // EMPTY rooms that age out. Keying this off isLive (always false here)
      // is what used to make a busy room vanish an hour after creation.
      if (l.playerCount > 0) return true;
      const age = Date.now() - new Date(l.createdAt ?? 0).getTime();
      return age < FRESH_LOBBY_MS;
    })
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime()
    )
    .slice(0, 20);
}

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight, when API Gateway is not answering it for us
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  try {
    return json(event, 200, { lobbies: await listActiveLobbies() });
  } catch (err) {
    console.error("lobbies error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
