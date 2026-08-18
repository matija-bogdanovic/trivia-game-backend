/**
 * ===========================================================================
 * lib/state.mjs — the match state: shape, serialisation, and the version lock
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import crypto from "node:crypto";
import {
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import {
  COUNTDOWN_MS,
  GAME_STATE_TABLE,
  MIN_PLAYERS,
  SPIN_WEIGHT_INITIAL,
  STARTING_MONEY,
  STATE_MAX_ATTEMPTS,
  capacityOf,
  nowMs,
  sleep,
  startingMoneyOf,
  ttlFrom,
} from "./config.mjs";
import { quotasFor } from "./pot.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// GAME STATE — the P2.0 backbone
// ═══════════════════════════════════════════════════════════════════════════
//
// One item per lobby in the GameState table, PK `lobbyId`, holding everything
// GameRoom kept in memory. The shape below is ported field-for-field from
// src/server/game/room.ts, with the P2 additions Matija locked in marked NEW.
//
//   lobbyId        S   partition key, the same id used everywhere else
//   version        N   optimistic lock — every write asserts the value it read
//   matchId        S   fresh per start_game, not per lobby (room.ts matchId)
//   phase          S   lobby|countdown|round_intro|spin|question|betting|
//                      reveal|picking|duel|gameover  (the 9 from types.ts
//                      GamePhase, plus `round_intro` — the "Runda N" beat)
//   phaseEndsAt    N   NEW absolute epoch ms. room.ts used setTimeout, which a
//                      Lambda cannot hold; this is what P2.1's scheduler fires
//                      on, and it is why every phase now has a real deadline —
//                      including `betting`, which room.ts never gave one.
//   round          N   WHEEL CYCLES elapsed, 1-based. Incremented in exactly
//                      one place, enterRoundIntro; a challenge/duel chain runs
//                      inside one round and does not bump it.
//   chainDepth     N   drives difficulty (1 + floor(depth/2)) and the clock
//   pot            N   NEW central pot. Stakes go in, winners are paid out of
//                      it, scaled down if it cannot cover — money conserved.
//   players[]          username, displayName, avatar, money, alive, connected,
//                      isHost, isSpectator, streak,
//                      spinWeight  NEW per-player decaying selection weight
//                      stats { correct NEW, wrong, betsWon, maxBetWin,
//                              roundsPlayed }  — correct/wrong feed the quota
//   lastSpinTarget S   kept for continuity; spinWeight supersedes it
//   turn               { answering, question{...}, askedAt, answerTimeMs,
//                        answer, answeredInMs, mode NEW: open|challenge,
//                        picker NEW } — `answer` is the submitted answer, held
//                        hidden until reveal exactly as room.ts does during the
//                        betting pause
//   bets[]             NEW { username, side: correct|wrong, amount, quota }
//                      — a list, not a Map, because Maps do not serialise. In a
//                      CHALLENGE this holds exactly one entry: the picker's.
//   duel               NEW (P2.3) the SPEED RACE:
//                      { kind: "race", players[2], picker, target, ante,
//                        question, askedAt, endsAt, answers{}, firstCorrect,
//                        resolved, result }
//                      room.ts's guess/code duels used this same field with
//                      kind guess|code; nothing routes to those any more.
//   currentSpin        { target, endsAt }        for reconnect resync
//   currentPick        { picker, choices[], endsAt }
//   deck               { fresh[], used[] } question ids — populated in P2.2
//   chat[]             ring buffer, last CHAT_HISTORY_LIMIT entries
//   startedAt/updatedAt N
//   expiresAt      N   TTL, 24h
//
// Nothing here runs the game yet. P2.0 proves the state exists, round-trips,
// and cannot be corrupted by two writers.
/**
 * A fresh match, seeded from the Lobbies roster.
 *
 * Only players who are BOTH on the roster and currently holding a socket are
 * seated — room.ts does the same thing ("only players present at the start
 * participate") by deleting disconnected players in startGame().
 */
