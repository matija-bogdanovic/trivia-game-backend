/**
 * ===========================================================================
 * lib/questions.mjs — the question pool, the deck, and generated arithmetic
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import {
  DECK_SLICE_SIZE,
  DECK_USED_LIMIT,
  DEFAULT_LANGUAGE,
  MATH_QUESTION_CHANCE,
  MIN_LANGUAGE_POOL,
  QUESTIONS_TABLE,
} from "./config.mjs";

// ═══════════════════════════════════════════════════════════════════════════
// QUESTIONS — ported from src/server/game/questions.ts
// ═══════════════════════════════════════════════════════════════════════════

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let mathCounter = 0;
/** generated arithmetic, harder tiers get harder forms (questions.ts) */
function generateMathQuestion(difficulty) {
  let text, answer;
  if (difficulty <= 1) {
    const a = randInt(3, 60), b = randInt(2, 40);
    if (Math.random() < 0.5) { text = `${a} + ${b} = ?`; answer = a + b; }
    else { const [hi, lo] = a >= b ? [a, b] : [b, a]; text = `${hi} - ${lo} = ?`; answer = hi - lo; }
  } else if (difficulty === 2) {
    if (Math.random() < 0.5) {
      const a = randInt(3, 12), b = randInt(3, 12);
      text = `${a} × ${b} = ?`; answer = a * b;
    } else {
      const b = randInt(2, 12), q = randInt(2, 12);
      text = `${b * q} ÷ ${b} = ?`; answer = q;
    }
  } else {
    const form = randInt(0, 2), a = randInt(2, 9), b = randInt(2, 9), c = randInt(2, 9);
    if (form === 0) { text = `${a} + ${b} × ${c} = ?`; answer = a + b * c; }
    else if (form === 1) { text = `(${a} + ${b}) × ${c} = ?`; answer = (a + b) * c; }
    else { const x = randInt(2, 12); text = `${a}x + ${b} = ${a * x + b}, x = ?`; answer = x; }
  }
  const options = new Set([answer]);
  while (options.size < 4) {
    const spread = Math.max(2, Math.round(Math.abs(answer) / 5));
    const candidate = answer + (Math.random() < 0.5 ? -1 : 1) * randInt(1, spread + 2);
    if (candidate !== answer && candidate >= 0) options.add(candidate);
  }
  return {
    id: `math-${++mathCounter}`,
    text,
    options: shuffle([...options].map(String)),
    answer: String(answer),
    difficulty: Math.min(3, Math.max(1, difficulty)),
  };
}

/** the same tolerant normaliser questions.ts uses */
function normalizeQuestion(raw, fallbackId) {
  if (!raw || typeof raw.question_text !== "string") return null;
  const rawOptions = Array.isArray(raw.question_options) ? raw.question_options : [];
  const options = rawOptions
    .map((o) => (typeof o === "string" ? o : o?.question_option_text ?? null))
    .filter((o) => typeof o === "string" && o.length > 0);
  const answer = typeof raw.answer === "string" ? raw.answer : null;
  if (options.length < 2 || !answer || !options.includes(answer)) return null;
  const difficulty = Number(raw.difficulty);
  return {
    id: String(raw.question_id ?? fallbackId),
    text: raw.question_text,
    options,
    answer,
    difficulty: difficulty >= 1 && difficulty <= 3 ? Math.round(difficulty) : 1,
    // rows written before the multilingual import have no language; they are
    // all English, so that is what an absent field means
    language: typeof raw.language === "string" && raw.language
      ? raw.language
      : DEFAULT_LANGUAGE,
  };
}

// cached at module scope: a warm container scans the table once, not per turn
let questionPool = null;
async function loadQuestionPool() {
  if (questionPool) return questionPool;
  // the table outgrew a single Scan page with the OpenTDB import — without the
  // pagination below the pool silently became "whatever fit in the first 1MB"
  const list = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: QUESTIONS_TABLE, ExclusiveStartKey })
    );
    for (const [i, item] of (res.Items ?? []).entries()) {
      const q = normalizeQuestion(item, `db-${list.length + i}`);
      if (q) list.push(q);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const idsByLang = new Map();
  for (const q of list) {
    if (!idsByLang.has(q.language)) idsByLang.set(q.language, []);
    idsByLang.get(q.language).push(q.id);
  }

  questionPool = {
    byId: new Map(list.map((q) => [q.id, q])),
    ids: list.map((q) => q.id),
    idsByLang,
  };
  return questionPool;
}

/**
 * The ids a match in `language` may draw from, and the fallback rule.
 *
 * THE RULE, in order:
 *   1. that language, if it holds at least MIN_LANGUAGE_POOL questions
 *   2. otherwise DEFAULT_LANGUAGE ("en"), on the same test
 *   3. otherwise everything there is
 *
 * Falling back rather than serving a thin pool is deliberate. A language with
 * a dozen questions does not produce a short match, it produces a repetitive
 * one — the deck reshuffles as soon as it empties, so the same twelve come
 * round again inside a single game. English at full size is a better game
 * than Serbian at a tenth of it, and step 3 exists only so a misconfigured
 * table still deals cards instead of dropping to pure arithmetic.
 */
