/**
 * ===========================================================================
 * lib/turn.mjs — primitives every phase shares: the phase stamp, the wheel
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  SPIN_WEIGHT_INITIAL,
  SPIN_WEIGHT_MAX,
  SPIN_WEIGHT_MIN,
  SPIN_WEIGHT_PICKED_DECAY,
  SPIN_WEIGHT_RECOVERY,
  nowMs,
} from "./config.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// THE ROUND LOOP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every phase change goes through here. `phaseSeq` is what makes the scheduler
 * idempotent: a timer carries the seq it was armed for, and a timer whose seq
 * no longer matches the state is one whose phase already moved on — it exits
 * without touching anything.
 */
function setPhase(state, phase, durationMs) {
  state.phase = phase;
  state.phaseSeq = Number(state.phaseSeq ?? 0) + 1;
  state.phaseEndsAt = nowMs() + durationMs;
  return state;
}

const livingPlayers = (s) => (s.players ?? []).filter((p) => p.alive && !p.isSpectator);

/**
 * SPIN WEIGHTS — Matija's decaying model.
 *
 *   picked      w := max(MIN, w * PICKED_DECAY)     0.35×, floored at 0.15
 *   everyone    w := min(MAX, w * RECOVERY)         1.25×, capped at 2.5
 *   else
 *
 * The floor is the whole point: a just-picked player's weight drops hard but
 * never reaches zero, so an immediate re-pick stays possible — just unlikely.
 * The cap stops someone ignored for ten spins becoming a certainty. Weights
 * are persisted per player, so unlike room.ts's single `lastSpinTarget` the
 * distribution remembers the whole match, and a player skipped repeatedly
 * climbs while the recently-picked sink.
 */
function applySpinWeights(state, pickedUsername) {
  for (const p of state.players ?? []) {
    if (!p.alive || p.isSpectator) continue;
    const w = Number(p.spinWeight ?? SPIN_WEIGHT_INITIAL);
    const next =
      p.username === pickedUsername
        ? Math.max(SPIN_WEIGHT_MIN, w * SPIN_WEIGHT_PICKED_DECAY)
        : Math.min(SPIN_WEIGHT_MAX, w * SPIN_WEIGHT_RECOVERY);
    // keep the stored numbers tidy — DynamoDB happily persists float drift
    p.spinWeight = Math.round(next * 1e6) / 1e6;
  }
}

function weightedPick(alive) {
  const w = (p) => Math.max(SPIN_WEIGHT_MIN, Number(p.spinWeight ?? SPIN_WEIGHT_INITIAL));
  const total = alive.reduce((sum, p) => sum + w(p), 0);
  let roll = Math.random() * total;
  for (const p of alive) {
    roll -= w(p);
    if (roll <= 0) return p;
  }
  return alive[alive.length - 1];
}

export {
  applySpinWeights,
  livingPlayers,
  setPhase,
  weightedPick,
};