function initialGameState(lobby, lobbyId, connRows) {
  const now = nowMs();
  const live = new Map();
  for (const c of connRows) if (c.username) live.set(c.username, c);

  // EVERY seat is worth the same, and it is the room's own setting. This is
  // the only place a starting balance is minted in the whole match — after
  // this line money only ever moves, which is what makes
  // sum(money) + pot == players × startingMoney provable for the whole game.
  const startingMoney = startingMoneyOf(lobby);

  const roster = Array.isArray(lobby?.players) ? lobby.players : [];
  const players = roster
    .filter((seat) => live.has(String(seat.player)))
    .map((seat) => {
      const username = String(seat.player);
      const conn = live.get(username);
      return {
        username,
        displayName: conn?.displayName || username,
        avatar: conn?.avatar ?? null,
        money: startingMoney,
        alive: true,
        connected: true,
        isHost: seat.role === "Admin",
        isSpectator: false,
        streak: Number(conn?.streak ?? 0),
        // NEW — equal at the start, diverges from the first spin onward
        spinWeight: SPIN_WEIGHT_INITIAL,
        // `correct` is the counter room.ts never kept; without it there is no
        // denominator for an accuracy-derived quota
        stats: { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 },
      };
    });

  return {
    lobbyId,
    version: 0,
    matchId: crypto.randomUUID(),
    code: Number(lobby?.code ?? 0),
    roomName: lobby?.roomName ?? `Room ${lobby?.code ?? ""}`.trim(),
    maxPlayers: capacityOf(lobby),
    minPlayers: MIN_PLAYERS,
    // persisted on the match, not re-read from the room: changing the room's
    // setting mid-match must not retroactively change what this match was
    // seeded with, and the conservation check needs the original number
    startingMoney,

    phase: "countdown",
    // phaseSeq must exist from the very first phase: the scheduler's guard
    // compares against it, and an undefined here makes the first timer think
    // it is stale and exit, leaving the match parked in countdown forever
    phaseSeq: 1,
    phaseEndsAt: now + COUNTDOWN_MS,
    executionArn: null,
    round: 0,
    chainDepth: 0,
    pot: 0,
    // running total of payouts the pot could not fund — see settleBets
    minted: 0,

    players,
    lastSpinTarget: null,

    turn: null,
    bets: [],
    duel: null,
    currentSpin: null,
    currentPick: null,
    deck: { fresh: [], used: [] },
    chat: [],

    startedAt: now,
    updatedAt: now,
    expiresAt: ttlFrom(now),
  };
}

/** what goes over the wire — secrets stripped, never the raw item */
function publicGameState(s) {
  return {
    lobbyId: s.lobbyId,
    version: s.version,
    matchId: s.matchId,
    phase: s.phase,
    phaseEndsAt: s.phaseEndsAt,
    round: s.round,
    chainDepth: s.chainDepth,
    pot: s.pot,
    // CAN BE NEGATIVE — see settleBets. `minted` is how much has been paid to
    // winners that the pot did not hold; `max(0, -pot)` is what is still owed.
    minted: Number(s.minted ?? 0),
    code: s.code,
    roomName: s.roomName,
    minPlayers: s.minPlayers,
    maxPlayers: s.maxPlayers,
    startingMoney: Number(s.startingMoney ?? STARTING_MONEY),
    players: (s.players ?? []).map((p) => ({
      username: p.username,
      displayName: p.displayName,
      avatar: p.avatar,
      money: p.money,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      isSpectator: p.isSpectator,
      // when they went out (epoch ms), null while still playing. The gameover
      // standings rank the eliminated by this — everyone out holds 0, so it is
      // the only thing separating them.
      eliminatedAt: p.eliminatedAt ?? null,
      streak: p.streak,
      spinWeight: p.spinWeight,
      stats: p.stats,
    })),
    // the submitted answer and the duel code stay server-side until reveal,
    // mirroring room.ts hiding `turn.answer` through the betting pause
    turn: s.turn
      ? {
          answering: s.turn.answering,
          // "open" = the wheel landed on them and the table may bet;
          // "challenge" = a picker sent them this question and owns the book
          mode: s.turn.mode ?? "open",
          picker: s.turn.picker ?? null,
          question: s.turn.question
            ? {
                text: s.turn.question.text,
                options: s.turn.question.options,
                difficulty: s.turn.question.difficulty,
              }
            : null,
          askedAt: s.turn.askedAt,
          answerTimeMs: s.turn.answerTimeMs,
          hasAnswered: s.turn.answer !== null && s.turn.answer !== undefined,
        }
      : null,
    // which SIDE each player took stays hidden while betting is open — it is
    // live strategic information — and is revealed once the turn resolves
    bets: (s.bets ?? []).map((b) => ({
      username: b.username,
      amount: b.amount,
      quota: b.quota,
      ...(s.phase === "reveal" || s.phase === "gameover" ? { side: b.side } : {}),
    })),
    // the price on offer right now, so a client can label the two buttons
    quotas:
      s.phase === "question" || s.phase === "betting" ? quotasFor(s) : null,
    betResults: s.phase === "reveal" ? s.betResults ?? [] : null,
    // THE DUEL, with the same secrecy rules as a question: both racers need the
    // text and the options, nobody may see `question.answer`, and nobody may
    // see what the OTHER racer submitted until the duel is resolved — only THAT
    // they have submitted, which is the information the race is actually about.
    duel: s.duel
      ? {
          kind: s.duel.kind ?? "race",
          players: s.duel.players ?? [],
          picker: s.duel.picker ?? null,
          target: s.duel.target ?? null,
          ante: Number(s.duel.ante ?? 0),
          endsAt: s.duel.endsAt,
          question: s.duel.question
            ? {
                text: s.duel.question.text,
                options: s.duel.question.options,
                difficulty: s.duel.question.difficulty,
              }
            : null,
          answered: Object.keys(s.duel.answers ?? {}),
          result: s.duel.resolved ? s.duel.result ?? null : null,
        }
      : null,
    currentSpin: s.currentSpin,
    currentPick: s.currentPick,
  };
}

