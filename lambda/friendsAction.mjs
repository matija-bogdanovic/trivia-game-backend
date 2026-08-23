/**
 * ===========================================================================
 * friendsAction — POST /friends/action
 * ===========================================================================
 * Send / accept / decline a friend request, or remove a friend.
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
 *         "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
 *         "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Players" }
 *     ]
 *   }
 *   Plus AWSLambdaBasicExecutionRole for CloudWatch logs.
 *
 * ── API GATEWAY ────────────────────────────────────────────────────────────
 *   Route/Method:  POST /friends/action
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
 * ── CONTRACT ───────────────────────────────────────────────────────────────
 *   Request:  POST /friends/action
 *             { "target": "<username>",
 *               "action": "request" | "accept" | "decline" | "cancel" | "remove" }
 *   Response: 200 { status: "pending" | "accepted" | "denied" | "cancelled"
 *                         | "removed" }
 *             400 { message: "target and action required" | "Unknown action" |
 *                            "That's you" | "User not found" | "Already friends" |
 *                            "Request already sent" | "No such request" |
 *                            "Request recently denied" |        ← cooldown
 *                            "Too many pending requests" |      ← outstanding cap
 *                            "Sending too fast" |               ← hourly rate
 *                            "Please try again" }
 *
 *   The last three are the anti-spam rules; see the ANTI-SPAM block below for
 *   the numbers. A refusal from any of them writes NOTHING — no pending row
 *   and no notification reaches the target.
 *
 *   The status is the STATE the friendship is now in, not the verb used —
 *   "pending" where this once said "sent", "denied" where it said "declined".
 *   `request` may legitimately answer "accepted": if the target had already
 *   asked, the request is taken as accepting theirs.
 *   `cancel` is the sender withdrawing their own pending request.
 *   Auth:     Authorization: Bearer <Cognito ACCESS token>
 *             401 { message: "Authentication required" } when absent/invalid.
 *             The username comes from the verified token, NEVER from the
 *             body, so a client cannot act as another player.
 *
 * IAM: needs dynamodb:UpdateItem on table/Players in addition to GetItem —
 * the writes are a TransactWriteItems of two conditional updates now, not a
 * PutItem of the whole record. The shared role already grants both.
 *
 * Ported from: friendActionHandler in economy.ts + the friends section of
 * game/wallet.ts, then rewritten for the three-state model.
 * ===========================================================================
 */

import crypto from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
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

// ─── wallet core (mirrors src/server/game/wallet.ts) ───────────────────────
const CREDIT_CAP = 5;
const CREDIT_REFILL_MS = 30 * 60 * 1000; // +1 credit every 30 min
const LOBBY_CREATE_COST = 1;

const ACHIEVEMENTS = [
  { id: "first_win", name: "First Blood — win your first game" },
  { id: "streak_10", name: "On Fire — win 10 games in a row" },
  { id: "streak_50", name: "Unstoppable — win 50 games in a row" },
  { id: "streak_100", name: "Legend — win 100 games in a row" },
  { id: "first_bet_win", name: "Gambler — win money on a bet" },
  { id: "bet_500", name: "High Roller — win $500+ on a single bet" },
  { id: "flawless_win", name: "Flawless — win without a single wrong answer" },
  { id: "games_50", name: "Veteran — play 50 games" },
];

// real photo uploads replaced the emoji avatars, so the shop sells credits
const SHOP_ITEMS = [
  { id: "credits3", name: "3 lobby credits", cost: 100, kind: "credits", value: "3" },
];

function freshWallet(username) {
  return {
    username,
    credits: CREDIT_CAP,
    lastRefillAt: Date.now(),
    coins: 0,
    ownedAvatars: [],
    wins: 0,
    gamesPlayed: 0,
    roundsPlayed: 0,
    matchHistory: [],
    points: 0,
    currentStreak: 0,
    bestStreak: 0,
    betsWon: 0,
    achievements: [],
    friends: [],
    friendRequests: [],
    outgoingRequests: [],
    deniedRequests: [],
    requestLog: [],
    avatar: null,
    displayName: null,
  };
}

/** older wallet rows may predate the streak/achievement/history fields */
function withDefaults(w) {
  w.roundsPlayed ??= 0;
  w.matchHistory ??= [];
  w.points ??= 0;
  w.currentStreak ??= 0;
  w.bestStreak ??= 0;
  w.betsWon ??= 0;
  w.achievements ??= [];
  w.friends ??= [];
  w.friendRequests ??= [];
  w.outgoingRequests ??= [];
  w.deniedRequests ??= [];
  w.requestLog ??= [];
  w.avatar ??= null;
  w.displayName ??= null;
  return w;
}

