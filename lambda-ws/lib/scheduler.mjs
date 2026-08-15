/**
 * ===========================================================================
 * lib/scheduler.mjs — the Step Functions phase timer and the deadline entry point
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  SFNClient,
  StartExecutionCommand,
  StopExecutionCommand,
} from "@aws-sdk/client-sfn";
import { PHASE_TIMER_ARN, REGION, nowMs } from "./config.mjs";
import { broadcastPhase } from "./messages.mjs";
import { advanceOnDeadline } from "./phases.mjs";
import { loadQuestionPool } from "./questions.mjs";
import { mutateGameState, readGameState } from "./state.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEDULER
// ═══════════════════════════════════════════════════════════════════════════
const sfn = new SFNClient({ region: REGION });
/** a fired timer this far before its deadline is early — re-arm, don't advance */
const TIMER_TOLERANCE_MS = 400;

async function startPhaseTimer(lobbyId, phaseSeq, phaseEndsAt) {
  const res = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: PHASE_TIMER_ARN,
      input: JSON.stringify({
        source: "phase-timer",
        lobbyId,
        phaseSeq,
        waitUntil: new Date(phaseEndsAt).toISOString(),
      }),
    })
  );
  return res.executionArn;
}

async function stopPhaseTimer(executionArn) {
  if (!executionArn) return;
  try {
    await sfn.send(new StopExecutionCommand({ executionArn }));
  } catch (err) {
    // already finished, or never existed — the phaseSeq guard covers us anyway
    console.warn("stopExecution failed (harmless)", err?.name);
  }
}

/**
 * Re-arm after a transition driven by a PLAYER rather than a deadline.
 *
 * The running execution is asleep on the old deadline, so it is stopped and a
 * fresh one started. If the stop loses the race and the old execution fires
 * anyway, its phaseSeq no longer matches and it exits without acting — the
 * guard is what makes this safe rather than the stop.
 *
 * Runs AFTER the state write commits, then persists the new ARN in a second
 * write. That second write bumps `version` but not `phaseSeq`, so it cannot
 * invalidate the timer it just armed.
 */
async function rearmPhaseTimer(state, previousExecutionArn) {
  await stopPhaseTimer(previousExecutionArn);
  if (state.phase === "gameover") {
    await mutateGameState(state.lobbyId, (s) => { s.executionArn = null; return s; });
    return;
  }
  const arn = await startPhaseTimer(state.lobbyId, state.phaseSeq, state.phaseEndsAt);
  await mutateGameState(state.lobbyId, (s) => { s.executionArn = arn; return s; });
}
/**
 * The phaseAdvance entry point — invoked by Step Functions, not by a socket.
 * Returns the next {waitUntil, phaseSeq, done} so the state machine loops.
 */
async function onPhaseTimer(event) {
  const lobbyId = event.lobbyId;
  const firedFor = Number(event.phaseSeq);
  const pool = await loadQuestionPool();

  const res = await mutateGameState(lobbyId, (s) => {
    if (Number(s.phaseSeq ?? 0) !== firedFor) return null; // stale — phase moved
    if (s.phase === "gameover") return null;
    if (nowMs() < Number(s.phaseEndsAt ?? 0) - TIMER_TOLERANCE_MS) return null; // early
    return advanceOnDeadline(s, pool);
  });

  if (!res.ok) {
    const cur = await readGameState(lobbyId);
    if (!cur || cur.phase === "gameover") return { done: true, lobbyId };
    // somebody else now owns the timer for this match
    if (Number(cur.phaseSeq ?? 0) !== firedFor) return { done: true, lobbyId };
    // our phase is still current but the deadline moved out — wait again
    return {
      done: false,
      lobbyId,
      phaseSeq: cur.phaseSeq,
      waitUntil: new Date(Number(cur.phaseEndsAt)).toISOString(),
      source: "phase-timer",
    };
  }

  const s = res.state;
  await broadcastPhase(event, lobbyId, s);
  if (s.phase === "gameover") return { done: true, lobbyId };
  return {
    done: false,
    lobbyId,
    phaseSeq: s.phaseSeq,
    waitUntil: new Date(Number(s.phaseEndsAt)).toISOString(),
    source: "phase-timer",
  };
}

export {
  TIMER_TOLERANCE_MS,
  onPhaseTimer,
  rearmPhaseTimer,
  startPhaseTimer,
  stopPhaseTimer,
};
