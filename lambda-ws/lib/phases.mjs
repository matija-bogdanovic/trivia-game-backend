/**
 * ===========================================================================
 * lib/phases.mjs — the phase machine: spin · question · betting · duel · picking · reveal · gameover
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  BETTING_TIME_MS,
  CHALLENGE_DIFFICULTY_BUMP,
  DUEL_ANTE,
  DUEL_TIME_MS,
  PICK_TIME_MS,
  REVEAL_MS,
  ROUND_INTRO_MS,
  SPIN_TIME_MS,
  WRONG_ANSWER_COST,
  nowMs,
  questionTimeFor,
} from "./config.mjs";
import { quotasForPlayer, settleBets } from "./pot.mjs";
import { drawQuestion } from "./questions.mjs";
import { applySpinWeights, livingPlayers, setPhase, weightedPick } from "./turn.mjs";

function enterBetting(state) {
  setPhase(state, "betting", BETTING_TIME_MS);
  return state;
}

/**
 * (d) WHERE THE POT'S REMAINDER GOES.
 *
 * During the match: nowhere. Losers' stakes, scaled-down payouts, rounding
 * dust, both antes of a duel nobody won — all of it simply STAYS IN THE POT and
 * funds later rounds. Nothing is refunded and nothing is destroyed, which is
 * what keeps `sum(money) + pot` provably constant round to round.
 *
 * At GAME OVER the remainder is paid to the winner and the pot is zeroed. That
 * is a transfer, not an invention — the total is unchanged — and it makes the
 * final scoreboard the honest one: everything anyone lost during the match ends
 * up in the last player's hands rather than sitting in a number nobody owns.
 * `potAwarded` reports how much of the final balance came from the pot.
 */
function enterGameOver(state) {
  const ranked = [...(state.players ?? [])]
    .filter((p) => !p.isSpectator)
    .sort((a, b) => {
      // survivors first, then the bigger pile…
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (b.money !== a.money) return b.money - a.money;
      // …and among the eliminated, WHO LASTED LONGER places higher. Every
      // eliminated player holds exactly 0, so without this they would tie on
      // money and land in whatever order the array happened to be in.
      return Number(b.eliminatedAt ?? 0) - Number(a.eliminatedAt ?? 0);
    });
  state.winner = ranked[0]?.username ?? null;
  // the final table, already in order, so the client never has to re-derive it
  state.standings = ranked.map((p, i) => ({
    place: i + 1,
    username: p.username,
    displayName: p.displayName,
    money: Number(p.money ?? 0),
    alive: Boolean(p.alive),
    eliminatedAt: p.eliminatedAt ?? null,
  }));

  const remainder = Math.max(0, Math.floor(Number(state.pot ?? 0)));
  state.potAwarded = 0;
  if (state.winner && remainder > 0) {
    const w = (state.players ?? []).find((p) => p.username === state.winner);
    if (w) {
      w.money = Number(w.money ?? 0) + remainder;
      state.pot = Number(state.pot ?? 0) - remainder;
      state.potAwarded = remainder;
    }
  }

  state.turn = null;
  state.duel = null;
  state.currentSpin = null;
  state.currentPick = null;
  setPhase(state, "gameover", 0);
  state.phaseEndsAt = 0;
  return state;
}

/**
 * ROUND INTRO — "Runda N", the beat that opens every wheel cycle.
 *
 * THIS IS THE ONE PLACE `round` IS INCREMENTED, and that is the whole point of
 * the phase. A round is now defined as ONE WHEEL-SELECTION CYCLE: the wheel
 * picks somebody, and everything that follows from that pick — the question,
 * the bets, and however deep the challenge/duel chain runs off a correct
 * answer — all belongs to that same round. Only coming back to the wheel
 * starts a new one.
 *
 * That is a change of meaning: `round` used to tick once per QUESTION, so a
 * five-link chain read as five rounds. The per-player `stats.roundsPlayed`
 * counter is deliberately left alone — it still counts turns taken, which is
 * what it has always meant and what the match history is built from.
 *
 * Every path back to the wheel comes through here rather than calling
 * enterSpin directly, so the counter cannot drift from what the players are
 * shown. The one guard: a match with a single player left is already over, and
 * announcing "Runda 12" a moment before the game-over screen would be a lie —
 * so that case goes straight to gameover and the round number stops where the
 * last real round left it.
 */