/** applies time-based credit refill in place */
function refill(wallet) {
  const now = Date.now();
  if (wallet.credits >= CREDIT_CAP) {
    wallet.lastRefillAt = now;
    return wallet;
  }
  const earned = Math.floor((now - wallet.lastRefillAt) / CREDIT_REFILL_MS);
  if (earned > 0) {
    wallet.credits = Math.min(CREDIT_CAP, wallet.credits + earned);
    wallet.lastRefillAt =
      wallet.credits >= CREDIT_CAP
        ? now
        : wallet.lastRefillAt + earned * CREDIT_REFILL_MS;
  }
  return wallet;
}

async function getWallet(username) {
  const res = await ddb.send(
    new GetCommand({ TableName: PLAYERS_TABLE, Key: { username } })
  );
  const wallet = withDefaults(res.Item ?? freshWallet(username));
  refill(wallet);
  return wallet;
}

/** like getWallet but returns null instead of inventing a row */
async function getWalletIfExists(username) {
  const res = await ddb.send(
    new GetCommand({ TableName: PLAYERS_TABLE, Key: { username } })
  );
  if (!res.Item) return null;
  const wallet = withDefaults(res.Item);
  refill(wallet);
  return wallet;
}

/*
 * There is deliberately no saveWallet() here any more. Writing the whole
 * record back is what made a friend action able to clobber coins and credits
 * from a stale read; every write in this file is now a conditional update of
 * the friendship attributes alone. See commitPair().
 */

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FRIENDSHIP MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 * A friendship has three states — pending, accepted, denied — and all three
 * are represented on BOTH players' records, so either side can see what the
 * other did. Four arrays on the `Players` item carry it, each one read from
 * the point of view of the player whose item it is:
 *
 *   friends:          string[]            accepted, mirrored on both
 *   friendRequests:   string[]            PENDING, incoming — who asked me
 *   outgoingRequests: string[]            PENDING, outgoing — who I asked
 *   deniedRequests:   [{ username, at }]  DENIED — requests I sent that were
 *                                         turned down, kept rather than
 *                                         deleted so "denied" is
 *                                         distinguishable from "never sent"
 *
 * A pending request writes to two items at once (mine and theirs) and so does
 * every answer to one. `friendRequests` and `outgoingRequests` are the two
 * halves of the same fact and must never disagree — which is why every
 * transition below goes through commitPair().
 *
 * ── WHY THE ARRAYS ARE STILL STRINGS ───────────────────────────────────────
 * Bare usernames, not objects with timestamps. accountDelete.mjs scrubs these
 * arrays by value and POST /wallet hands them to the client as they are, so
 * changing the element type is a change to readers this file does not own.
 * `deniedRequests` is a new array nobody else reads, so it carries the `at`
 * stamp — and it is the only one where a timestamp is actually needed, for
 * the re-request policy noted in sendFriendRequest().
 *
 * ── CONCURRENCY ────────────────────────────────────────────────────────────
 * These used to be read-modify-PutItem of the WHOLE player record. Two
 * overlapping calls lost one of the two writes, and worse, a friend action
 * rewrote coins, credits and match history from a snapshot that could be
 * seconds stale — so accepting a request could roll back a game reward.
 *
 * Now: one TransactWriteItems, updating ONLY the friendship attributes on the
 * two items, each guarded by a ConditionExpression asserting the attribute is
 * still exactly what was read. Nothing else on the record is touched, and a
 * concurrent change to either side aborts the whole transaction rather than
 * half-applying it. ConditionalCheckFailed is retried from a fresh read.
 */

/** how many times a transition re-reads and retries after losing a race */
const MAX_ATTEMPTS = 3;

/**
 * How many denials a player carries. The record is rewritten whole by other
 * routes and DynamoDB caps an item at 400KB, so no array on it may grow
 * without a bound — the same reason matchHistory has MATCH_HISTORY_LIMIT.
 * Oldest denials fall off first; they are the least likely to be re-requested
 * and the least useful to a cooldown.
 */
const DENIED_LIMIT = 50;

