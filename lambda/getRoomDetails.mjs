/**
 * ===========================================================================
 * getRoomDetails — POST /getRoomDetails
 * ===========================================================================
 * The raw lobby record for a room code. Public, as in Express.
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
 *         "Action": ["dynamodb:Query"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies/index/code-index" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /getRoomDetails
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
 *   Request:  POST /getRoomDetails   { "roomCode": 123456 }
 *   Response: 200 <the raw Lobbies item>
 *             400 { message: "Invalid or missing roomCode" }
 *             404 { message: "Room not found" }
 *
 * ── NOTE ───────────────────────────────────────────────────────────────────
 *   This returns the lobby item verbatim, exactly as Express does — which
 *   includes `passwordHash` for a private room. It was already like that;
 *   it is called out here because it is worth fixing (project the fields
 *   you need instead of returning the whole item). Left unchanged so the
 *   contract matches.
 *
 * Ported from: getRoomDetails in src/server/apis/get_lobby_details.ts
 * ===========================================================================
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
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

  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(event, 400, { message: "Invalid JSON body" });
  }

  try {
    const { roomCode } = body;
    if (!roomCode || isNaN(Number(roomCode))) {
      return json(event, 400, { message: "Invalid or missing roomCode" });
    }

    const items = await queryByKey(LOBBIES_TABLE, "code", Number(roomCode), "code-index");
    if (items.length === 0) {
      return json(event, 404, { message: "Room not found" });
    }
    return json(event, 200, items[0]);
  } catch (err) {
    console.error("Error getting room details:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