function enterRoundIntro(state) {
  if (livingPlayers(state).length <= 1) return enterGameOver(state);

  state.round = Number(state.round ?? 0) + 1;
  // the previous round's turn is finished and already revealed; clearing it
  // means the intro screen renders against a clean state rather than the
  // leftovers of the round being replaced. The chain belonged to the round
  // that just ended, so it resets here rather than one phase later in
  // enterSpin — otherwise `game_state` would advertise a live chain depth
  // underneath a card announcing a fresh round.
  state.chainDepth = 0;
  state.turn = null;
  state.duel = null;
  state.currentSpin = null;
  state.currentPick = null;
  setPhase(state, "round_intro", ROUND_INTRO_MS);
  return state;
}

/** the wheel: decide the FINAL target up front, then animate for 5s */
function enterSpin(state) {
  const alive = livingPlayers(state);
  if (alive.length <= 1) return enterGameOver(state);

  state.chainDepth = 0;
  const target = weightedPick(alive);
  applySpinWeights(state, target.username);
  state.lastSpinTarget = target.username;
  state.turn = null;
  state.duel = null; // a new chain starts clean — no stale duel on the state
  state.currentPick = null;
  setPhase(state, "spin", SPIN_TIME_MS);
  state.currentSpin = {
    target: target.username,
    startedAt: nowMs(),
    endsAt: state.phaseEndsAt,
  };
  return state;
}

/**
 * Credit a TURN to everyone still standing (room.ts's creditRound).
 *
 * It no longer touches `state.round` — that moved to enterRoundIntro, because
 * a round is now a wheel cycle rather than a question. `stats.roundsPlayed`
 * still counts one per turn, unchanged, which is what the stat has always
 * meant: how many questions this player was present for.
 */
function creditTurn(state) {
  for (const p of livingPlayers(state)) {
    p.stats = p.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
    p.stats.roundsPlayed = Number(p.stats.roundsPlayed ?? 0) + 1;
  }
}

/** the chain's baseline tier, plus whatever a pick adds on top, capped at 3 */
function difficultyFor(state, bump = 0) {
  const base = 1 + Math.floor(Number(state.chainDepth ?? 0) / 2) + Number(bump ?? 0);
  return Math.min(3, Math.max(1, base));
}

/**
 * `opts.mode` is "open" for a question the WHEEL handed out (the table bets)
 * and "challenge" for one a PICKER aimed (only the picker has a stake). The
 * caller places the picker's bet AFTER this returns, because the quota is
 * priced off the target's accuracy and the target is not `turn.answering`
 * until this function has run.
 */
function enterQuestion(state, username, pool, opts = {}) {
  const player = (state.players ?? []).find((p) => p.username === username);
  if (!player || !player.alive) return enterRoundIntro(state);

  creditTurn(state);

  const difficulty = difficultyFor(state, opts.difficultyBump ?? 0);
  const answerTimeMs = questionTimeFor(Number(state.chainDepth ?? 0));
  state.turn = {
    answering: username,
    mode: opts.mode === "challenge" ? "challenge" : "open",
    picker: opts.picker ?? null,
    question: drawQuestion(state, difficulty, pool),
    askedAt: nowMs(),
    answerTimeMs,
    answer: null,
    answeredInMs: null,
    correct: null,
    timedOut: null,
    answererDelta: 0,
  };
  // a fresh betting book each turn; the POT deliberately carries over
  state.bets = [];
  state.betResults = [];
  state.duel = null;
  state.currentSpin = null;
  state.currentPick = null;
  setPhase(state, "question", answerTimeMs);
  return state;
}

// ─── P2.3: the pick, and the two things a pick can be ──────────────────────

/**
 * What a duel between these two would cost each of them: the fixed ante, capped
 * by the poorer bankroll so both stake the SAME amount and neither can be
 * pushed below zero. Advertised per target on `pick_start` so the picker sees
 * the price before choosing the mode.
 */
function duelAnteBetween(picker, target) {
  const cap = Math.min(Number(picker?.money ?? 0), Number(target?.money ?? 0));
  return Math.max(0, Math.floor(Math.min(DUEL_ANTE, cap)));
}

/**
 * Hand the pick to `picker`. The choices carry the information the choice needs
 * — each target's live quotas (the price of a CHALLENGE on them) and the ante a
 * DUEL with them would cost — so the client renders real numbers rather than
 * guessing at them.
 */
