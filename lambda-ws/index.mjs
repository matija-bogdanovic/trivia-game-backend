/**
 * ===========================================================================
 * ipakseokrece — WebSocket Lambda  (through P2.3: the picking-phase modes)
 * ===========================================================================
 * ONE function behind an API Gateway **WebSocket** API, wired to all three
 * routes ($connect / $disconnect / $default). It is deliberately separate from
 * the REST function in `lambda/` — different event shape, different response
 * contract, different IAM.
 *
 * No third-party dependencies: everything imported ships inside the Lambda
 * Node.js runtime (AWS SDK v3) or is built into Node (node:crypto, fetch).
 *
 * ⚠ THIS IS NO LONGER A SINGLE PASTEABLE FILE. It was ~2.5k lines and 120KB;
 *   it is now this entry point plus `lib/`, deployed as a MULTI-FILE ZIP from
 *   the CLI. The console's inline editor cannot paste a tree — see
 *   lambda-ws/README.md for the one command that builds and ships it.
 *
 * ┌── THE MODULES ──────────────────────────────────────────────────────────┐
 * │ index.mjs                the router below: event → handler              │
 * │ lib/config.mjs           every tunable number and every phase clock     │
 * │ lib/aws.mjs              the shared DynamoDB document client            │
 * │ lib/auth.mjs             Cognito token verification, scrypt passwords   │
 * │ lib/connections.mjs      Connections table, postToConnection, fan-out   │
 * │ lib/lobbies.mjs          Lobbies + Players reads                        │
 * │ lib/state.mjs            match state: shape, serialisation, version lock│
 * │ lib/questions.mjs        the pool, the deck, generated arithmetic       │
 * │ lib/turn.mjs             the phase stamp, the living list, the wheel    │
 * │ lib/pot.mjs              who may bet, what it costs, settlement         │
 * │ lib/phases.mjs           spin · question · betting · duel · picking ·   │
 * │                          reveal · gameover                              │
 * │ lib/scheduler.mjs        the Step Functions phase timer                 │
 * │ lib/messages.mjs         phase messages + the system chat line          │
 * │ lib/presence.mjs         lobby_state                                    │
 * │ lib/handlers/*.mjs       one file per inbound message family            │
 * │                                                                         │
 * │ The dependency graph is acyclic and points ONE way:                     │
 * │   handlers → phases → pot → turn → config                               │
 * │   handlers → state / messages / scheduler → connections → config        │
 * │ Nothing in lib/ imports a handler, and nothing imports index.mjs.       │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ┌── WHAT THIS DOES, AND WHAT IT DOES NOT ─────────────────────────────────┐
 * │ DOES:     connect/disconnect bookkeeping, authenticated `join`, live    │
 * │           lobby presence (`lobby_state`), `chat`, `leave`, `ping`,      │
 * │           `kick_player`, `terminate_lobby`, and host-leaves-closes-     │
 * │           the-room. A closed room broadcasts `room_closed` with reason  │
 * │           "host_closed" (terminate) or "host_left" (the host walked).   │
 * │ ENFORCES: host-only actions — `start_game`, `kick_player` and           │
 * │           `terminate_lobby` are refused with reason "not_host" unless   │
 * │           the sender is the room's Admin. Server-side and permanent.    │
 * │ RUNS:     the turn engine. P2.0 durable state on optimistic locks ·     │
 * │           P2.1 the round loop on a Step Functions phase scheduler, so   │
 * │           every phase has an ABSOLUTE deadline instead of a setTimeout  │
 * │           no Lambda could hold · P2.2 the central pot and               │
 * │           accuracy-derived quotas · P2.3 the picking-phase              │
 * │           CHALLENGE / DUEL choice.                                      │
 * │ DOES NOT: `play_again` and the OLD guess/code duel (`submit_guess`,     │
 * │           `submit_code`) still answer                                   │
 * │           { type: "not_implemented" } — see TURN_ENGINE_ACTIONS below.  │
 * │           Elimination-at-0 is wired but standings/persistence are P2.4. │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * ── THE INVARIANTS EVERY STEP MUST PRESERVE ───────────────────────────────
 *     sum(players[].money) + pot  is constant from start_game to game_over.
 * Stakes, antes and penalties move money INTO the pot; payouts move it OUT.
 * Every money path is written as a transfer, so nothing appears or vanishes
 * inside the ledger.
 *
 * ⚠ `pot >= 0` IS DELIBERATELY **NOT** AN INVARIANT (changed after P2.3).
 *   A winning bet is paid the FULL stake × quota it was quoted, even when the
 *   pot cannot fund it — the shortfall is borrowed against the pot, which is
 *   allowed to run a deficit, and repaid by later losing stakes and penalties.
 *   `max(0, -pot)` is the outstanding debt and `minted` is its running total.
 *   Scaling payouts down instead (what P2.2 did) kept the pot non-negative but
 *   made the advertised odds a lie. See settleBets in lib/pot.mjs.
 *
 * ── ENVIRONMENT VARIABLES ─────────────────────────────────────────────────
 *   Read in lib/config.mjs, all with working defaults:
 *   CONNECTIONS_TABLE · CONNECTIONS_LOBBY_INDEX · LOBBIES_TABLE ·
 *   PLAYERS_TABLE · GAME_STATE_TABLE · QUESTIONS_TABLE · PHASE_TIMER_ARN ·
 *   WS_ENDPOINT · CONNECTION_TTL_SECONDS · COGNITO_USER_POOL_ID ·
 *   COGNITO_CLIENT_ID · COGNITO_REGION.
 *   Do NOT set AWS_REGION — it is reserved.
 *
 * ── IAM ───────────────────────────────────────────────────────────────────
 *   Attach lambda-ws/iam-policy.json. What it has that the REST role does not:
 *     execute-api:ManageConnections on  <ws-api-id>/<stage>/POST/@connections/*
 *     dynamodb R/W                 on  table/Connections and table/GameState
 *     dynamodb:Query               on  table/Connections/index/lobby-index
 *     states:StartExecution        on  the phase-timer state machine
 *   Plus GetItem + DeleteItem + UpdateItem on Lobbies (DeleteItem closes a
 *   room; UpdateItem is what removes a kicked player's seat).
 *
 * ── HOW TO ATTACH ─────────────────────────────────────────────────────────
 *   API Gateway → WebSocket API → route selection expression  $request.body.type
 *   Attach this ONE function as a Lambda (proxy) integration to ALL THREE of
 *   $connect, $disconnect and $default, then deploy to stage `prod`.
 *   Full walkthrough: lambda-ws/README.md
 *
 * ── FRONTEND (one required change — see README) ────────────────────────────
 *   The lobby id rides in the `join` message body, not the socket path:
 *   { type: "join", token, lobbyId, displayName }.
 *
 * Ported from: handleGameConnection() in src/server/game/manager.ts and the
 * presence/chat half of GameRoom in src/server/game/room.ts.
 * ===========================================================================
 */

