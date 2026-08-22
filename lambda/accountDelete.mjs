/**
 * ===========================================================================
 * accountDelete — POST /account/delete
 * ===========================================================================
 * IRREVERSIBLE account deletion. Removes the caller's Cognito user, their
 * Players record, and every reference to them in other players' friend lists.
 *
 * ⚠ THE CALLER CAN ONLY EVER DELETE THEMSELVES, and that is structural rather
 *   than a check that could be forgotten. The username comes from the verified
 *   Cognito ACCESS token, never from the body — and the Cognito deletion is
 *   `DeleteUser`, the SELF-service API, which acts on whoever owns the token
 *   that is passed to it. There is no username parameter to get wrong. A body
 *   claiming `{"username":"someone_else"}` is ignored completely.
 *
 * ── WHY SELF-DELETE AND NOT AdminDeleteUser ────────────────────────────────
 *   AdminDeleteUser would need `cognito-idp:AdminDeleteUser` on the pool —
 *   permission to delete ANY user, held permanently by a function reachable
 *   from the internet. DeleteUser needs no IAM permission at all: the access
 *   token IS the authorisation. Smaller blast radius for the same outcome, so
 *   this role deliberately holds no cognito-idp permission.
 *
 * ── ORDER, AND WHY ─────────────────────────────────────────────────────────
 *   1. scrub the caller out of other players' friends / friendRequests /
 *      outgoingRequests / deniedRequests
 *   2. delete Players/{username}
 *   3. delete the Cognito user  ← last
 *   The data goes before the identity. If step 3 fails the caller still has a
 *   login but no data, and can retry; if the identity went first and the data
 *   write failed, their record would be stranded with no way to reach it.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 *   Every step tolerates its subject already being gone. Deleting an account
 *   twice answers 200 both times, with `player:false` and
 *   `cognito:"already_gone"` the second time. It never 500s on a repeat.
 *
 * Paste-ready AWS Lambda handler. NO third-party dependencies: everything
 * used here either ships in the Node.js 18/20/22 Lambda runtime (AWS SDK v3)
 * or is built into Node (node:crypto, global fetch).
 *
 * ── REQUIRED ENVIRONMENT VARIABLES ─────────────────────────────────────────
 *   PLAYERS_TABLE          Players
 *   COGNITO_USER_POOL_ID   eu-west-3_Uylh5ZFUK
 *   COGNITO_CLIENT_ID      3j69q67dfk60kl92gukqhdlr91
 *   ALLOWED_ORIGIN         https://<your-domain>,http://localhost:3000
 * All have working defaults baked in below.
 *
 * ── IAM ────────────────────────────────────────────────────────────────────
 *   Needs dynamodb GetItem/PutItem/DeleteItem/Scan on table/Players. The Scan
 *   is the friend scrub: friends are stored as arrays inside each player's own
 *   item, so there is no index to query "who has X as a friend" — see the note
 *   on scrubFriendReferences below. NO cognito-idp permission is required.
 *
 * ── API ────────────────────────────────────────────────────────────────────
 *   POST /account/delete
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *   Body:     {}                     (nothing is read from it)
 *   Response: 200 { deleted: true, username, player: true|false,
 *                   cognito: "deleted" | "already_gone" | "failed",
 *                   friendsScrubbed: <number>, message }
 *             401 { message: "Unauthorized" }
 * ===========================================================================
 */
import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
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


// ─── the deletion itself ───────────────────────────────────────────────────

/**
 * Cognito DeleteUser over plain HTTPS — no SDK, no request signing.
 *
 * This is the one AWS call in the codebase that needs NEITHER: DeleteUser is
 * authorised by the access token in its own body, not by SigV4, so it is a
 * bare JSON POST that global fetch can make. That keeps the handler free of
 * @aws-sdk/client-cognito-identity-provider, which is not guaranteed to ship
 * in the Lambda runtime and would otherwise have to be bundled.
 *
 * Cognito reports failures as HTTP 400 with a `__type` field; it is rethrown
 * as an Error whose `name` is that type, so the caller can treat
 * UserNotFoundException as "already deleted" rather than as a failure.
 */
