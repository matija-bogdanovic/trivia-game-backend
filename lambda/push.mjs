/**
 * ===========================================================================
 * push — POST /push/subscribe  ·  POST /push/unsubscribe
 * ===========================================================================
 * Where a browser registers to be woken when the app is closed.
 *
 * A PushSubscription is minted by the browser, not by us: it is an endpoint
 * URL on the push service (FCM, Mozilla, Apple) plus two keys the service
 * never sees — p256dh, the browser's public key, and auth, a shared secret.
 * Together they are what lets a payload be encrypted so only that browser can
 * read it. We store them and can never read a message we send.
 *
 * ── KEYED BY ENDPOINT, NOT BY PERSON ───────────────────────────────────────
 * One row per BROWSER. A player with a phone and a laptop has two, and both
 * should buzz. The username rides along as an attribute and is read through
 * the username-index GSI when something is worth sending.
 *
 * ── SUBSCRIBE IS AN UPSERT ─────────────────────────────────────────────────
 * The browser hands back the same endpoint every time until it decides
 * otherwise, and the app re-registers on every load. So this overwrites: it
 * refreshes the keys (they rotate), and it re-points the row at the current
 * user, which is what makes a shared computer behave — sign out, sign in as
 * someone else, and that browser's notifications follow the new person
 * instead of the old one.
 *
 * ── UNSUBSCRIBE IS NOT THE ONLY WAY A ROW DIES ─────────────────────────────
 * Most die on send: a push service answering 404 or 410 means the browser
 * threw the subscription away, and notify's sender deletes the row then. This
 * route is the polite path — the user turning it off in Settings.
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ─────────────────────────────────────────
 *   PUSH_SUBSCRIPTIONS_TABLE   PushSubscriptions
 *   COGNITO_USER_POOL_ID       eu-west-3_Uylh5ZFUK
 *   COGNITO_CLIENT_ID          3j69q67dfk60kl92gukqhdlr91
 *   ALLOWED_ORIGIN             https://<domain>,http://localhost:3000
 *
 * ── IAM ────────────────────────────────────────────────────────────────────
 *   dynamodb:PutItem, dynamodb:DeleteItem on table/PushSubscriptions
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const PUSH_TABLE =
  process.env.PUSH_SUBSCRIPTIONS_TABLE || "PushSubscriptions";
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

/** the path this invocation is for, however the gateway spells it */
function routeOf(event) {
  const raw =
    event?.requestContext?.http?.path ??
    event?.rawPath ??
    event?.path ??
    "";
  return String(raw).replace(/^\/prod/, "");
}

/**
 * Is this the shape a browser's PushSubscription.toJSON() produces?
 *
 * Checked rather than trusted: these three strings are fed straight into the
 * encryption, and a malformed p256dh throws inside a crypto call at SEND
 * time — in a different Lambda, on somebody else's notification. Refusing it
 * here turns that into a 400 on the request that caused it.
 */
function readSubscription(body) {
  const endpoint = body?.subscription?.endpoint ?? body?.endpoint;
  const p256dh = body?.subscription?.keys?.p256dh ?? body?.p256dh;
  const auth = body?.subscription?.keys?.auth ?? body?.auth;

  if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) {
    return { error: "endpoint must be an https URL" };
  }
  if (endpoint.length > 2048) return { error: "endpoint is implausibly long" };
  if (typeof p256dh !== "string" || typeof auth !== "string") {
    return { error: "keys.p256dh and keys.auth are required" };
  }
  // 65 raw bytes base64url, and 16 — the sizes the Push API always produces
  if (Buffer.from(p256dh, "base64url").length !== 65) {
    return { error: "p256dh is not a 65-byte P-256 point" };
  }
  if (Buffer.from(auth, "base64url").length !== 16) {
    return { error: "auth is not a 16-byte secret" };
  }
  return { subscription: { endpoint, p256dh, auth } };
}

export const handler = async (event) => {
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }

  const identity = await identityFromToken(bearerFrom(event));
  if (!identity) {
    return json(event, 401, { message: "Authentication required" });
  }

  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(event, 400, { message: "Invalid JSON body" });
  }

  const path = routeOf(event);

  try {
    if (path.endsWith("/unsubscribe")) {
      const endpoint = body?.subscription?.endpoint ?? body?.endpoint;
      if (typeof endpoint !== "string") {
        return json(event, 400, { message: "endpoint is required" });
      }
      /*
       * Deleted by endpoint alone, with no check that it belonged to the
       * caller. That is deliberate and safe: an endpoint is an unguessable
       * URL the push service minted, so holding one IS the credential, and
       * the only way to hold somebody else's is to already be the browser it
       * was issued to. Requiring a match would instead break the case that
       * matters — a browser whose row is still pointed at whoever used it
       * last, trying to turn itself off.
       */
      await ddb.send(
        new DeleteCommand({ TableName: PUSH_TABLE, Key: { endpoint } })
      );
      return json(event, 200, { ok: true });
    }

    const { subscription, error } = readSubscription(body);
    if (error) return json(event, 400, { message: error });

    await ddb.send(
      new PutCommand({
        TableName: PUSH_TABLE,
        Item: {
          endpoint: subscription.endpoint,
          username: identity.username,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          /*
           * Two letters, and the only reason they are here: a service worker
           * cannot read localStorage, where the app keeps the language, so
           * the worker is told which one to word the banner in. Still no
           * SENTENCE is stored — the wording belongs to the client, and a
           * translated string in this table would be frozen in whichever
           * language happened to be current when it was written.
           */
          lang: body?.lang === "en" ? "en" : "sr",
          createdAt: Date.now(),
        },
      })
    );
    return json(event, 200, { ok: true });
  } catch (err) {
    console.error("push subscription error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
