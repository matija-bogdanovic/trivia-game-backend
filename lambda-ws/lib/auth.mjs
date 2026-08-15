/**
 * ===========================================================================
 * lib/auth.mjs — Cognito access-token verification + scrypt room passwords
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import crypto from "node:crypto";
import { REGION } from "./config.mjs";

// ─── Cognito access-token verification (no dependencies) ───────────────────
// Copied verbatim from lambda/wallet.mjs. If you change it, change it there
// too — or better, move both to the single Lambda authorizer described in
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

// ─── private-room passwords: scrypt, not bcrypt ────────────────────────────
// Same story as lambda/joinRoom.mjs — bcrypt is a native module and cannot be
// pasted into the console, so rooms created by the Lambda REST stack carry a
// scrypt hash. A room created by the old Express server carries a bcrypt hash
// that is unverifiable here; that case is reported honestly rather than as a
// wrong password. Format: scrypt$<N>$<r>$<p>$<salt-b64>$<hash-b64>
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;

/** returns true/false, or throws BcryptHashError for a legacy bcrypt hash */
function scryptVerify(password, stored) {
  if (typeof stored !== "string" || !stored) return false;
  if (stored.startsWith("$2")) {
    const err = new Error("legacy bcrypt hash");
    err.name = "BcryptHashError";
    throw err;
  }
  const [tag, n, r, p, saltB64, keyB64] = stored.split("$");
  if (tag !== "scrypt") return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = crypto.scryptSync(
    password,
    Buffer.from(saltB64, "base64"),
    expected.length,
    { N: Number(n) || SCRYPT_N, r: Number(r) || SCRYPT_R, p: Number(p) || SCRYPT_P }
  );
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export {
  identityFromToken,
  publicKeyForKid,
  scryptVerify,
};