/* ═══════════════════════════════════════════════════════════════════════════
 * ANTI-SPAM — every number worth arguing about, in one place
 * ═══════════════════════════════════════════════════════════════════════════
 * All of it is enforced HERE and nowhere else. The client shows the reasons
 * but cannot supply them: the acting username comes from the verified token,
 * the counters live on the server's copy of the record, and a caller who
 * skips the UI entirely meets exactly the same refusals.
 *
 * The two halves answer different abuses. The COOLDOWN stops one person being
 * asked over and over by someone they already turned down — it is per-pair
 * and keyed off the denial the recipient made. The RATE LIMITS stop one
 * account papering a hundred strangers at once — they are per-sender and
 * blind to who the target is. Neither subsumes the other.
 */

/** after a denial, how long before that person may be asked again */
const DENY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** the same, once someone has turned you down repeatedly */
const DENY_COOLDOWN_REPEAT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Denials by the same person needed before the longer cooldown applies.
 * At 2, a first "no" costs a week and a second costs a month — the escalation
 * lands on the person who ignored the first answer, and nobody else.
 */
const DENY_ESCALATE_AFTER = 2;

/**
 * How many requests may be outstanding at once. This is the cap that actually
 * bites a mass-add: pending requests are only cleared by the RECIPIENT
 * answering, so a spammer cannot free up room by waiting.
 */
const MAX_PENDING_OUTGOING = 50;

/** the short window, and how many sends are allowed inside it */
const SEND_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SEND_RATE_MAX = 20;

/**
 * Timestamps kept for the rate check. Only the window matters, so the log is
 * pruned to it on every send; the cap is a floor under a clock that jumps
 * backwards, not a tuning knob.
 */
const REQUEST_LOG_LIMIT = SEND_RATE_MAX * 2;

/**
 * One item's half of a transition: the attributes to set, and the values they
 * must still hold for the write to be allowed.
 *
 * `attribute_not_exists(#k) OR #k = :old` because a record written before
 * these fields existed has no attribute at all, and an absent array and an
 * empty one mean the same thing here.
 */
