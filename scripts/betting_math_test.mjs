/**
 * betting_math_test.mjs — does a winning bet actually pay what the button said?
 *
 * Matija's question was the plain one: "1/1 da dobijam sumu puta dva" — if I
 * stake 100 at 2.00×, do I end up 100 richer? That is what this checks, along
 * with the ledger identity the whole pot design rests on:
 *
 *     sum(players[].money) + pot   is constant across a settlement
 *
 * Pure functions only, so it runs offline with no AWS and no table.
 */
import { quotasForPlayer, settleBets, bettorsFor } from "../lambda-ws/lib/pot.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

/** a bettor placing `amount` on `side`, priced off an answerer of accuracy p */
function table({ answererCorrect, stake, side, accuracy = 0.5, pot = 0, money = 1000 }) {
  const answerer = {
    username: "target", money: 1000, alive: true,
    // stats chosen so accuracyOf() lands on `accuracy` with the prior folded in
    stats: { correct: 0, wrong: 0 },
  };
  // solve (c + 2) / (c + w + 4) = accuracy for a whole-numbered pair
  const n = 96;
  answerer.stats.correct = Math.round(accuracy * (n + 4) - 2);
  answerer.stats.wrong = n - answerer.stats.correct;

  const bettor = { username: "me", money, alive: true, stats: { correct: 0, wrong: 0 } };
  const quota = quotasForPlayer(answerer)[side];

  const state = {
    players: [answerer, bettor],
    pot,
    minted: 0,
    turn: { answering: "target", correct: answererCorrect, mode: "open" },
    bets: [],
  };

  // place the bet exactly as onPlaceBet does: out of pocket, into the pot
  bettor.money -= stake;
  state.pot += stake;
  state.bets.push({ username: "me", side, amount: stake, quota });

  const before = state.players.reduce((s, p) => s + p.money, 0) + state.pot;
  const results = settleBets(state);
  const after = state.players.reduce((s, p) => s + p.money, 0) + state.pot;

  return { state, quota, results, bettor, before, after, startedWith: money };
}

console.log("\nquotas");
{
  const even = quotasForPlayer({ stats: { correct: 48, wrong: 48 } });
  ok("a 50% answerer prices both sides at 2.00", even.correct === 2 && even.wrong === 2,
     JSON.stringify(even));
  const strong = quotasForPlayer({ stats: { correct: 78, wrong: 18 } });
  ok("a strong answerer is cheap to back and dear to fade",
     strong.correct < 1.5 && strong.wrong === 2, JSON.stringify(strong));
  const fresh = quotasForPlayer({ stats: { correct: 0, wrong: 0 } });
  ok("no history quotes exactly even money", fresh.correct === 2 && fresh.wrong === 2);
}

console.log("\nthe 1/1 case Matija asked about");
{
  const r = table({ answererCorrect: false, stake: 100, side: "wrong", accuracy: 0.5 });
  ok("quoted at 2.00", r.quota === 2, `got ${r.quota}`);
  ok("stake 100 returns 200", r.results[0].payout === 200, `got ${r.results[0].payout}`);
  ok("wallet is exactly 100 up", r.bettor.money === r.startedWith + 100,
     `${r.startedWith} -> ${r.bettor.money}`);
  ok("reported net is +100", r.results[0].net === 100, `got ${r.results[0].net}`);
}

console.log("\nlosing, and the odds-on case");
{
  const lost = table({ answererCorrect: true, stake: 100, side: "wrong", accuracy: 0.5 });
  ok("a losing stake pays nothing", lost.results[0].payout === 0);
  ok("and costs exactly the stake", lost.bettor.money === lost.startedWith - 100);

  const odds = table({ answererCorrect: true, stake: 100, side: "correct", accuracy: 0.8 });
  ok("backing an 80% answerer pays 1.25x, not 2x", odds.quota === 1.25, `got ${odds.quota}`);
  ok("so 100 returns 125", odds.results[0].payout === 125, `got ${odds.results[0].payout}`);
  ok("a gain of 25", odds.bettor.money === odds.startedWith + 25);
}

console.log("\nthe ledger identity");
for (const [name, args] of [
  ["won, empty pot", { answererCorrect: false, stake: 100, side: "wrong", pot: 0 }],
  ["won, fat pot", { answererCorrect: false, stake: 250, side: "wrong", pot: 5000 }],
  ["lost", { answererCorrect: true, stake: 250, side: "wrong", pot: 300 }],
  ["all-in", { answererCorrect: false, stake: 1000, side: "wrong", pot: 0, money: 1000 }],
]) {
  const r = table(args);
  ok(`money is conserved (${name})`, r.before === r.after, `${r.before} -> ${r.after}`);
}

console.log("\nminting: a promise the pot could not fund");
{
  const r = table({ answererCorrect: false, stake: 100, side: "wrong", pot: 0 });
  ok("paid the full 200 from a pot holding only the 100 stake",
     r.results[0].payout === 200);
  ok("and recorded the 100 it had to mint", r.state.minted === 100, `got ${r.state.minted}`);
  ok("the pot went into deficit rather than shortchanging the winner",
     r.state.pot === -100, `got ${r.state.pot}`);
}

console.log("\nwho may bet");
{
  const s = {
    turn: { answering: "target", mode: "open" },
    players: [
      { username: "target", alive: true, money: 500 },
      { username: "rich", alive: true, money: 500 },
      { username: "broke", alive: true, money: 5 },
      { username: "dead", alive: false, money: 500 },
    ],
  };
  const names = bettorsFor(s).map((p) => p.username);
  ok("not the answerer, not the dead, not under the minimum",
     JSON.stringify(names) === JSON.stringify(["rich"]), JSON.stringify(names));
  ok("a challenge takes no side bets",
     bettorsFor({ ...s, turn: { ...s.turn, mode: "challenge" } }).length === 0);
}

console.log("\nsettling twice");
{
  const r = table({ answererCorrect: false, stake: 100, side: "wrong" });
  const moneyAfterFirst = r.bettor.money;
  const again = settleBets(r.state);
  ok("a second settlement pays nothing", again.length === 0 && r.bettor.money === moneyAfterFirst);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
