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
import { MATH_QUESTION_CHANCE, QUESTIONS_TABLE } from "./config.mjs";

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
  };
}

// cached at module scope: a warm container scans the table once, not per turn
let questionPool = null;
async function loadQuestionPool() {
  if (questionPool) return questionPool;
  const res = await ddb.send(new ScanCommand({ TableName: QUESTIONS_TABLE }));
  const list = (res.Items ?? [])
    .map((item, i) => normalizeQuestion(item, `db-${i}`))
    .filter(Boolean);
  questionPool = { byId: new Map(list.map((q) => [q.id, q])), ids: list.map((q) => q.id) };
  return questionPool;
}

/**
 * Draw for the requested tier. The deck persists as id lists on the state so a
 * match does not repeat a question until the pool is exhausted; the drawn
 * question itself is copied into `turn` so nothing has to be re-resolved.
 */
function drawQuestion(state, difficulty, pool) {
  if (Math.random() < MATH_QUESTION_CHANCE) return generateMathQuestion(difficulty);
  if (!state.deck) state.deck = { fresh: [], used: [] };
  if (!state.deck.fresh.length) {
    state.deck.fresh = shuffle(state.deck.used);
    state.deck.used = [];
  }
  if (!state.deck.fresh.length) return generateMathQuestion(difficulty);

  const want = Math.min(3, Math.max(1, difficulty));
  const at = (d) => state.deck.fresh.findIndex((id) => pool.byId.get(id)?.difficulty === d);
  let idx = at(want);
  if (idx < 0) idx = at(want - 1);
  if (idx < 0) idx = 0;
  const [id] = state.deck.fresh.splice(idx, 1);
  state.deck.used.push(id);
  return pool.byId.get(id) ?? generateMathQuestion(difficulty);
}

export {
  drawQuestion,
  generateMathQuestion,
  loadQuestionPool,
  normalizeQuestion,
  randInt,
  shuffle,
};