import { getConnection, postTo } from "./lib/connections.mjs";
import { onChat } from "./lib/handlers/chat.mjs";
import { onConnect, onDisconnect } from "./lib/handlers/connect.mjs";
import {
  onPickPlayer,
  onPlaceBet,
  onStartGame,
  onSubmitAnswer,
} from "./lib/handlers/game.mjs";
import { onJoin } from "./lib/handlers/join.mjs";
import {
  HOST_ONLY_ACTIONS,
  onKickPlayer,
  onLeave,
  onTerminateLobby,
  requireHost,
} from "./lib/handlers/room.mjs";
import { onPhaseTimer } from "./lib/scheduler.mjs";

/**
 * Turn-engine actions still awaiting a later step. `start_game` used to be the
 * tenth entry here; it is handled for real now (it seeds the match state), so
 * it is dispatched before this set is consulted.
 *
 * ⚠ `submit_guess` / `submit_code` ARE THE OLD DUEL, AND NOTHING ROUTES TO IT.
 *   room.ts fired a duel automatically whenever exactly two players were left
 *   (DUEL_CHANCE = 0.5 on each spin) and rolled between a closest-GUESS duel
 *   and a code-breaker duel; those are what these two messages fed.
 *
 *   P2.3 implements Matija's duel instead: a SPEED RACE on an ordinary
 *   question, started BY A PICKER at a moment of their choosing, settled out
 *   of the pot. It supersedes the automatic pair. The old code is not deleted
 *   — the CODE_DUEL_TIME_MS constant, the `duel.kind` field and these two
 *   message names all survive — but nothing calls it: there is no
 *   DUEL_CHANCE here, enterSpin never branches into a duel, and the racers
 *   answer through `submit_answer` like everyone else. Reviving it would mean
 *   porting startDuel/startCodeDuel from room.ts and giving the picker a third
 *   mode. AWAITING MATIJA'S CONFIRMATION that this is intended.
 */
