/**
 * ===========================================================================
 * leaderboard — GET /leaderboard
 * ===========================================================================
 * Top 20 players by points, then wins. Public.
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
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Players" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  GET /leaderboard
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
 *   Request:  GET /leaderboard
 *   Response: 200 { leaderboard: [{ username, displayName, avatar, wins, gamesPlayed,
 *                                   coins, points, currentStreak, bestStreak }] }
 *
 * ── NOTE ───────────────────────────────────────────────────────────────────
 *   This is a full table Scan, exactly as the Express version does. It reads
 *   at most 1 MB per call and does NOT paginate, so once Players grows past
 *   ~1 MB the leaderboard silently considers only the first page. That is
 *   pre-existing behaviour, carried over unchanged — see lambda/README.md.
 *
 * Ported from: leaderboardHandler in src/server/apis/economy.ts
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

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
  // CORS preflight, when API Gateway is not answering it for us
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  try {
    const scan = await ddb.send(new ScanCommand({ TableName: PLAYERS_TABLE }));
    const top = (scan.Items ?? [])
      .map((w) => ({
        username: w.username,
        displayName: w.displayName ?? w.username,
        // the whole row is already in hand from the scan, so carrying the
        // avatar costs nothing — and without it the podium and every table
        // row could only ever draw an initial
        avatar: w.avatar ?? null,
        wins: w.wins ?? 0,
        gamesPlayed: w.gamesPlayed ?? 0,
        coins: w.coins ?? 0,
        points: w.points ?? 0,
        currentStreak: w.currentStreak ?? 0,
        bestStreak: w.bestStreak ?? 0,
      }))
      .filter((w) => w.gamesPlayed > 0)
      .sort((a, b) => b.points - a.points || b.wins - a.wins)
      .slice(0, 20);
    return json(event, 200, { leaderboard: top });
  } catch (err) {
    console.error("leaderboard error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