function enterPicking(state, picker) {
  const me = (state.players ?? []).find((p) => p.username === picker);
  const choices = livingPlayers(state).filter((p) => p.username !== picker);
  if (!me || !me.alive || !choices.length) return enterRoundIntro(state);

  setPhase(state, "picking", PICK_TIME_MS);
  state.currentPick = {
    picker,
    choices: choices.map((p) => p.username),
    modes: ["challenge", "duel"],
    targets: choices.map((p) => ({
      username: p.username,
      quotas: quotasForPlayer(p),
      duelAnte: duelAnteBetween(me, p),
    })),
    endsAt: state.phaseEndsAt,
  };
  return state;
}

/**
 * THE DUEL — picker and target race the SAME harder question.
 *
 * Both antes leave their owners and enter the pot HERE, at the start, exactly
 * as a bet's stake does: the money is visibly committed before anyone can see
 * the question, and settlement is a transfer back OUT of the pot. Nothing is
 * created at resolution, which is what keeps the invariant provable.
 */
function enterDuel(state, pickerName, targetName, pool) {
  const picker = (state.players ?? []).find((p) => p.username === pickerName);
  const target = (state.players ?? []).find((p) => p.username === targetName);
  if (!picker?.alive || !target?.alive) return enterRoundIntro(state);

  creditTurn(state);

  const ante = duelAnteBetween(picker, target);
  picker.money -= ante;
  target.money -= ante;
  state.pot = Number(state.pot ?? 0) + ante * 2;

  state.turn = null;
  state.bets = [];
  state.betResults = [];
  state.currentSpin = null;
  state.currentPick = null;
  setPhase(state, "duel", DUEL_TIME_MS);
  state.duel = {
    // room.ts's duels were kind "guess" | "code"; this is the third and the
    // only one anything routes to now
    kind: "race",
    players: [pickerName, targetName],
    picker: pickerName,
    target: targetName,
    ante,
    question: drawQuestion(state, difficultyFor(state, CHALLENGE_DIFFICULTY_BUMP), pool),
    askedAt: nowMs(),
    endsAt: state.phaseEndsAt,
    answers: {},
    firstCorrect: null,
    resolved: false,
    result: null,
  };
  return state;
}

/**
 * Stamp the moment a player went out. FIRST STAMP WINS — an elimination is a
 * one-time event, and a later sweep re-reading a state where they are already
 * dead must not move the time. That matters because the gameover standings
 * rank broke players by WHO SURVIVED LONGER: everyone eliminated has exactly
 * 0 money, so this timestamp is the only thing that separates them, and a
 * re-stamp would silently reorder the final table.
 */
function markEliminated(player, at = nowMs()) {
  if (!player) return null;
  if (!player.eliminatedAt) player.eliminatedAt = at;
  return player.eliminatedAt;
}

/** anyone who has hit zero is out; shared by both resolution paths */
function eliminateBrokePlayers(state) {
  state.eliminated = [];
  const at = nowMs();
  for (const p of state.players ?? []) {
    if (p.alive && p.money <= 0) {
      p.money = 0;
      p.alive = false;
      markEliminated(p, at);
      state.eliminated.push(p.username);
    }
  }
  return state.eliminated;
}

/**
 * Record one racer's submission. Returns the state to write, or null when the
 * submission is not one this duel accepts (a spectator, a second attempt, or
 * one that arrived after the buzzer).
 *
 * SPEED IS THE WHOLE GAME, so the clock read here is the SERVER's — elapsed
 * since `askedAt`, measured when the mutation runs. A client-supplied timestamp
 * would be a self-reported race time.
 *
 * The window closes on the first CORRECT answer and not before: a racer who
 * buzzes in early and gets it WRONG has spent their one attempt, and the other
 * can still take the pot by answering correctly any time before the deadline.
 */
function applyDuelAnswer(state, username, answer) {
  const d = state.duel;
  if (state.phase !== "duel" || !d || d.resolved) return null;
  if (!Array.isArray(d.players) || !d.players.includes(username)) return null;
  d.answers = d.answers ?? {};
  if (d.answers[username]) return null;
  if (nowMs() > Number(state.phaseEndsAt ?? 0)) return null;

  const correct = answer === d.question?.answer;
  d.answers[username] = {
    answer,
    atMs: Math.max(0, nowMs() - Number(d.askedAt ?? nowMs())),
    correct,
  };
  if (correct && !d.firstCorrect) d.firstCorrect = username;

  const everyoneIn = Object.keys(d.answers).length >= d.players.length;
  return correct || everyoneIn ? resolveDuel(state) : state;
}