const TURN_ENGINE_ACTIONS = new Set([
  "submit_guess",
  "submit_code",
  "play_again",
]);
/**
 * $default — every message lands here. The API's route selection expression is
 * $request.body.type, but with only $connect/$disconnect/$default configured
 * there is nothing else for a typed message to match, which is what makes one
 * function enough.
 */
async function onDefault(event) {
  const connectionId = event.requestContext.connectionId;

  let msg;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : event.body || "";
    msg = JSON.parse(raw);
  } catch {
    await postTo(event, connectionId, {
      type: "error",
      message: "Invalid JSON message",
    });
    return { statusCode: 200, body: "" };
  }

  const type = String(msg?.type ?? "");
  const row = await getConnection(connectionId);

  switch (type) {
    case "join":
      await onJoin(event, connectionId, msg, row);
      break;
    case "chat":
      await onChat(event, connectionId, msg, row);
      break;
    case "leave":
      await onLeave(event, connectionId, row);
      break;
    case "ping":
      // plumbing check: works before `join`, and echoes anything sent with it
      await postTo(event, connectionId, {
        type: "pong",
        at: Date.now(),
        connectionId,
        echo: msg.echo ?? null,
        joined: Boolean(row?.username),
        lobbyId: row?.lobbyId ?? null,
      });
      break;
    default:
      // the host gate runs BEFORE anything else these actions would do, and
      // stays in front of the turn engine when Phase 2 lands here
      if (HOST_ONLY_ACTIONS.has(type) && !(await requireHost(event, connectionId, row, type))) {
        break;
      }
      if (type === "start_game") {
        await onStartGame(event, connectionId, row);
        break;
      }
      if (type === "submit_answer") {
        await onSubmitAnswer(event, connectionId, row, msg);
        break;
      }
      if (type === "place_bet") {
        await onPlaceBet(event, connectionId, row, msg);
        break;
      }
      if (type === "pick_player") {
        await onPickPlayer(event, connectionId, row, msg);
        break;
      }
      if (type === "kick_player") {
        await onKickPlayer(event, connectionId, row, msg);
        break;
      }
      if (type === "terminate_lobby") {
        await onTerminateLobby(event, connectionId, row);
        break;
      }
      if (TURN_ENGINE_ACTIONS.has(type)) {
        await postTo(event, connectionId, {
          type: "not_implemented",
          action: type,
          message:
            `"${type}" is part of the turn engine, which does not run on ` +
            "Lambda yet. Phase 0 covers connect, join, presence and chat. " +
            "See docs/websocket-game-later.md.",
        });
      } else {
        await postTo(event, connectionId, {
          type: "error",
          message: `Unknown message type: ${type || "(none)"}`,
        });
      }
  }
  return { statusCode: 200, body: "" };
}

// ─── handler ───────────────────────────────────────────────────────────────
/**
 * Two entry points, one function.
 *
 *   API Gateway  → event.requestContext.routeKey is $connect/$disconnect/$default
 *   Step Functions → no requestContext; the execution input carries
 *                    source: "phase-timer"
 *
 * They share a function deliberately: a deadline firing and a player answering
 * early run the SAME transition code (enterReveal, afterReveal, enterSpin…).
 * Splitting them into two deployments would mean two copies of the engine and
 * the certainty that they drift.
 */
export const handler = async (event) => {
  if (event?.source === "phase-timer" && event.lobbyId) {
    try {
      return await onPhaseTimer(event);
    } catch (err) {
      console.error("phase timer failed", event.lobbyId, err);
      // let the state machine stop rather than spin on a poisoned match
      return { done: true, lobbyId: event.lobbyId, error: String(err?.message ?? err) };
    }
  }

  const routeKey = event.requestContext?.routeKey;
  try {
    switch (routeKey) {
      case "$connect":
        return await onConnect(event);
      case "$disconnect":
        return await onDisconnect(event);
      case "$default":
        return await onDefault(event);
      default:
        console.error("unexpected routeKey", routeKey);
        return { statusCode: 400, body: "Unknown route" };
    }
  } catch (err) {
    console.error(`${routeKey} failed`, err);
    // a thrown error on $connect refuses the socket, which is right; on
    // $default the socket should survive one bad message
    if (routeKey === "$default") {
      await postTo(event, event.requestContext.connectionId, {
        type: "error",
        message: "Internal server error",
      }).catch(() => {});
      return { statusCode: 200, body: "" };
    }
    return { statusCode: 500, body: "Internal server error" };
  }
};

export {
  TURN_ENGINE_ACTIONS,
  onDefault,
};
