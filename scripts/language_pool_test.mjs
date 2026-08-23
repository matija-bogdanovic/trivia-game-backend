/**
 * ===========================================================================
 * language_pool_test.mjs — the language filter and the deck seed, offline
 * ===========================================================================
 *   node scripts/language_pool_test.mjs
 *
 * Exercises lambda-ws/lib/questions.mjs directly: no AWS, no network. The two
 * things under test are the ones that would silently serve the wrong thing:
 *
 *   idsForLanguage()  the fallback rule — a thin language must fall back to
 *                     English rather than deal the same dozen cards all match
 *   drawQuestion()    the deck seed. It used to start empty and stay empty,
 *                     so every draw fell through to generated arithmetic and
 *                     the whole table was unreachable. The regression test for
 *                     that is "a draw returns something from the table at all".
 *
 * MATH_QUESTION_CHANCE means ~30% of draws are generated arithmetic by design.
 * Those carry a `math-` id and are filtered out before the language of a draw
 * is judged — arithmetic is language-neutral and is supposed to appear.
 * ===========================================================================
 */

import {
  drawQuestion,
  idsForLanguage,
  sliceForDeck,
  withShuffledOptions,
} from "../lambda-ws/lib/questions.mjs";
import {
  DECK_SLICE_SIZE,
  DECK_USED_LIMIT,
  MIN_LANGUAGE_POOL,
} from "../lambda-ws/lib/config.mjs";

let pass = 0;
const failures = [];
function check_silent(cond, label) {
  if (cond) return;
  failures.push(label);
  console.log(`  FAIL ${label}`);
}

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

/** a pool of `n` questions per language, difficulty spread across 1..3 */
function makePool(counts) {
  const byId = new Map();
  const idsByLang = new Map();
  const ids = [];
  for (const [lang, n] of Object.entries(counts)) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const id = `${lang}-${i}`;
      byId.set(id, {
        id,
        text: `${lang} question ${i}`,
        // MIRRORS THE REAL TABLE: every stored row is [answer, ...wrong], so
        // the answer is at index 0. A fixture that pre-shuffled would make the
        // shuffle tests pass without the shuffle.
        options: ["a", "b", "c", "d"],
        answer: "a",
        difficulty: (i % 3) + 1,
        language: lang,
      });
      list.push(id);
      ids.push(id);
    }
    idsByLang.set(lang, list);
  }
  return { byId, ids, idsByLang };
}

const langOf = (pool, q) => pool.byId.get(q.id)?.language ?? "(generated)";

console.log(`\nMIN_LANGUAGE_POOL = ${MIN_LANGUAGE_POOL}\n`);

console.log("── idsForLanguage: a healthy language is used as-is ──");
{
  const pool = makePool({ en: 500, sr: 400 });
  check("sr chosen", idsForLanguage(pool, "sr").length, 400);
  check("en chosen", idsForLanguage(pool, "en").length, 500);
}

console.log("\n── idsForLanguage: a thin language falls back to English ──");
{
  const pool = makePool({ en: 500, sr: MIN_LANGUAGE_POOL - 1 });
  check("thin sr -> en", idsForLanguage(pool, "sr").length, 500);
  const exact = makePool({ en: 500, sr: MIN_LANGUAGE_POOL });
  check("exactly at the threshold stays sr", idsForLanguage(exact, "sr").length, MIN_LANGUAGE_POOL);
}

console.log("\n── idsForLanguage: an unknown language falls back too ──");
{
  const pool = makePool({ en: 500 });
  check("de -> en", idsForLanguage(pool, "de").length, 500);
}

console.log("\n── idsForLanguage: both thin -> everything there is ──");
{
  const pool = makePool({ en: 5, sr: 5 });
  check("last resort is the whole pool", idsForLanguage(pool, "sr").length, 10);
}

console.log("\n── drawQuestion SEEDS the deck (the bug that made the table unreachable) ──");
{
  const pool = makePool({ en: 200, sr: 200 });
  const state = { language: "en", deck: { fresh: [], used: [] } };
  let fromTable = 0;
  for (let i = 0; i < 200; i++) {
    const q = drawQuestion(state, 2, pool);
    if (!String(q.id).startsWith("math-")) fromTable++;
  }
  check("draws reach the table at all", fromTable > 0, true);
  // ~30% are arithmetic by design, so ~70% of 200 should be table questions
  check("most draws are table questions", fromTable > 100, true);
  check("deck was seeded", state.deck.deckLanguage, "en");
}