function idsForLanguage(pool, language) {
  const wanted = pool.idsByLang?.get(language) ?? [];
  if (wanted.length >= MIN_LANGUAGE_POOL) return wanted;
  const fallback = pool.idsByLang?.get(DEFAULT_LANGUAGE) ?? [];
  if (fallback.length >= MIN_LANGUAGE_POOL) return fallback;
  return pool.ids ?? [];
}

/**
 * A fresh handful of question ids for the deck, avoiding what this match has
 * already asked.
 *
 * The shuffle happens over the WHOLE language pool but only DECK_SLICE_SIZE
 * ids survive into the returned array — the expensive part is in memory, on a
 * warm container, and only the cheap part is written to the record.
 *
 * Returns [] when every question in the language has been asked, which is the
 * caller's signal to start the pool over.
 */
function sliceForDeck(pool, language, used) {
  const spent = new Set(used ?? []);
  const available = idsForLanguage(pool, language).filter((id) => !spent.has(id));
  if (!available.length) return [];
  return shuffle(available).slice(0, DECK_SLICE_SIZE);
}

/**
 * A copy of a pooled question with its options in a fresh random order.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS HERE AND NOT IN normalizeQuestion ───────
 * Every row in the table stores its options as [answer, ...wrong] — the
 * import built them that way and never shuffled — so the correct answer was
 * the FIRST option in 100% of rows, and the engine passes options through in
 * order. Every table question showed its answer as the first button. A player
 * who noticed would win by always tapping option one.
 *
 * The shuffle belongs at DRAW time, not at load. normalizeQuestion runs once
 * per warm container, so shuffling there would fix the index-0 tell but freeze
 * one order per question for the life of that container — the same question
 * would come back in the same arrangement to everyone it was served to, and a
 * reload mid-question would rebuild the same board. Shuffling per draw makes
 * the order fresh for every serve.
 *
 * A COPY, never in place: `pool.byId` is the module-scope cache shared by every
 * match on the container, and shuffling the cached object would be a data race
 * between concurrent matches — and would slowly scramble the pool for
 * everybody.
 *
 * The answer is carried by VALUE, not by index, so a reorder cannot break the
 * mapping — `options.includes(answer)` holds whatever the order.
 */
function withShuffledOptions(question) {
  return { ...question, options: shuffle(question.options) };
}

/**
 * Draw for the requested tier. The deck persists as id lists on the state so a
 * match does not repeat a question until the pool is exhausted; the drawn
 * question itself is copied into `turn` so nothing has to be re-resolved.
 */
function drawQuestion(state, difficulty, pool) {
  if (Math.random() < MATH_QUESTION_CHANCE) return generateMathQuestion(difficulty);
  if (!state.deck) state.deck = { fresh: [], used: [] };

  /*
   * SEED THE DECK — a SLICE of it, never the whole pool.
   *
   * It starts { fresh: [], used: [] } and nothing used to fill it, so every
   * draw fell through to generateMathQuestion() and the table was unreachable
   * entirely. Seeding fixed that; seeding it with all ~5,300 ids replaced one
   * bug with a quieter one, because this record is PUT in full on every phase
   * transition and that deck is ~160KB of it. So the deck carries
   * DECK_SLICE_SIZE ids and is refilled when it runs dry — same behaviour, a
   * fortieth of the bytes.
   *
   * The slice is language-scoped, which is what makes a match monolingual:
   * the deck is the only source of table questions, so filtering it filters
   * everything. `deckLanguage` is stamped alongside for diagnosis.
   */
  const language = state.language || DEFAULT_LANGUAGE;
  if (!state.deck.fresh.length) {
    let slice = sliceForDeck(pool, language, state.deck.used);
    if (!slice.length) {
      // every question in this language has been asked — start the pool over
      // rather than dropping the rest of the match to arithmetic
      state.deck.used = [];
      slice = sliceForDeck(pool, language, []);
    }
    state.deck.fresh = slice;
    state.deck.deckLanguage = language;
  }
  if (!state.deck.fresh.length) return generateMathQuestion(difficulty);

  const want = Math.min(3, Math.max(1, difficulty));
  const at = (d) => state.deck.fresh.findIndex((id) => pool.byId.get(id)?.difficulty === d);
  let idx = at(want);
  if (idx < 0) idx = at(want - 1);
  if (idx < 0) idx = 0;
  const [id] = state.deck.fresh.splice(idx, 1);
  state.deck.used.push(id);
  // `used` grows one id per question asked, so a normal match never reaches
  // the cap — it is here so no match can grow this record without a bound
  if (state.deck.used.length > DECK_USED_LIMIT) {
    state.deck.used = state.deck.used.slice(-DECK_USED_LIMIT);
  }
  /*
   * Generated arithmetic is deliberately NOT sent through
   * withShuffledOptions: generateMathQuestion already shuffles its own
   * options when it builds them, and re-shuffling is work for no change.
   */
  const drawn = pool.byId.get(id);
  return drawn ? withShuffledOptions(drawn) : generateMathQuestion(difficulty);
}

export {
  drawQuestion,
  generateMathQuestion,
  idsForLanguage,
  sliceForDeck,
  withShuffledOptions,
  loadQuestionPool,
  normalizeQuestion,
  randInt,
  shuffle,
};
