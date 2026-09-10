/**
 * ===========================================================================
 * duel_test.mjs — the race, and who wins it
 * ===========================================================================
 *   node scripts/duel_test.mjs
 *
 * phases.mjs imports cleanly, so this exercises the real applyDuelAnswer and
 * resolveDuel against hand-built states. No stubbing and no mocks: the
 * functions under test are the ones that ship.
 *
 * The rule that needed a test is the one that just changed. applyDuelAnswer
 * used to resolve on the FIRST correct answer, which ended the duel before
 * the other racer could press anything — from their side the button simply
 * did nothing. It now waits for both, or for the clock.
 * ===========================================================================
 */
import {
  applyDuelAnswer,
  advanceOnDeadline,
  enterDuel,
} from "../lambda-ws/lib/phases.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "\n       " + extra : ""}`); }
};

/** two racers, one question, a clock that has not run out */
function duelState({ ante = 100, money = 500, askedAgo = 0 } = {}) {
  const now = Date.now();
  return {
    phase: "duel",
    round: 1,
    chainDepth: 1,
    pot: 300,
    minted: 0,
    phaseEndsAt: now + 20000,
    players: [
      { username: "caller", money, alive: true, stats: { correct: 0, wrong: 0 } },
      { username: "defender", money, alive: true, stats: { correct: 0, wrong: 0 } },
    ],
    duel: {
      players: ["caller", "defender"],
      picker: "caller",
      target: "defender",
      ante,
      askedAt: now - askedAgo,
      question: { text: "?", options: ["a", "b"], answer: "a" },
      answers: {},
    },
  };
}

console.log("\nthe race runs until both have raced");
{
  const s = duelState();
  const after = applyDuelAnswer(s, "caller", "a");   // correct, and first
  ok("a correct answer does NOT end the duel on its own",
     after?.phase === "duel", `phase=${after?.phase}`);
  ok("and the other racer can still answer",
     applyDuelAnswer(s, "defender", "b") !== null);
  ok("once both are in, it resolves", s.duel.resolved === true);
}

console.log("\nfastest correct answer wins");
{
  const s = duelState();
  s.duel.askedAt = Date.now() - 5000;
  applyDuelAnswer(s, "caller", "b");                 // wrong
  applyDuelAnswer(s, "defender", "a");               // slower, but right
  const r = s.duel.result;
  ok("the slower CORRECT racer beats the faster wrong one", r.winner === "defender");
  ok("the loser is named", r.loser === "caller");
  ok("the winner takes both antes", r.payout === 200, `payout=${r.payout}`);
  ok("both times are reported",
     r.submissions.every((x) => typeof x.atMs === "number"));
  ok("the deltas cancel out", r.deltas.reduce((n, d) => n + d.net, 0) === 0);
}

console.log("\nnobody correct — through the REAL entry point");
{
  /*
   * Built with enterDuel rather than by hand, because the ante is charged
   * THERE and not at settlement. The first version of this test asserted on a
   * state that had never been through it and failed on money nobody had taken
   * — the test was wrong, not the engine.
   */
  const s = duelState();
  const before = s.players.reduce((n, p) => n + p.money, 0) + s.pot;
  enterDuel(s, "caller", "defender", [
    { question_id: "q", text: "?", options: ["a", "b"], answer: "a", difficulty: 1 },
  ]);
  ok("entering a duel takes an ante from each",
     s.players.every((p) => p.money === 400), s.players.map((p) => p.money).join(","));

  const answer = s.duel.question.answer === "a" ? "b" : "a";  // deliberately wrong
  applyDuelAnswer(s, "caller", answer);
  applyDuelAnswer(s, "defender", answer);
  const r = s.duel.result;
  ok("there is no winner", r.winner === null);
  ok("nothing is paid out", r.payout === 0);
  /*
   * Both antes STAY IN THE POT. A duel neither player could win costs them
   * both, which is what keeps money moving toward elimination rather than
   * being handed back.
   */
  ok("the antes are still gone from the players",
     s.players.every((p) => p.money === 400), s.players.map((p) => p.money).join(","));
  ok("and the ledger still balances",
     s.players.reduce((n, p) => n + p.money, 0) + s.pot === before,
     `before=${before} after=${s.players.reduce((n, p) => n + p.money, 0) + s.pot}`);
}

console.log("\nthe clock, when somebody never answers");
{
  const s = duelState();
  applyDuelAnswer(s, "caller", "b");                 // wrong, and alone
  ok("one answer alone leaves the duel running", s.duel.resolved !== true);

  s.phaseEndsAt = Date.now() - 1;                    // the deadline fires
  advanceOnDeadline(s, []);
  ok("the deadline resolves it", s.duel.resolved === true);
  const r = s.duel.result;
  ok("the one who never answered is listed as timed out",
     r.timedOut.includes("defender"), JSON.stringify(r.timedOut));
  ok("and nobody wins on a wrong answer alone", r.winner === null);
}

console.log("\na late answer is refused, and says why");
{
  const s = duelState();
  s.phaseEndsAt = Date.now() - 1;
  ok("past the buzzer returns null", applyDuelAnswer(s, "caller", "a") === null);
  ok("and names the reason", s.lastAnswerRefusal === "too-late", s.lastAnswerRefusal);

  const t = duelState();
  ok("a spectator cannot race", applyDuelAnswer(t, "nobody", "a") === null);
  ok("and is told so", t.lastAnswerRefusal === "not-racing", t.lastAnswerRefusal);

  const u = duelState();
  applyDuelAnswer(u, "caller", "a");
  ok("answering twice is refused", applyDuelAnswer(u, "caller", "b") === null);
  ok("and named", u.lastAnswerRefusal === "already", u.lastAnswerRefusal);
}

console.log("\nthe ante cannot take money nobody has");
{
  // capped by the POORER duelist, so neither balance can go negative
  const s = duelState({ money: 40 });
  s.players[0].money = 40;
  s.players[1].money = 500;
  applyDuelAnswer(s, "caller", "a");
  applyDuelAnswer(s, "defender", "b");
  ok("no balance went negative", s.players.every((p) => p.money >= 0),
     s.players.map((p) => `${p.username}=${p.money}`).join(" "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
