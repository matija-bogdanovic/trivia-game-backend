/**
 * ===========================================================================
 * reward_test.mjs — what a correct answer is worth, and where it comes from
 * ===========================================================================
 *   node scripts/reward_test.mjs
 *
 * The rule under test: a correct answer collects
 *
 *     min(100 + 25 * chainDepth, whatever the pot still holds)
 *
 * paid AFTER the bets, out of the pot and nowhere else.
 *
 * The assertion that matters most is not the arithmetic — it is that this
 * cannot mint. A reward that invented money would inflate the economy until
 * nobody reaches zero, and elimination is the whole game. So every case here
 * checks the ledger identity as well as the payout:
 *
 *     sum(players.money) + pot   is unchanged by a transfer
 * ===========================================================================
 */
import { enterReveal } from "../lambda-ws/lib/phases.mjs";
import { correctAnswerReward } from "../lambda-ws/lib/config.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "\n       " + extra : ""}`); }
};

const ledger = (s) => s.players.reduce((n, p) => n + Number(p.money ?? 0), 0) + Number(s.pot ?? 0);

/** a turn that has been answered, ready for the reveal */
function answered({ correct = true, pot = 500, chainDepth = 0, bets = [], money = 500 } = {}) {
  return {
    phase: "question",
    round: 1,
    chainDepth,
    pot,
    minted: 0,
    phaseEndsAt: Date.now() + 1000,
    players: [
      { username: "answerer", money, alive: true, stats: { correct: 0, wrong: 0 } },
      { username: "bettor", money, alive: true, stats: { correct: 4, wrong: 4 } },
    ],
    bets,
    betResults: [],
    turn: {
      answering: "answerer",
      mode: "open",
      picker: null,
      question: { text: "?", options: ["a", "b"], answer: "a" },
      askedAt: Date.now() - 1000,
      answer: correct ? "a" : "b",
      correct: null,
      timedOut: null,
      answererDelta: 0,
    },
  };
}

console.log("\nthe size of it");
{
  ok("a correct answer at chain 0 is worth 100", correctAnswerReward(0) === 100);
  ok("each link adds 25", correctAnswerReward(4) === 200, `${correctAnswerReward(4)}`);
  ok("a missing depth is treated as zero", correctAnswerReward(undefined) === 100);
  ok("a negative depth cannot reduce it", correctAnswerReward(-9) === 100);
}

console.log("\npaid out of the pot, and only out of the pot");
{
  const s = answered({ pot: 500 });
  const before = ledger(s);
  enterReveal(s);
  const answerer = s.players[0];
  ok("the answerer is paid", answerer.money === 600, `${answerer.money}`);
  ok("and the pot paid for it", s.pot === 400, `${s.pot}`);
  ok("nothing was invented", ledger(s) === before, `${before} -> ${ledger(s)}`);
  ok("the delta is reported", s.turn.answererDelta === 100);
  ok("and nothing was minted", Number(s.minted ?? 0) === 0);
}

console.log("\nan empty pot pays nothing, honestly");
{
  const s = answered({ pot: 0 });
  const before = ledger(s);
  enterReveal(s);
  ok("the answer is worth zero", s.players[0].money === 500, `${s.players[0].money}`);
  ok("the pot is not driven negative", s.pot >= 0, `${s.pot}`);
  ok("the ledger is untouched", ledger(s) === before);
  ok("and no mint happened", Number(s.minted ?? 0) === 0);
}

console.log("\na pot with less than the reward pays what it has");
{
  const s = answered({ pot: 30 });
  enterReveal(s);
  ok("it pays exactly what was there", s.players[0].money === 530, `${s.players[0].money}`);
  ok("and empties the pot rather than overdrawing it", s.pot === 0, `${s.pot}`);
}

console.log("\nthe bets are paid FIRST, and their promise still holds");
{
  /*
   * A winning stake is paid its full quoted price even when the pot must go
   * into deficit for it. The reward is not a promise and takes what is left —
   * which here is nothing, because the bet emptied it.
   */
  const s = answered({
    pot: 100,
    bets: [{ username: "bettor", side: "correct", amount: 100, quota: 2 }],
  });
  s.players[1].money = 400; // the stake already left the wallet
  const before = ledger(s);
  enterReveal(s);
  const bettor = s.players[1];
  ok("the bettor is paid the full 2.00x", bettor.money === 600, `${bettor.money}`);
  ok("which took the pot into deficit", s.pot < 0, `${s.pot}`);
  ok("so the correct answer earns nothing", s.players[0].money === 500, `${s.players[0].money}`);
  ok("the reward did NOT deepen the deficit", s.pot === -100, `${s.pot}`);
  /*
   * The ledger is UNCHANGED, not raised by the mint. This assertion had it
   * backwards first time.
   *
   * `minted` is not money added to the world — it is the DEPTH OF THE POT'S
   * DEFICIT, a measure of how much has been paid out that the game did not
   * have. The payment is still a transfer, so sum(money) + pot holds exactly;
   * the deficit lives in `pot`, which is why pot may be negative and minted is
   * how far. Later losses repay it.
   */
  ok("the ledger is still exactly balanced", ledger(s) === before,
     `before=${before} after=${ledger(s)}`);
  ok("the mint records the deficit rather than adding to the world",
     Number(s.minted ?? 0) === 100 && s.pot === -100,
     `minted=${s.minted} pot=${s.pot}`);
  ok("and the deficit never exceeds what was minted",
     -s.pot <= Number(s.minted ?? 0), `pot=${s.pot} minted=${s.minted}`);
}

console.log("\na wrong answer is unchanged");
{
  const s = answered({ correct: false, pot: 500 });
  const before = ledger(s);
  enterReveal(s);
  ok("it still costs a hundred", s.players[0].money === 400, `${s.players[0].money}`);
  ok("which goes INTO the pot", s.pot === 600, `${s.pot}`);
  ok("and the delta is negative", s.turn.answererDelta === -100);
  ok("the ledger holds", ledger(s) === before);
}

console.log("\ndeep in a chain it is worth more");
{
  const s = answered({ pot: 1000, chainDepth: 4 });
  enterReveal(s);
  ok("chain 4 pays 200", s.players[0].money === 700, `${s.players[0].money}`);
  ok("still out of the pot", s.pot === 800, `${s.pot}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