async function readGameState(lobbyId) {
  const res = await ddb.send(
    new GetCommand({ TableName: GAME_STATE_TABLE, Key: { lobbyId } })
  );
  return res.Item ?? null;
}

/** create-once. Two simultaneous start_game calls: exactly one wins. */
async function createGameState(state) {
  await ddb.send(
    new PutCommand({
      TableName: GAME_STATE_TABLE,
      Item: state,
      ConditionExpression: "attribute_not_exists(lobbyId)",
    })
  );
  return state;
}

/**
 * THE CONCURRENCY BACKBONE — read → modify → conditional write on `version`.
 *
 * Six players can act in the same instant and each acts through its own
 * Lambda, so "read the room, change a field, write it back" is a lost-update
 * race by default. Every write here asserts that `version` still holds the
 * value this invocation read; if another writer got in first the condition
 * fails, and we re-read and replay the mutation against the NEW state rather
 * than clobbering it. That is what turns each field mutation in room.ts into
 * something safe to run twelve times concurrently.
 *
 * `mutate(state)` receives a private copy and returns the next state, or null
 * to abort without writing (used for "the rules say no" outcomes).
 *
 * Returns { ok, state, attempts } or { ok: false, reason }.
 */
async function mutateGameState(lobbyId, mutate) {
  for (let attempt = 1; attempt <= STATE_MAX_ATTEMPTS; attempt++) {
    const current = await readGameState(lobbyId);
    if (!current) return { ok: false, reason: "no_state" };

    const expected = Number(current.version ?? 0);
    const next = await mutate(structuredClone(current));
    if (!next) return { ok: false, reason: "aborted", state: current, attempts: attempt };

    next.version = expected + 1;
    next.updatedAt = nowMs();
    next.expiresAt = ttlFrom(next.updatedAt);

    try {
      await ddb.send(
        new PutCommand({
          TableName: GAME_STATE_TABLE,
          Item: next,
          ConditionExpression: "#v = :expected",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":expected": expected },
        })
      );
      return { ok: true, state: next, attempts: attempt };
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException") throw err;
      // somebody else wrote between our read and our write — jittered backoff
      // so six retrying writers do not synchronise into a thundering herd
      console.warn(
        `version conflict on ${lobbyId} (expected ${expected}), attempt ${attempt}`
      );
      await sleep(15 * attempt + Math.floor(Math.random() * 25));
    }
  }
  return { ok: false, reason: "contended" };
}

export {
  createGameState,
  initialGameState,
  mutateGameState,
  publicGameState,
  readGameState,
};
