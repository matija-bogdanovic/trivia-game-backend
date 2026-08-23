/**
 * ===========================================================================
 * notifications — POST /notifications  ·  POST /notifications/read
 * ===========================================================================
 * The durable half of the bell. The socket delivers a notification the moment
 * it happens; this is how it is still there tomorrow.
 *
 * Own notifications only — the username comes from the verified access token
 * and is never read from the body, so there is no way to ask for somebody
 * else's feed.
 *
 * ── TWO ROUTES, ONE FILE ───────────────────────────────────────────────────
 *   POST /notifications        -> { notifications: [...], unread: n }
 *   POST /notifications/read   -> { ok: true }   body: { id } or { all: true }
 *
 * They share the token verification, the CORS headers and the client, and
 * splitting them would mean maintaining that scaffolding twice for two reads
 * of the same table.
 *
 * ── NEWEST FIRST, AND ONLY A WINDOW ────────────────────────────────────────
 * ScanIndexForward:false walks the sort key backwards, which is what makes
 * "the 50 most recent" a Query rather than a fetch-and-sort. 50 because the
 * bell is a thing you glance at — anybody wanting their whole history wants a
 * page, and there is no such screen.
 *
 * ── THE UNREAD COUNT IS DERIVED ────────────────────────────────────────────
 * Counted from the window rather than kept as a number on the Players item. A
 * stored counter has to be incremented by every writer and decremented by
 * every reader, and the first time one of those paths fails the badge lies
 * permanently. Counting fifty booleans costs nothing.
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ─────────────────────────────────────────
 *   NOTIFICATIONS_TABLE    Notifications
 *   COGNITO_USER_POOL_ID   eu-west-3_Uylh5ZFUK
 *   COGNITO_CLIENT_ID      3j69q67dfk60kl92gukqhdlr91
 *   ALLOWED_ORIGIN         https://<domain>,http://localhost:3000
 *
 * ── IAM ────────────────────────────────────────────────────────────────────
 *   dynamodb:Query, dynamodb:UpdateItem on table/Notifications
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
const NOTIFICATIONS_TABLE =
  process.env.NOTIFICATIONS_TABLE || "Notifications";
/** the bell shows a window, not an archive — see create_notifications_table.mjs */
const FEED_LIMIT = 50;

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

// ─── handler ───────────────────────────────────────────────────────────────
export const handler = async (event) => {
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

  const path = event.rawPath || event.path || "";
  const marking = /\/read\/?$/.test(path);

  try {
    if (marking) return await markRead(event, username, body);
    return await listFeed(event, username);
  } catch (err) {
    console.error("notifications failed", username, err);
    return json(event, 500, { message: "Could not read notifications" });
  }
};

/** the newest window, newest first, with the unread count over that window */
async function listFeed(event, username) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "username" },
      ExpressionAttributeValues: { ":u": username },
      ScanIndexForward: false,
      Limit: FEED_LIMIT,
    })
  );

  const notifications = (res.Items ?? []).map((item) => ({
    id: item.notification_id,
    kind: item.kind,
    at: item.at,
    read: Boolean(item.read),
    data: item.data ?? {},
  }));

  return json(event, 200, {
    notifications,
    unread: notifications.filter((n) => !n.read).length,
  });
}

/**
 * Mark one, or every unread one in the window.
 *
 * "All" walks the same window the feed returns rather than the whole
 * partition: those are the ones the reader was shown, so those are the ones
 * they can have meant. Already-read rows are skipped, so the common case —
 * pressing it twice — writes nothing.
 */
async function markRead(event, username, body) {
  const one = typeof body?.id === "string" ? body.id.trim() : "";

  if (one) {
    await setRead(username, one);
    return json(event, 200, { ok: true, marked: 1 });
  }

  if (!body?.all) {
    return json(event, 400, { message: "id or all required" });
  }

  const res = await ddb.send(
    new QueryCommand({
      TableName: NOTIFICATIONS_TABLE,
      KeyConditionExpression: "#u = :u",
      ExpressionAttributeNames: { "#u": "username", "#r": "read" },
      ExpressionAttributeValues: { ":u": username, ":false": false },
      FilterExpression: "#r = :false",
      ScanIndexForward: false,
      Limit: FEED_LIMIT,
    })
  );

  const unread = res.Items ?? [];
  await Promise.all(unread.map((i) => setRead(username, i.notification_id)));
  return json(event, 200, { ok: true, marked: unread.length });
}

/**
 * The condition is what makes this safe to call for a row that may not exist:
 * a bad id from a stale tab updates nothing instead of creating a phantom
 * notification, because UpdateItem would otherwise happily insert one.
 */
async function setRead(username, notificationId) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: NOTIFICATIONS_TABLE,
        Key: { username, notification_id: notificationId },
        UpdateExpression: "SET #r = :true",
        ConditionExpression: "attribute_exists(notification_id)",
        ExpressionAttributeNames: { "#r": "read" },
        ExpressionAttributeValues: { ":true": true },
      })
    );
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
  }
}