console.log("\n── a match never mixes languages ──");
{
  for (const language of ["en", "sr"]) {
    const pool = makePool({ en: 200, sr: 200 });
    const state = { language, deck: { fresh: [], used: [] } };
    const wrong = [];
    for (let i = 0; i < 300; i++) {
      const q = drawQuestion(state, ((i % 3) + 1), pool);
      if (String(q.id).startsWith("math-")) continue;
      const l = langOf(pool, q);
      if (l !== language) wrong.push(l);
    }
    check(`${language} match served only ${language}`, wrong.length, 0);
  }
}

console.log("\n── a thin Serbian pool plays in English rather than repeating ──");
{
  const pool = makePool({ en: 300, sr: 10 });
  const state = { language: "sr", deck: { fresh: [], used: [] } };
  const langs = new Set();
  for (let i = 0; i < 200; i++) {
    const q = drawQuestion(state, 2, pool);
    if (String(q.id).startsWith("math-")) continue;
    langs.add(langOf(pool, q));
  }
  check("fell back to en", [...langs], ["en"]);
}

console.log("\n── the deck reshuffles inside its own language when exhausted ──");
{
  const pool = makePool({ en: 300, sr: 60 });
  const state = { language: "sr", deck: { fresh: [], used: [] } };
  const langs = new Set();
  // far more draws than the 60-question sr pool holds, forcing a reshuffle
  for (let i = 0; i < 400; i++) {
    const q = drawQuestion(state, 2, pool);
    if (String(q.id).startsWith("math-")) continue;
    langs.add(langOf(pool, q));
  }
  check("still only sr after wrapping", [...langs], ["sr"]);
  check("deck language unchanged", state.deck.deckLanguage, "sr");
}

console.log("\n── no language set (an old match state) plays English ──");
{
  const pool = makePool({ en: 200, sr: 200 });
  const state = { deck: { fresh: [], used: [] } };
  const langs = new Set();
  for (let i = 0; i < 150; i++) {
    const q = drawQuestion(state, 1, pool);
    if (String(q.id).startsWith("math-")) continue;
    langs.add(langOf(pool, q));
  }
  check("defaults to en", [...langs], ["en"]);
}

console.log("\n── the deck is BOUNDED — it must never hold the whole pool ──");
{
  const pool = makePool({ en: 5289, sr: 5277 });
  const state = { language: "en", deck: { fresh: [], used: [] } };
  // draw until the deck is actually seeded — ~30% of draws return arithmetic
  // and never reach the seeding branch, so one call can leave it untouched and
  // make every assertion below pass on an empty deck
  for (let i = 0; i < 50 && !state.deck.deckLanguage; i++) drawQuestion(state, 2, pool);
  check("the deck really was seeded", state.deck.deckLanguage, "en");
  check("slice holds something", state.deck.fresh.length > 0, true);
  check("slice is capped", state.deck.fresh.length <= DECK_SLICE_SIZE, true);
  check("slice is not the whole pool", state.deck.fresh.length < 200, true);

  // the record is PUT in full every phase transition, so its size is the point
  const bytes = JSON.stringify(state.deck).length;
  check("deck serialises small (<10KB)", bytes < 10_000, true);
  console.log(`       deck is ${(bytes / 1024).toFixed(1)}KB, vs ~160KB for the full pool`);
}

console.log("\n── it refills when the slice runs dry, and stays bounded ──");
{
  const pool = makePool({ en: 5289 });
  const state = { language: "en", deck: { fresh: [], used: [] } };
  let fromTable = 0;
  let maxFresh = 0;
  for (let i = 0; i < 900; i++) {
    const q = drawQuestion(state, ((i % 3) + 1), pool);
    if (!String(q.id).startsWith("math-")) fromTable++;
    maxFresh = Math.max(maxFresh, state.deck.fresh.length);
  }
  check("kept dealing past one slice", fromTable > DECK_SLICE_SIZE, true);
  check("fresh never exceeded the cap", maxFresh <= DECK_SLICE_SIZE, true);
  check("used stayed under its cap", state.deck.used.length <= DECK_USED_LIMIT, true);
}