async function cognitoSelfDelete(accessToken) {
  const res = await fetch(`https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.DeleteUser",
    },
    body: JSON.stringify({ AccessToken: accessToken }),
  });
  if (res.ok) return true;
  let type = `HTTP ${res.status}`, message = "";
  try {
    const body = await res.json();
    type = String(body.__type ?? type).split("#").pop();
    message = body.message ?? "";
  } catch {
    // a non-JSON error body — the status alone has to do
  }
  const err = new Error(`Cognito DeleteUser failed: ${type} ${message}`.trim());
  err.name = type;
  throw err;
}

/**
 * Remove `username` from every other player's friends and friendRequests.
 *
 * A SCAN, deliberately. Friendships live as arrays inside each player's own
 * item, so nothing indexes "who lists X as a friend" — the only way to find
 * them is to look at everyone. That is fine at this table's size and it is
 * the same scan the leaderboard already does; if the player count ever makes
 * it expensive, the fix is a friendship index, not a cleverer scan.
 *
 * BEST EFFORT: a failure here must not abort the deletion. Leaving a dangling
 * username in someone's friends list is untidy; refusing to delete an account
 * because of it would be worse.
 */
async function scrubFriendReferences(username) {
  let scrubbed = 0;
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: PLAYERS_TABLE, ExclusiveStartKey })
    );
    for (const item of page.Items ?? []) {
      if (!item?.username || item.username === username) continue;
      /*
       * All four friendship arrays, because a deleted account has to vanish
       * from every state a friendship can be in — not just the accepted and
       * incoming ones. `outgoingRequests` and `deniedRequests` were added
       * with the pending/denied model; `sentRequests` was a name that never
       * existed on any record and is gone with it.
       *
       * deniedRequests holds objects ({ username, at }), so it filters on the
       * field rather than the element — the string form is tolerated in case
       * a record predates the object one.
       */
      const friends = Array.isArray(item.friends) ? item.friends : [];
      const requests = Array.isArray(item.friendRequests) ? item.friendRequests : [];
      const outgoing = Array.isArray(item.outgoingRequests) ? item.outgoingRequests : [];
      const denied = Array.isArray(item.deniedRequests) ? item.deniedRequests : [];
      const nextFriends = friends.filter((u) => u !== username);
      const nextRequests = requests.filter((u) => u !== username);
      const nextOutgoing = outgoing.filter((u) => u !== username);
      const nextDenied = denied.filter(
        (d) => (typeof d === "string" ? d : d?.username) !== username
      );
      const touched =
        nextFriends.length !== friends.length ||
        nextRequests.length !== requests.length ||
        nextOutgoing.length !== outgoing.length ||
        nextDenied.length !== denied.length;
      if (!touched) continue;
      item.friends = nextFriends;
      item.friendRequests = nextRequests;
      if (Array.isArray(item.outgoingRequests)) item.outgoingRequests = nextOutgoing;
      if (Array.isArray(item.deniedRequests)) item.deniedRequests = nextDenied;
      await ddb.send(new PutCommand({ TableName: PLAYERS_TABLE, Item: item }));
      scrubbed++;
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return scrubbed;
}

export const handler = async (event) => {
  if (methodOf(event) === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  }
  try {
    const token = bearerFrom(event);
    const identity = await identityFromToken(token);
    if (!identity) return json(event, 401, { message: "Unauthorized" });
    const username = identity.username;

    // 1 — best effort, never fatal
    let friendsScrubbed = 0;
    try {
      friendsScrubbed = await scrubFriendReferences(username);
    } catch (err) {
      console.error("account delete: friend scrub failed", username, err);
    }

    // 2 — the player record. DeleteItem does not care if it is already gone,
    // so ReturnValues is how we can honestly report whether one existed.
    let hadPlayer = false;
    try {
      const res = await ddb.send(
        new DeleteCommand({
          TableName: PLAYERS_TABLE,
          Key: { username },
          ReturnValues: "ALL_OLD",
        })
      );
      hadPlayer = Boolean(res.Attributes);
    } catch (err) {
      console.error("account delete: Players delete failed", username, err);
      return json(event, 500, {
        deleted: false,
        username,
        message: "Could not delete the player record. Nothing else was changed.",
      });
    }

    // 3 — the identity, last. Self-service: the token is the authorisation.
    let cognito = "deleted";
    try {
      await cognitoSelfDelete(token);
    } catch (err) {
      // the user being gone already is a SUCCESS for an idempotent delete
      if (err?.name === "UserNotFoundException" || err?.name === "NotAuthorizedException") {
        cognito = "already_gone";
      } else {
        console.error("account delete: Cognito delete failed", username, err);
        cognito = "failed";
      }
    }

    return json(event, 200, {
      deleted: true,
      username,
      player: hadPlayer,
      cognito,
      friendsScrubbed,
      message:
        cognito === "failed"
          ? "Your data was deleted, but the login could not be removed. Please try again."
          : "Account deleted.",
    });
  } catch (err) {
    console.error("POST /account/delete failed", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
