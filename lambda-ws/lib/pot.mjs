/**
 * ===========================================================================
 * lib/pot.mjs — the money: who may bet, what it costs, and settlement
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { MIN_BET, QUOTA_MAX, QUOTA_MIN, QUOTA_PRIOR_WEIGHT } from "./config.mjs";
import { livingPlayers } from "./turn.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// THE POT — betting, quotas, settlement
// ═══════════════════════════════════════════════════════════════════════════
//
// THE LEDGER IDENTITY, which every path here still honours:
//
//     sum(players[].money) + pot   is constant for the entire match
//
// A stake leaves the bettor and enters the pot; a payout leaves the pot and
// enters the winner; a wrong answer's penalty leaves the answerer and ENTERS
// THE POT rather than vanishing. room.ts did the opposite on both counts — it
// paid winners out of nowhere and deleted the wrong-answer penalty — which is
// why money there could inflate and why nothing guaranteed anyone reached zero.
//
// WHAT IS NO LONGER TRUE, since Matija's payout ruling: the pot is not floored
// at zero. A winning bet is paid its full quoted price and the pot absorbs any
// shortfall as debt, so `pot` may be negative and `minted` counts how much has
// been paid out that the game did not have. The identity above is unaffected —
// the deficit lives in `pot`, not in thin air — and the deficit is repaid by
// the very next losing stake or wrong-answer penalty.
//
// Money still concentrates: individuals are eliminated at 0 and the survivor
// ends up holding it. Losing bets, penalties and lost duel antes are what drive
// that, and none of them changed. The mint slows the drain; it does not stop
// it, because a payout is capped at 2× a stake and a stake is capped at the
// bettor's own bankroll.

/**
 * Alive, not the one answering, and holding at least the minimum stake.
 *
 * (a) A CHALLENGE HAS EXACTLY ONE BETTOR: THE PICKER. A challenge is a private
 * wager between the picker and the pot — the picker chose the victim, the price
 * is the victim's own accuracy, and the stake was committed blind at pick time
 * before the question was drawn. Opening that book to the table would let
 * everyone else bet on a question the picker aimed and after the picker's own
 * money was already down, which is a different game from the one Matija
 * described. So the table SPECTATES a challenge: no open betting, and therefore
 * no betting pause after the answer — it resolves straight to reveal.
 * Table-wide betting is alive and unchanged on the WHEEL's questions, which is
 * where P2.2 put it.
 */
function bettorsFor(state) {
  const t = state.turn;
  if (!t) return [];
  if (t.mode === "challenge") return [];
  return livingPlayers(state).filter(
    (p) => p.username !== t.answering && p.money >= MIN_BET
  );
}

/** eligible players who have not yet declared (a stake OR an abstain) */
function pendingBettors(state) {
  const placed = new Set((state.bets ?? []).map((b) => b.username));
  return bettorsFor(state).filter((p) => !placed.has(p.username));
}

/** smoothed in-match accuracy of a player: correct / (correct + wrong) */
function accuracyOf(player) {
  const c = Number(player?.stats?.correct ?? 0);
  const w = Number(player?.stats?.wrong ?? 0);
  return (c + QUOTA_PRIOR_WEIGHT * 0.5) / (c + w + QUOTA_PRIOR_WEIGHT);
}

/**
 * Quotas for the current turn, derived from the ANSWERING player's accuracy.
 *
 * A quota is the GROSS return multiple: the stake has already gone into the
 * pot, so a winner receives stake × quota back. The fair price of an outcome
 * with probability q is 1/q — which makes an even-money 50/50 pay exactly 2.0,
 * the cap. Betting the likely outcome therefore pays LESS than double, and the
 * unlikely one is pinned at the 2.0 ceiling.
 *
 *   answerer 80% accurate →  correct 1.25×   wrong 2.00× (capped from 5.0)
 *   answerer 50% accurate →  correct 2.00×   wrong 2.00×
 *   answerer 20% accurate →  correct 2.00×   wrong 1.25×
 *
 * The quota is LOCKED onto each bet when it is placed, never recomputed at
 * settlement — by then the answerer's stats already include the very outcome
 * being paid out, which would price the bet using its own result.
 */
function quotasForPlayer(player) {
  const p = player ? accuracyOf(player) : 0.5;
  const price = (q) =>
    Math.round(Math.min(QUOTA_MAX, Math.max(QUOTA_MIN, 1 / Math.max(q, 0.01))) * 100) / 100;
  return {
    correct: price(p),
    wrong: price(1 - p),
    accuracy: Math.round(p * 1000) / 1000,
  };
}