console.log("\n── no repeats inside a match, across a refill ──");
{
  const pool = makePool({ en: 5289 });
  const state = { language: "en", deck: { fresh: [], used: [] } };
  const seen = [];
  for (let i = 0; i < 400; i++) {
    const q = drawQuestion(state, 2, pool);
    if (!String(q.id).startsWith("math-")) seen.push(q.id);
  }
  check("every table question was distinct", new Set(seen).size, seen.length);
  check("and there were plenty of them", seen.length > DECK_SLICE_SIZE, true);
}

console.log("\n── a pool smaller than one slice still works ──");
{
  const pool = makePool({ en: 60 });
  const state = { language: "en", deck: { fresh: [], used: [] } };
  let fromTable = 0;
  for (let i = 0; i < 300; i++) {
    const q = drawQuestion(state, 2, pool);
    if (!String(q.id).startsWith("math-")) fromTable++;
  }
  // 60 questions, ~210 non-math draws: it must wrap rather than dry up
  check("wraps instead of drying up", fromTable > 150, true);
}

console.log("\n── sliceForDeck avoids what was already asked ──");
{
  const pool = makePool({ en: 300 });
  const used = idsForLanguage(pool, "en").slice(0, 250);
  const slice = sliceForDeck(pool, "en", used);
  check("only unasked ids offered", slice.filter((id) => used.includes(id)).length, 0);
  check("offered what remained", slice.length, 50);
  check("nothing left to offer -> empty", sliceForDeck(pool, "en", idsForLanguage(pool, "en")).length, 0);
}

console.log("\n── OPTIONS ARE SHUFFLED PER DRAW (the answer was always button 1) ──");
{
  const pool = makePool({ en: 400 });
  const state = { language: "en", deck: { fresh: [], used: [] } };
  const positions = {};
  let table = 0;
  for (let i = 0; i < 600; i++) {
    const q = drawQuestion(state, ((i % 3) + 1), pool);
    if (String(q.id).startsWith("math-")) continue;
    table++;
    const idx = q.options.indexOf(q.answer);
    positions[idx] = (positions[idx] ?? 0) + 1;
    if (!q.options.includes(q.answer)) throw new Error("answer lost in shuffle");
  }
  check("drew plenty of table questions", table > 200, true);
  check("answer is NOT always at index 0", (positions[0] ?? 0) < table, true);
  check("it lands in every slot", Object.keys(positions).sort(), ["0", "1", "2", "3"]);
  // 4 options, so ~25% each; anything above 40% means it is not really random
  const share = (positions[0] ?? 0) / table;
  check("index 0 share looks uniform (<40%)", share < 0.4, true);
  console.log(`       index-0 share ${(share * 100).toFixed(1)}% across ${table} draws`);
}

console.log("\n── the shared pool is never mutated by a draw ──");
{
  const pool = makePool({ en: 200 });
  const before = pool.byId.get("en-0").options.join(",");
  const state = { language: "en", deck: { fresh: [], used: [] } };
  for (let i = 0; i < 400; i++) drawQuestion(state, 2, pool);
  check("cached row untouched", pool.byId.get("en-0").options.join(","), before);
  check("cached answer still first in the CACHE", pool.byId.get("en-0").options[0], "a");
}

console.log("\n── withShuffledOptions keeps the answer valid ──");
{
  const q = { id: "x", options: ["a", "b", "c", "d"], answer: "a", difficulty: 1 };
  let moved = 0;
  for (let i = 0; i < 200; i++) {
    const out = withShuffledOptions(q);
    check_silent(out.options.includes(out.answer), "answer survives");
    check_silent(out.options.length === 4, "option count preserved");
    if (out.options.indexOf(out.answer) !== 0) moved++;
  }
  check("answer moves off index 0 most of the time", moved > 100, true);
  check("original object not mutated", q.options.join(","), "a,b,c,d");
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) {
  console.log(`FAILED: ${failures.length} of ${pass + failures.length}`);
  process.exit(1);
}
console.log(`PASSED: ${pass}/${pass} assertions`);