function updateFor(username, changes) {
  const names = {};
  const values = {};
  const sets = [];
  const conditions = [];

  Object.keys(changes).forEach((key, i) => {
    names[`#k${i}`] = key;
    values[`:new${i}`] = changes[key].next;
    values[`:old${i}`] = changes[key].prev;
    sets.push(`#k${i} = :new${i}`);
    conditions.push(`(attribute_not_exists(#k${i}) OR #k${i} = :old${i})`);
  });

  return {
    Update: {
      TableName: PLAYERS_TABLE,
      Key: { username },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

/** true when a transaction failed only because someone else got there first */
function isConflict(err) {
  const name = err?.name ?? "";
  if (name === "ConditionalCheckFailedException") return true;
  if (name !== "TransactionCanceledException") return false;
  return (err.CancellationReasons ?? []).some(
    (r) => r?.Code === "ConditionalCheckFailed"
  );
}

/**
 * Apply a change to one or both sides of a friendship, atomically.
 *
 * `build(a, b)` gets both freshly-read records and returns either an error
 * string or `{ status, changes: { [username]: { attr: nextValue } } }`. It is
 * called again on a lost race, so it must be a pure function of what it was
 * handed — no state carried between attempts.
 */
async function commitPair(usernameA, usernameB, build) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [a, b] = await Promise.all([
      getWallet(usernameA),
      getWalletIfExists(usernameB),
    ]);
    const outcome = build(a, b);
    if (typeof outcome === "string") return outcome;

    const items = Object.entries(outcome.changes)
      .map(([username, attrs]) => {
        const source = username === usernameA ? a : b;
        const changes = {};
        for (const [attr, next] of Object.entries(attrs)) {
          const prev = source[attr] ?? [];
          // a no-op side would still consume a transaction slot and, worse,
          // could fail its own condition for no reason
          if (JSON.stringify(prev) !== JSON.stringify(next)) {
            changes[attr] = { prev, next };
          }
        }
        return Object.keys(changes).length ? updateFor(username, changes) : null;
      })
      .filter(Boolean);

    if (items.length === 0) return outcome.status;

    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
      return outcome.status;
    } catch (err) {
      if (!isConflict(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      // someone changed one of the two records between the read and the
      // write — read both again and rebuild the decision from what is true now
    }
  }
  return "Please try again";
}

const without = (list, username) =>
  (list ?? []).filter((u) => u !== username);
const withOne = (list, username) =>
  (list ?? []).includes(username) ? [...list] : [...(list ?? []), username];
const withoutDenied = (list, username) =>
  (list ?? []).filter((d) => deniedName(d) !== username);

/** tolerant of the pre-cooldown shape, where an entry was a bare username */
const deniedName = (entry) =>
  typeof entry === "string" ? entry : (entry?.username ?? null);

const findDenial = (list, username) =>
  (list ?? []).find((d) => deniedName(d) === username) ?? null;

/**
 * How long this particular person's denial locks the sender out.
 *
 * `count` is how many times they have said no. One refusal is a week; a
 * second — someone asking again after already being told once — is a month.
 */
function cooldownFor(denial) {
  const count = Number(denial?.count ?? 1);
  return count >= DENY_ESCALATE_AFTER
    ? DENY_COOLDOWN_REPEAT_MS
    : DENY_COOLDOWN_MS;
}

/** epoch ms when this denial stops blocking, or 0 when it never did */
function retryAtFor(denial) {
  const at = Number(denial?.at ?? 0);
  if (!at) return 0;
  return at + cooldownFor(denial);
}

/** the send log, pruned to the window and to a sane length */
function recentSends(log, now) {
  return (log ?? [])
    .filter((t) => typeof t === "number" && now - t < SEND_RATE_WINDOW_MS)
    .slice(-REQUEST_LOG_LIMIT);
}

/** returns "accepted", or an error string */
async function acceptFriendRequest(username, from) {
  return commitPair(username, from, (me, other) => {
    if (!other) return "User not found";
    if (!(me.friendRequests ?? []).includes(from)) return "No such request";
    return {
      status: "accepted",
      changes: {
        [username]: {
          friendRequests: without(me.friendRequests, from),
          friends: withOne(me.friends, from),
        },
        [from]: {
          outgoingRequests: without(other.outgoingRequests, username),
          // accepted: the refusal history stops mattering, and keeping it
          // would hold a cooldown over a friendship that already exists
          deniedRequests: withoutDenied(other.deniedRequests, username),
          friends: withOne(other.friends, username),
        },
      },
    };
  });
}

/**
 * returns "pending"/"accepted", or an error string
 *
 * THE THREE REFUSALS THAT ARE NOT ABOUT THIS REQUEST — the anti-spam rules.
 * They are checked before anything is written, so a blocked send leaves NO
 * trace: no pending row, no notification, nothing on the target's record. The
 * point of a cooldown is that the person who said no does not hear from you
 * again, and creating the row and then hiding it would defeat it.
 *
 * Order matters. The per-pair cooldown is checked first, because "that person
 * turned you down" is a truer reason than "you have sent a lot lately" when
 * both apply, and it is the one the sender can do something about.
 *
 * RE-REQUEST POLICY: a denial may be sent again once its cooldown has run —
 * a week, or a month if that person has turned you down twice. The ledger
 * entry SURVIVES the re-request rather than being cleared, which is what
 * makes the escalation possible: clearing it would reset the count and let a
 * denial-then-wait loop run forever at the shorter interval. It is cleared
 * only when the friendship is actually accepted, where the history stops
 * mattering.
 */
async function sendFriendRequest(from, to) {
  if (from === to) return "That's you";
  const now = Date.now();
  return commitPair(from, to, (me, target) => {
    if (!target) return "User not found";
    if ((me.friends ?? []).includes(to)) return "Already friends";
    // they asked first — taking them up on it is the sensible reading of both
    // people asking, and avoids two pending requests that cancel each other out
    if ((me.friendRequests ?? []).includes(to)) {
      return {
        status: "accepted",
        changes: {
          [from]: {
            friendRequests: without(me.friendRequests, to),
            friends: withOne(me.friends, to),
          },
          [to]: {
            outgoingRequests: without(target.outgoingRequests, from),
            deniedRequests: withoutDenied(target.deniedRequests, from),
            friends: withOne(target.friends, from),
          },
        },
      };
    }
    if ((target.friendRequests ?? []).includes(from)) return "Request already sent";

    /* ── anti-spam, in the order a sender can act on ────────────────────── */

    // 1. did this person already turn you down, and is that still recent?
    const denial = findDenial(me.deniedRequests, to);
    const retryAt = retryAtFor(denial);
    if (retryAt > now) return "Request recently denied";

    // 2. how many are already outstanding? Only the recipient clears these,
    //    so a spammer cannot wait their way back under the cap
    if ((me.outgoingRequests ?? []).length >= MAX_PENDING_OUTGOING) {
      return "Too many pending requests";
    }

    // 3. how many have gone out in the last hour, answered or not
    const sends = recentSends(me.requestLog, now);
    if (sends.length >= SEND_RATE_MAX) return "Sending too fast";

    return {
      status: "pending",
      changes: {
        [from]: {
          outgoingRequests: withOne(me.outgoingRequests, to),
          // the ledger is deliberately NOT cleared here — see the note above
          requestLog: [...sends, now],
        },
        [to]: { friendRequests: withOne(target.friendRequests, from) },
      },
    };
  });
}

/** returns "denied", or an error string */
async function declineFriendRequest(username, from) {
  return commitPair(username, from, (me, other) => {
    if (!(me.friendRequests ?? []).includes(from)) return "No such request";
    const changes = {
      [username]: { friendRequests: without(me.friendRequests, from) },
    };
    /*
     * The denial is recorded on the SENDER — they are the one who has to be
     * told, and the one the cooldown is enforced against when they try again.
     * A sender whose account is gone has nowhere to record it.
     *
     * `count` carries across the rewrite, so a second refusal from the same
     * person reads as a second and earns the longer cooldown. The entry is
     * moved to the end of the list as it is rewritten, which is what makes
     * DENIED_LIMIT drop the stalest denial rather than the most recent one.
     */
    if (other) {
      const previous = findDenial(other.deniedRequests, username);
      changes[from] = {
        outgoingRequests: without(other.outgoingRequests, username),
        deniedRequests: [
          ...withoutDenied(other.deniedRequests, username),
          {
            username,
            at: Date.now(),
            count: Number(previous?.count ?? 0) + 1,
          },
        ].slice(-DENIED_LIMIT),
      };
    }
    return { status: "denied", changes };
  });
}

/** the sender withdrawing their own pending request — returns "cancelled" */
async function cancelFriendRequest(username, to) {
  return commitPair(username, to, (me, target) => {
    if (!(me.outgoingRequests ?? []).includes(to)) return "No such request";
    const changes = {
      [username]: { outgoingRequests: without(me.outgoingRequests, to) },
    };
    if (target) {
      changes[to] = { friendRequests: without(target.friendRequests, username) };
    }
    return { status: "cancelled", changes };
  });
}

/** returns "removed" */
async function removeFriend(username, other) {
  return commitPair(username, other, (me, them) => {
    const changes = { [username]: { friends: without(me.friends, other) } };
    if (them) changes[other] = { friends: without(them.friends, username) };
    return { status: "removed", changes };
  });
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
    const { target, action } = body;
    if (!target || !action) {
      return json(event, 400, { message: "target and action required" });
    }
    const me = username;
    const them = String(target).trim();

    /*
     * The self guard, in front of EVERY action rather than inside one.
     *
     * sendFriendRequest already refused `from === to`, but the other four did
     * not: accept/decline/cancel/remove all went straight to commitPair, which
     * loads the two records and writes them back — and with both names equal
     * that is the same item read twice and written twice, the second write
     * silently undoing the first. Nothing good could come of any of them, and
     * "That's you" is the honest answer to all five.
     */
    if (!them || them === me) {
      return json(event, 400, { message: "That's you" });
    }

    /*
     * Every transition answers with the STATE the friendship is now in, not
     * with the verb that was used to get there — "pending", not "sent";
     * "denied", not "declined". The client reads both spellings, so this is
     * safe to change without a flag day, and a status vocabulary that matches
     * the stored one is what makes the two describable in the same words.
     */
    const RUN = {
      request: sendFriendRequest,
      accept: acceptFriendRequest,
      decline: declineFriendRequest,
      cancel: cancelFriendRequest,
      remove: removeFriend,
    };
    const run = RUN[action];
    if (!run) return json(event, 400, { message: "Unknown action" });

    const result = await run(me, them);
    const SUCCESS = ["pending", "accepted", "denied", "cancelled", "removed"];
    if (!SUCCESS.includes(result)) {
      // every non-status return is one of the refusal strings the handlers
      // above produce, and each is a bad request rather than a server fault
      return json(event, 400, { message: result });
    }
    return json(event, 200, { status: result });
  } catch (err) {
    console.error("friend action error:", err);
    return json(event, 500, { message: "Internal server error" });
  }
};
