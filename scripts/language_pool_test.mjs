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

import { drawQuestion, idsForLanguage } from "../lambda-ws/lib/questions.mjs";
import { MIN_LANGUAGE_POOL } from "../lambda-ws/lib/config.mjs";

let pass = 0;
const failures = [];
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

console.log(`\n${"=".repeat(60)}`);
if (failures.length) {
  console.log(`FAILED: ${failures.length} of ${pass + failures.length}`);
  process.exit(1);
}
console.log(`PASSED: ${pass}/${pass} assertions`);
