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
 *                               isLive, createdAt, owner, host, categories }] }
 *   `owner` is the room's owner as createRoom recorded it; `host` is the same
 *   person derived from the roster, kept for clients that already read it.
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
  BatchGetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const LOBBIES_TABLE = process.env.LOBBIES_TABLE || "Lobbies";
const GAME_STATE_TABLE = process.env.GAME_STATE_TABLE || "GameState";
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || "Connections";

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

/**
 * How long a room with NOBODY CONNECTED stays listed.
 *
 * Two hours, and the number is not arbitrary: it is the Connections table's
 * own TTL. A socket row survives two hours past its socket, so "no live
 * connection for longer than that" is the same statement as "no trace of
 * anybody here outlived them".
 *
 * It also covers the gap at the other end. A room is created over REST and
 * the socket connects a moment later, so a brand-new room legitimately has no
 * connection yet; anything younger than this is given the benefit of the
 * doubt rather than hidden the instant it appears.
 */
const STALE_LOBBY_MS = 2 * 60 * 60 * 1000;
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
/**
 * Which rooms have a match actually running.
 *
 * The `phase` this route used to report was the literal string "lobby" for
 * every room, from before there was a turn engine to ask — so the browse list
 * could not tell a room waiting for players from one three rounds deep.
 *
 * GameState is the authority: one item per room, keyed by lobbyId. A room with
 * no state has never started; one sitting in "lobby" or "gameover" is not
 * playing. BatchGet rather than a Get per room, because the whole list is
 * wanted at once and a browse page should be one round trip, not N.
 */
async function runningPhases(lobbyIds) {
  const phases = new Map();
  // BatchGetItem takes 100 keys per call
  for (let i = 0; i < lobbyIds.length; i += 100) {
    const chunk = lobbyIds.slice(i, i + 100);
    if (!chunk.length) continue;
    try {
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [GAME_STATE_TABLE]: {
              Keys: chunk.map((lobbyId) => ({ lobbyId })),
              ProjectionExpression: "lobbyId, phase",
            },
          },
        })
      );
      for (const item of res.Responses?.[GAME_STATE_TABLE] ?? []) {
        phases.set(String(item.lobbyId), String(item.phase ?? "lobby"));
      }
    } catch (err) {
      // a browse list that cannot read the phase is still a browse list —
      // every room falls back to "waiting", which is what it showed before
      console.error("lobby phase lookup failed:", err);
    }
  }
  return phases;
}

/** green means join in, yellow means it started without you */
function statusFor(phase) {
  if (!phase || phase === "lobby" || phase === "countdown") return "waiting";
  if (phase === "gameover") return "waiting";
  return "playing";
}

/**
 * Every lobby with at least one socket open on it, right now.
 *
 * One Scan of a small table: Connections holds one row per LIVE socket under a
 * two-hour TTL, so it is tens of items rather than millions — the same reason
 * friendsList.mjs scans it, and it says so there too.
 *
 * A failure returns an EMPTY set rather than throwing, and that direction is
 * deliberate: with no presence information every room falls back to the age
 * test, so a browse page degrades to "recently created rooms" instead of
 * failing outright. Showing a slightly stale list beats showing an error.
 */
async function lobbiesWithLiveSockets() {
  try {
    const res = await ddb.send(
      new ScanCommand({
        TableName: CONNECTIONS_TABLE,
        ProjectionExpression: "lobbyId",
      })
    );
    return new Set(
      (res.Items ?? [])
        .map((row) => (row.lobbyId ? String(row.lobbyId) : null))
        .filter(Boolean)
    );
  } catch (err) {
    console.error("presence scan failed; falling back to age alone", err);
    return new Set();
  }
}

/**
 * Rooms nobody has been connected to for longer than STALE_LOBBY_MS.
 *
 * Deleted rather than merely hidden, because nothing else will ever do it:
 * Lobbies has no TTL, there is no scheduled sweeper, and every other delete
 * path needs a person to press something. A hidden row is a row that stays
 * forever.
 *
 * Best effort, and never awaited by the response — a browse page must not get
 * slower or fail because a tidy-up did. It is idempotent and bounded by what
 * this listing already read, so a concurrent invocation racing it costs a
 * duplicate delete of a row that is going anyway.
 */
function sweepStale(rows, live) {
  const now = Date.now();
  const doomed = rows.filter((l) => {
    if (live.has(String(l.lobby_id))) return false;
    return now - new Date(l.createdAt ?? 0).getTime() > STALE_LOBBY_MS;
  });
  if (!doomed.length) return;
  console.log(`sweeping ${doomed.length} abandoned lobby row(s)`);
  for (const l of doomed) {
    ddb
      .send(
        new DeleteCommand({
          TableName: LOBBIES_TABLE,
          Key: { lobby_id: String(l.lobby_id) },
        })
      )
      .catch((err) => console.error("sweep failed for", l.lobby_id, err));
  }
}

