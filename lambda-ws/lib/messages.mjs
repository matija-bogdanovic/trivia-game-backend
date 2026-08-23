/**
 * ===========================================================================
 * lib/messages.mjs — what goes over the wire for a phase, and the system chat line
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { MIN_BET, nowMs } from "./config.mjs";
import { broadcast } from "./connections.mjs";
import { quotasFor } from "./pot.mjs";
import { recordChatMessage } from "./chatlog.mjs";
import { persistMatchResults } from "./results.mjs";
import { publicGameState } from "./state.mjs";

/** the phase-specific message that rides alongside game_state */
function phaseMessage(state) {
  switch (state.phase) {
    // "Runda N" — the beat that opens a wheel cycle. `roundEndsAt` is the
    // absolute deadline and `introTimeMs` the time LEFT on it, so a client
    // that reloads two seconds in is told 500ms and lands in step rather than
    // restarting the animation. Same contract as every other phase message.
    case "round_intro":
      return {
        type: "round_intro",
        round: Number(state.round ?? 0),
        roundEndsAt: Number(state.phaseEndsAt),
        introTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
        playersAlive: (state.players ?? []).filter(
          (p) => p.alive && !p.isSpectator
        ).length,
      };
    case "spin":
      return {
        type: "spin",
        target: state.currentSpin?.target,
        spinTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "question":
      return {
        type: "turn_question",
        round: state.round,
        chainDepth: state.chainDepth,
        answering: state.turn?.answering,
        // a challenge carries who aimed it, and what they staked — the SIDE
        // stays hidden until reveal, like every other bet
        mode: state.turn?.mode ?? "open",
        picker: state.turn?.picker ?? null,
        challengeBet:
          state.turn?.mode === "challenge"
            ? (state.bets ?? [])
                .filter((b) => b.username === state.turn.picker)
                .map((b) => ({ username: b.username, amount: b.amount, quota: b.quota }))[0] ?? null
            : null,
        questionText: state.turn?.question?.text,
        options: state.turn?.question?.options,
        difficulty: state.turn?.question?.difficulty,
        answerTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "duel":
      return {
        type: "duel_start",
        kind: "race",
        round: state.round,
        chainDepth: state.chainDepth,
        players: state.duel?.players ?? [],
        picker: state.duel?.picker ?? null,
        target: state.duel?.target ?? null,
        ante: Number(state.duel?.ante ?? 0),
        pot: Number(state.pot ?? 0),
        questionText: state.duel?.question?.text,
        options: state.duel?.question?.options,
        difficulty: state.duel?.question?.difficulty,
        // who has already buzzed in — NOT what they said
        answered: Object.keys(state.duel?.answers ?? {}),
        answerTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "betting":
      return {
        type: "bet_start",
        target: state.turn?.answering,
        betTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
        pot: Number(state.pot ?? 0),
        quotas: quotasFor(state),
      };
    case "reveal":
      // a duel reveals as a duel: two racers, two times, one winner
      if (state.duel?.resolved) {
        const r = state.duel.result ?? {};
        return {
          type: "duel_result",
          kind: "race",
          round: state.round,
          chainDepth: state.chainDepth,
          players: state.duel.players ?? [],
          picker: state.duel.picker ?? null,
          target: state.duel.target ?? null,
          ante: Number(r.ante ?? 0),
          winner: r.winner ?? null,
          loser: r.loser ?? null,
          payout: Number(r.payout ?? 0),
          minted: Number(r.minted ?? 0),
          mintedTotal: Number(state.minted ?? 0),
          deltas: r.deltas ?? [],
          submissions: r.submissions ?? [],
          timedOut: r.timedOut ?? [],
          correctAnswer: r.correctAnswer ?? null,
          pot: Number(state.pot ?? 0),
          eliminated: state.eliminated ?? [],
        };
      }
      return {
        type: "round_result",
        round: state.round,
        pot: Number(state.pot ?? 0),
        bets: state.betResults ?? [],
        // always 1 now — payouts are never scaled down. Kept for clients.
        betScale: Number(state.turn?.betScale ?? 1),
        minted: Number(state.turn?.betMinted ?? 0),
        mintedTotal: Number(state.minted ?? 0),
        chainDepth: state.chainDepth,
        answering: state.turn?.answering,
        mode: state.turn?.mode ?? "open",
        picker: state.turn?.picker ?? null,
        answer: state.turn?.answer ?? null,
        timedOut: Boolean(state.turn?.timedOut),
        correct: Boolean(state.turn?.correct),
        correctAnswer: state.turn?.question?.answer ?? null,
        answererDelta: Number(state.turn?.answererDelta ?? 0),
        eliminated: state.eliminated ?? [],
      };
    case "picking":
      return {
        type: "pick_start",
        picker: state.currentPick?.picker,
        choices: state.currentPick?.choices ?? [],
        // P2.3 — the pick is now target AND mode, so the prices for both ride
        // along: `quotas` is what a CHALLENGE on that target pays, `duelAnte`
        // is what a DUEL with them costs each side
        modes: state.currentPick?.modes ?? ["challenge", "duel"],
        targets: state.currentPick?.targets ?? [],
        minBet: MIN_BET,
        pot: Number(state.pot ?? 0),
        pickTimeMs: Math.max(0, Number(state.phaseEndsAt) - nowMs()),
      };
    case "gameover":
      return {
        type: "game_over",
        winner: state.winner ?? null,
        rounds: state.round,
        // the final table, already ordered: survivors first, then by money,
        // then by who survived LONGER (eliminatedAt descending)
        standings: state.standings ?? [],
        // (d) whatever was still in the pot went to the winner. A pot in
        // DEFICIT awards nothing — the debt is not charged to the winner.
        potAwarded: Number(state.potAwarded ?? 0),
        pot: Number(state.pot ?? 0),
        minted: Number(state.minted ?? 0),
      };
    default:
      return null;
  }
}

/**
 * state first so the client can render off it, then the phase event
 *
 * And, when that phase is `gameover`, the match is recorded — this is the one
 * place EVERY phase transition passes through, from the timer, from the last
 * answer, and from a player leaving. Hooking it here rather than at the five
 * call sites is what makes it impossible to add a sixth path to gameover that
 * silently forgets to pay anybody.
 *
 * Recording happens AFTER the broadcast, on purpose: the results screen should
 * not wait on bookkeeping. persistMatchResults is idempotent and never throws,
 * so a repeated call or a failed write cannot disturb a finished match.
 */
async function broadcastPhase(event, lobbyId, state) {
  await broadcastGameState(event, lobbyId, state);
  const msg = phaseMessage(state);
  if (msg) await broadcast(event, lobbyId, msg);
  if (state?.phase === "gameover") await persistMatchResults(event, state);
}
/** push the current state to everyone in the lobby */
async function broadcastGameState(event, lobbyId, state) {
  await broadcast(event, lobbyId, {
    type: "game_state",
    state: publicGameState(state),
  });
}
/**
 * The system-voice chat line GameRoom.systemChat() writes.
 *
 * `reason` is a stable machine-readable code — "joined", "left",
 * "disconnected", "match_starting" — so the frontend can localise the line
 * instead of rendering the English `text`, which stays as the fallback.
 */
async function systemChat(event, lobbyId, text, reason = null) {
  const at = Date.now();
  await broadcast(event, lobbyId, {
    type: "chat_message",
    username: null,
    text,
    ...(reason ? { reason } : {}),
    at,
  });
  // kept alongside what players typed, and marked as the room's own voice —
  // a transcript that cannot tell the two apart reads as if the room were
  // talking to itself
  await recordChatMessage({ lobbyId, text, at, kind: "system", reason });
}

export {
  broadcastGameState,
  broadcastPhase,
  phaseMessage,
  systemChat,
};