/**
 * Settle the duel and go to reveal. Idempotent via `resolved`, so a deadline
 * that fires the instant after the second answer landed cannot pay twice.
 *
 *   winner  += 2 × ante   (their own back, plus the loser's)   ← out of the pot
 *   loser    −  ante      (already paid in at the start)
 *
 * (c) NO WINNER — both wrong, or one wrong and one silent, or both silent: the
 * antes STAY IN THE POT. A duel neither player could win costs them both, which
 * is symmetric, conserved, and makes starting one a real decision rather than a
 * free option. A PHOTO FINISH — both correct on the same server millisecond,
 * which needs two submissions to land inside the same tick — goes to the
 * TARGET: the picker chose the moment and the opponent, so the defender takes
 * the tie.
 *
 * The standard WRONG_ANSWER_COST is deliberately NOT charged on top of a lost
 * ante. The ante IS the duel's stake; charging both would price a duel loss at
 * ante + 100 for the loser and make picking a duel strictly worse than a
 * challenge. Stats still record correct/wrong for both racers, so a duel moves
 * the accuracy that prices everyone's future quotas.
 */
function resolveDuel(state) {
  const d = state.duel;
  if (!d || d.resolved) return state;

  const submissions = (d.players ?? []).map((username) => {
    const a = d.answers?.[username] ?? null;
    return {
      username,
      answer: a?.answer ?? null,
      atMs: a ? Number(a.atMs) : null,
      correct: Boolean(a?.correct),
      answered: Boolean(a),
    };
  });

  const finished = submissions
    .filter((s) => s.correct)
    .sort((x, y) => {
      if (x.atMs !== y.atMs) return x.atMs - y.atMs;
      return x.username === d.target ? -1 : 1; // photo finish → the defender
    });

  const winner = finished[0]?.username ?? null;
  const loser = winner ? (d.players ?? []).find((u) => u !== winner) ?? null : null;
  const ante = Math.max(0, Number(d.ante ?? 0));

  let payout = 0;
  let minted = 0;
  if (winner && ante > 0) {
    // GUARANTEED, for the same reason a quota is: the duel promised the winner
    // both antes, so the winner gets both antes. The pair went into the pot
    // moments ago, so this only ever borrows when the pot was ALREADY in
    // deficit from a minted bet payout — and letting that silently shortchange
    // a duel winner would put back exactly the bug settleBets just fixed.
    const potBefore = Number(state.pot ?? 0);
    payout = ante * 2;
    const w = (state.players ?? []).find((p) => p.username === winner);
    if (w) {
      w.money = Number(w.money ?? 0) + payout;
      state.pot = potBefore - payout;
      minted = Math.max(0, payout - Math.max(0, potBefore));
      if (minted > 0) state.minted = Number(state.minted ?? 0) + minted;
    } else {
      payout = 0;
    }
  }

  // a duel answer counts toward accuracy like any other; a no-show counts as
  // wrong, the same way a timed-out turn does
  for (const s of submissions) {
    const p = (state.players ?? []).find((x) => x.username === s.username);
    if (!p) continue;
    p.stats = p.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
    if (s.correct) p.stats.correct = Number(p.stats.correct ?? 0) + 1;
    else p.stats.wrong = Number(p.stats.wrong ?? 0) + 1;
  }

  d.resolved = true;
  d.result = {
    winner,
    loser,
    ante,
    payout,
    minted,
    // net movement per racer, so the client never has to recompute it
    deltas: (d.players ?? []).map((u) => ({
      username: u,
      net: u === winner ? payout - ante : -ante,
    })),
    correctAnswer: d.question?.answer ?? null,
    submissions,
    timedOut: submissions.filter((s) => !s.answered).map((s) => s.username),
  };

  eliminateBrokePlayers(state);
  setPhase(state, "reveal", REVEAL_MS);
  return state;
}