function quotasFor(state) {
  const t = state.turn;
  const answerer = t
    ? (state.players ?? []).find((p) => p.username === t.answering)
    : null;
  return quotasForPlayer(answerer);
}

/**
 * Pay the winners, exactly once per turn. THE QUOTA IS A PROMISE.
 *
 * ── WHAT CHANGED, AND WHY ─────────────────────────────────────────────────
 * P2.2 treated the pot as a hard ceiling: if it could not cover everything
 * owed, every payout was scaled down by the same factor. That kept money
 * strictly conserved, but it made the advertised price a lie — the live P2.3
 * run staked 150 at a quota of 2.00 and paid back exactly 150, a WINNING bet
 * that gained nothing, because the pot held only that same stake. The number
 * on the button said 2.00× and the number in the wallet said 1.00×.
 *
 * Matija's call: the displayed gain must be real. A winner now receives the
 * FULL stake × quota, always, and when the pot cannot cover it the shortfall
 * is MINTED rather than deducted from the winner.
 *
 * ── THE NEW ACCOUNTING ────────────────────────────────────────────────────
 * The pot is now allowed to go NEGATIVE. That is the whole mechanism: a payout
 * it cannot fund is borrowed against it, and later losses repay the debt. Two
 * facts fall out, and both are checked by the tests:
 *
 *   sum(players[].money) + pot   is STILL constant.
 *       Every movement is still a transfer. Nothing appears inside the ledger
 *       — the money comes from the pot going into deficit.
 *
 *   pot >= 0                     is NO LONGER true.
 *       `max(0, -pot)` is the outstanding debt: what has been paid out that
 *       the game did not have. `state.minted` is the cumulative measure of it
 *       across the match, and -pot <= minted holds always, because inflows
 *       only ever repay.
 *
 * ── WHY THIS DOES NOT INFLATE AWAY ────────────────────────────────────────
 * The mint is bounded by construction, not by a limiter: a payout can never
 * exceed 2× the stake (QUOTA_MAX), and a stake can never exceed the bettor's
 * own bankroll — so a turn cannot mint more than the money staked on it. Every
 * losing stake and every WRONG_ANSWER_COST still flows INTO the pot, and those
 * repay the deficit before any of it is minted again. Elimination still works
 * the way it did: it is driven by losing bets, wrong-answer penalties and lost
 * duel antes, all of which take money OUT of players and put it in the pot.
 * The game still trends toward one player holding everything — it just no
 * longer refuses to pay a winner the price it quoted them.
 */
function settleBets(state) {
  const t = state.turn;
  if (!t || t.betsSettled) return [];

  const staked = (state.bets ?? []).filter(
    (b) => b.side === "correct" || b.side === "wrong"
  );
  const isWinner = (b) => (b.side === "correct") === Boolean(t.correct);

  const potBefore = Number(state.pot ?? 0);
  let paid = 0;

  const results = [];
  for (const b of staked) {
    const won = isWinner(b);
    let payout = 0;
    if (won) {
      // the FULL price, floored to whole coins. No scale factor: what the
      // button advertised is what lands in the wallet
      payout = Math.floor(b.amount * b.quota);
      const p = (state.players ?? []).find((x) => x.username === b.username);
      if (p) {
        p.money += payout;
        state.pot = Number(state.pot ?? 0) - payout;
        paid += payout;
        p.stats = p.stats ?? { correct: 0, wrong: 0, betsWon: 0, maxBetWin: 0, roundsPlayed: 0 };
        p.stats.betsWon = Number(p.stats.betsWon ?? 0) + 1;
        p.stats.maxBetWin = Math.max(Number(p.stats.maxBetWin ?? 0), payout - b.amount);
      }
    }
    results.push({
      username: b.username,
      side: b.side,
      amount: b.amount,
      quota: b.quota,
      won,
      payout,
      // gain, which is now always amount × (quota − 1) for a winner
      net: payout - b.amount,
    });
  }

  // what the pot could not fund. A pot already in deficit contributes nothing,
  // hence max(0, potBefore) rather than potBefore
  const minted = Math.max(0, paid - Math.max(0, potBefore));
  if (minted > 0) state.minted = Number(state.minted ?? 0) + minted;

  t.betsSettled = true;
  t.betMinted = minted;
  // kept on the wire for clients that read it — it is now always 1, because
  // payouts are never scaled. Retired rather than removed.
  t.betScale = 1;
  state.betResults = results;
  return results;
}

export {
  accuracyOf,
  bettorsFor,
  pendingBettors,
  quotasFor,
  quotasForPlayer,
  settleBets,
};