async function listActiveLobbies() {
  const scan = await ddb.send(
    new ScanCommand({
      TableName: LOBBIES_TABLE,
      ProjectionExpression:
        "lobby_id, code, roomName, players, createdAt, isPrivate, #st, #cat, maxPlayers, startingMoney, spectateEnabled, #own",
      // OWNER is a DynamoDB reserved word, so it can only be projected through
      // an expression-attribute name — an unaliased `owner` is a runtime
      // ValidationException, not something the console catches at paste time
      ExpressionAttributeNames: {
        "#st": "state",
        "#cat": "categories",
        "#own": "owner",
      },
    })
  );
  const rows = (scan.Items ?? []).filter((l) => l.state !== "finished");
  /*
   * Both reads go out together. They do not need each other's answer, and a
   * browse page should be one round trip's worth of waiting rather than two.
   */
  const [phases, live] = await Promise.all([
    runningPhases(rows.map((l) => String(l.lobby_id))),
    lobbiesWithLiveSockets(),
  ]);

  // fire and forget; see sweepStale on why the response never waits for it
  sweepStale(rows, live);

  return rows
    .map((l) => {
      const phase = phases.get(String(l.lobby_id)) ?? null;
      const players = Array.isArray(l.players) ? l.players : [];
      const host = players.find((p) => p?.role === "Admin");
      return {
        lobbyId: String(l.lobby_id),
        code: Number(l.code),
        roomName: l.roomName ?? `Room ${l.code}`,
        isPrivate: Boolean(l.isPrivate),
        /*
         * Still the ROSTER, which is the right number for "how many seats are
         * taken" — a player who refreshes has not freed their seat. Whether
         * anyone is actually THERE is a separate question, and it is now
         * answered by the presence set rather than by this count; see the
         * filter below.
         */
        playerCount: players.length,
        // rooms created before maxPlayers existed have no attribute — 6 was
        // the hardcoded cap they were created under, so it is the right default
        maxPlayers: Number(l.maxPlayers ?? DEFAULT_MAX_PLAYERS),
        // the stake this room is played for, so the join screen can show it
        // before anyone commits a credit to entering
        startingMoney: Number(l.startingMoney ?? DEFAULT_STARTING_MONEY),
        // the real phase now, from GameState — this was hardcoded "lobby"
        phase: phase ?? "lobby",
        status: statusFor(phase),
        isLive: statusFor(phase) === "playing",
        // whether latecomers may watch; rooms created before the flag existed
        // predate the toggle and were all watchable, so absent means true
        spectateEnabled: l.spectateEnabled === undefined
          ? true
          : Boolean(l.spectateEnabled),
        createdAt: l.createdAt ?? null,
        /*
         * Who the room belongs to.
         *
         * `owner` is the field createRoom writes; `host` is the same person
         * found the old way, by scanning the roster for role "Admin".
         *
         * Both are returned, and owner falls back to host, for two different
         * reasons. Rooms written before the field existed have no `owner`, so
         * the scan is what answers for them. And `host` is what the deployed
         * frontend already reads — dropping it would blank the listing on any
         * client that has not shipped yet.
         */
        owner: l.owner ? String(l.owner) : host ? String(host.player) : null,
        host: host ? String(host.player) : null,
        categories: Array.isArray(l.categories)
          ? l.categories.map(String)
          : ["Mixed"],
      };
    })
    .filter((l) => {
      if (l.phase !== "lobby" && l.phase !== "countdown") return false;

      /*
       * ── PRESENCE, NOT THE ROSTER ──────────────────────────────────────────
       *
       * This used to read `if (l.playerCount > 0) return true` — a room with
       * anybody on its roster was listed forever. That looks right and leaks,
       * because a ROSTER SEAT AND A PRESENT PLAYER ARE NOT THE SAME THING.
       *
       * onDisconnect deliberately keeps the seat: "a disconnect is not a
       * departure", so that an ordinary page refresh does not read as someone
       * walking out. Correct — and it means a seat outlives its socket
       * indefinitely, because only an explicit leave, kick or terminate ever
       * removes one. The connection row expires in two hours; the seat never
       * does; the lobby row has no TTL at all.
       *
       * A room was found sitting in the browse list twenty-nine hours after
       * its only occupant closed the tab, advertising a free seat in a game
       * nobody was in.
       *
       * So the question asked here is whether anyone is CONNECTED, which is
       * what the doc comment above this file's helpers said all along — that
       * arm was degraded because it needed the live game server to answer.
       * Presence lives in DynamoDB now, so it can be asked again.
       */
      if (live.has(String(l.lobbyId))) return true;
      const age = Date.now() - new Date(l.createdAt ?? 0).getTime();
      return age < STALE_LOBBY_MS;
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