/** resolve the turn: correctness, stats, money. P2.2 settles the pot here. */
function enterReveal(state) {
  const t = state.turn;
  if (!t) return enterRoundIntro(state);

  const timedOut = t.answer === null || t.answer === undefined;
  const correct = !timedOut && t.answer === t.question?.answer;
  t.timedOut = timedOut;
  t.correct = correct;

  const player = (state.players ?? []).find((p) => p.username === t.answering);
  if (player) {
    player.stats = player.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
    if (correct) {
      player.stats.correct = Number(player.stats.correct ?? 0) + 1;
    } else {
      player.stats.wrong = Number(player.stats.wrong ?? 0) + 1;
      const penalty = Math.min(WRONG_ANSWER_COST, player.money);
      player.money = Math.max(0, player.money - penalty);
      // INTO THE POT, not deleted. room.ts destroyed this money; keeping it in
      // the pot is what makes sum(money) + pot invariant, and it means a table
      // full of wrong answers funds the next round's winners.
      state.pot = Number(state.pot ?? 0) + penalty;
      t.answererDelta = -penalty;
    }
  }

  // pay the bets before checking for broke players, so a winner whose payout
  // rescues them from zero is not eliminated a moment before being paid
  settleBets(state);

  // elimination wiring — P2.4 finalises standings and persistence
  eliminateBrokePlayers(state);

  setPhase(state, "reveal", REVEAL_MS);
  return state;
}

/**
 * THE CHAIN, one rule for all three ways a reveal can be reached:
 *
 *   whoever just answered CORRECTLY picks next
 *      · the wheel's victim answered right      → they pick
 *      · a CHALLENGE target answered right      → the TARGET picks, taking the
 *                                                 chain off the picker who
 *                                                 aimed at them
 *      · a DUEL had a winner                    → the WINNER picks
 *   nobody did                                  → back to the wheel, chain
 *                                                 resets to 0 (enterSpin)
 */
function afterReveal(state, pool) {
  if (livingPlayers(state).length <= 1) return enterGameOver(state);

  const d = state.duel;
  if (d?.resolved) {
    const winner = d.result?.winner ?? null;
    const w = winner ? (state.players ?? []).find((p) => p.username === winner) : null;
    state.duel = null;
    return w?.alive ? enterPicking(state, winner) : enterRoundIntro(state);
  }

  const t = state.turn;
  const answerer = t ? (state.players ?? []).find((p) => p.username === t.answering) : null;
  if (t?.correct && answerer?.alive) {
    // NOTE: even with a single possible target the picker still gets the
    // picking phase, because the choice that matters heads-up is not WHO but
    // CHALLENGE-or-DUEL. P2.1 skipped straight to a question here, which would
    // now quietly deny the mode choice at exactly the two-player endgame where
    // a duel is the most interesting thing on the menu.
    return enterPicking(state, t.answering);
  }
  return enterRoundIntro(state);
}

/** what a fired deadline does, per phase */
function advanceOnDeadline(state, pool) {
  switch (state.phase) {
    case "countdown":
      return enterRoundIntro(state);
    case "round_intro":
      return enterSpin(state);
    case "spin":
      return enterQuestion(state, state.currentSpin?.target, pool);
    case "question":
      // ran out of time without answering — room.ts holds no betting pause in
      // that case either, so whatever is on the book settles as it stands
      return enterReveal(state);
    case "betting":
      return enterReveal(state);
    case "duel":
      // the window closed with nobody having answered correctly (or with one
      // racer never answering at all) — resolveDuel handles both
      return resolveDuel(state);
    case "reveal":
      return afterReveal(state, pool);
    case "picking": {
      const choices = state.currentPick?.choices ?? [];
      if (!choices.length) return enterRoundIntro(state);
      // a picker who says nothing still picks: a random target, in CHALLENGE
      // mode, with NO wager. Auto-staking someone's money on a bet they never
      // made would be the one place the engine could lose a player money
      // without them touching anything, and a duel cannot be defaulted into
      // either — it would ante the silent picker AND their target.
      const target = choices[Math.floor(Math.random() * choices.length)];
      state.chainDepth = Number(state.chainDepth ?? 0) + 1;
      return enterQuestion(state, target, pool, {
        mode: "challenge",
        picker: state.currentPick?.picker ?? null,
        difficultyBump: CHALLENGE_DIFFICULTY_BUMP,
      });
    }
    default:
      return null;
  }
}

export {
  advanceOnDeadline,
  afterReveal,
  applyDuelAnswer,
  creditTurn,
  difficultyFor,
  duelAnteBetween,
  eliminateBrokePlayers,
  enterBetting,
  enterDuel,
  enterGameOver,
  enterPicking,
  enterQuestion,
  enterRoundIntro,
  enterReveal,
  enterSpin,
  markEliminated,
  resolveDuel,
};
