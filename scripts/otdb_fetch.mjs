/**
 * ===========================================================================
 * otdb_fetch.mjs — drain the Open Trivia DB English pool to a file
 * ===========================================================================
 *   node scripts/otdb_fetch.mjs [outfile]        default: /tmp/otdb_pool.json
 *
 * Fetch ONLY. It touches no AWS resource and deletes nothing — the download
 * is slow (rate limits, below) and the table must not be emptied until the
 * replacement is safely on disk. questions_rebuild.mjs does the writing.
 *
 * ── HOW THE WHOLE POOL IS DRAINED ──────────────────────────────────────────
 * A SESSION TOKEN is the mechanism. OpenTDB remembers every question already
 * handed to a token and never repeats one, and answers `response_code: 4`
 * ("token empty") once it has given out everything it has. So the pool is
 * exhausted by asking the same token for more until it says 4 — no category
 * walk, no page arithmetic, and no duplicates to filter.
 *
 * Asking WITHOUT a category filter is deliberate and is the reason this takes
 * ~80 requests rather than ~200: one un-filtered request returns 50 questions
 * from anywhere in the pool, where a category+difficulty walk pays the rate
 * limit again for every one of the 24 x 3 combinations, most of which hold
 * far fewer than 50.
 *
 * THE TAIL is the one wrinkle. When fewer than `amount` questions remain,
 * OpenTDB does not return a short page — it answers `response_code: 1` ("no
 * results"). So the amount is stepped down 50 → 20 → 10 → 5 → 1 on a code 1,
 * and only an exhausted token at amount=1 means genuinely empty. Without that
 * ladder the last few dozen questions are silently left behind.
 *
 * ── RATE LIMIT ─────────────────────────────────────────────────────────────
 * OpenTDB allows roughly one request per 5 seconds per IP and answers
 * `response_code: 5` when that is exceeded. Every call is spaced by
 * REQUEST_SPACING_MS and a code 5 backs off and retries rather than being
 * treated as the end of the pool — mistaking throttling for exhaustion is the
 * easiest way to quietly import half the questions.
 *
 * ── ENCODING ───────────────────────────────────────────────────────────────
 * `encode=url3986` rather than the default. The default returns HTML entities
 * (`&quot;`, `&#039;`, `&eacute;`) which need an entity decoder to be correct;
 * percent-encoding is unambiguous and decodeURIComponent is built in. A small
 * entity decoder still runs afterwards as a belt-and-braces, because a handful
 * of OpenTDB rows contain entities that were escaped into the source text
 * itself and survive any transport encoding.
 *
 * ── LICENCE ────────────────────────────────────────────────────────────────
 * OpenTDB content is CC BY-SA 4.0. Usable commercially, but attribution and
 * ShareAlike are conditions, not courtesies. See ATTRIBUTION in the output.
 * ===========================================================================
 */

import fs from "node:fs";

const OUT = process.argv[2] || "/tmp/otdb_pool.json";

const API = "https://opentdb.com/api.php";
const TOKEN_API = "https://opentdb.com/api_token.php";
const CATEGORY_API = "https://opentdb.com/api_category.php";

/** OpenTDB's documented ceiling for one request */
const MAX_AMOUNT = 50;
/** the step-down ladder that picks up the tail of the pool */
const AMOUNTS = [50, 20, 10, 5, 1];
/** ~1 request per 5s per IP; a little over, to stay clear of the edge */
const REQUEST_SPACING_MS = 5200;
/** how long to wait out a code 5 before trying again */
const THROTTLE_BACKOFF_MS = 10000;
/** give up after this many consecutive failures of any kind */
const MAX_CONSECUTIVE_FAILURES = 6;

const DIFFICULTY = { easy: 1, medium: 2, hard: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** the few entities that survive url3986 because they are in the source text */
const ENTITIES = {
  "&quot;": '"', "&#039;": "'", "&apos;": "'", "&amp;": "&",
  "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&eacute;": "é",
  "&Eacute;": "É", "&egrave;": "è", "&uuml;": "ü", "&ouml;": "ö",
  "&auml;": "ä", "&ntilde;": "ñ", "&ldquo;": "“", "&rdquo;": "”",
  "&lsquo;": "‘", "&rsquo;": "’", "&hellip;": "…", "&shy;": "",
};

function decode(raw) {
  if (typeof raw !== "string") return "";
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // a malformed percent sequence: keep the original rather than losing the row
  }
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (m) => {
    if (ENTITIES[m] !== undefined) return ENTITIES[m];
    const num = /^&#(\d+);$/.exec(m);
    return num ? String.fromCodePoint(Number(num[1])) : m;
  });
  return text.trim();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "ipakseokrece-import/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function newToken() {
  const d = await getJson(`${TOKEN_API}?command=request`);
  if (d.response_code !== 0 || !d.token) {
    throw new Error(`could not get a session token (code ${d.response_code})`);
  }
  return d.token;
}

/** what OpenTDB says it holds, so the import can be checked against it */
async function poolInventory() {
  const cats = await getJson(CATEGORY_API);
  return cats.trivia_categories ?? [];
}

function normalize(raw) {
  const question_text = decode(raw.question);
  const answer = decode(raw.correct_answer);
  const incorrect = (raw.incorrect_answers ?? []).map(decode).filter(Boolean);
  if (!question_text || !answer || incorrect.length < 1) return null;

  // the answer must be among the options — the game engine's normalizeQuestion
  // drops any row where it is not, so a row that would be dropped is not worth
  // importing in the first place
  const options = [answer, ...incorrect];
  const unique = [...new Set(options)];
  if (unique.length < 2) return null;

  return {
    question_text,
    answer,
    options: unique,
    difficulty: DIFFICULTY[String(raw.difficulty).toLowerCase()] ?? 1,
    category: decode(raw.category) || "General Knowledge",
    type: String(raw.type ?? "multiple"),
  };
}

/** dedup key: text only, since the same question appears with shuffled options */
const keyOf = (q) =>
  q.question_text.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

async function main() {
  console.log("Open Trivia DB — draining the English pool\n");

  const categories = await poolInventory();
  console.log(`OpenTDB advertises ${categories.length} categories`);

  let token = await newToken();
  console.log(`session token acquired\n`);

  const seen = new Map();
  let requests = 0;
  let amountIdx = 0;
  let consecutiveFailures = 0;
  let lastRequestAt = 0;

  while (amountIdx < AMOUNTS.length) {
    const amount = AMOUNTS[amountIdx];

    const since = Date.now() - lastRequestAt;
    if (since < REQUEST_SPACING_MS) await sleep(REQUEST_SPACING_MS - since);
    lastRequestAt = Date.now();

    let data;
    try {
      data = await getJson(
        `${API}?amount=${amount}&token=${token}&encode=url3986`
      );
      requests++;
    } catch (err) {
      consecutiveFailures++;
      console.log(`  request failed (${err.message}) — retry ${consecutiveFailures}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      await sleep(THROTTLE_BACKOFF_MS);
      continue;
    }

    const code = Number(data.response_code);

    if (code === 0) {
      consecutiveFailures = 0;
      let added = 0;
      for (const raw of data.results ?? []) {
        const q = normalize(raw);
        if (!q) continue;
        const k = keyOf(q);
        if (!k || seen.has(k)) continue;
        seen.set(k, q);
        added++;
      }
      console.log(
        `  [${requests}] amount=${amount} -> +${added} new (total ${seen.size})`
      );
      continue;
    }

    if (code === 5) {
      // throttled, NOT exhausted — the difference matters, see the header
      consecutiveFailures++;
      console.log(`  [${requests}] rate limited, backing off ${THROTTLE_BACKOFF_MS}ms`);
      await sleep(THROTTLE_BACKOFF_MS);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      continue;
    }

    if (code === 1 || code === 4) {
      // 1 = fewer than `amount` left, 4 = this token has seen everything.
      // Either way the next smaller amount is what finds the remainder.
      consecutiveFailures = 0;
      amountIdx++;
      if (amountIdx < AMOUNTS.length) {
        console.log(
          `  [${requests}] code ${code} at amount=${amount} — stepping down to ${AMOUNTS[amountIdx]}`
        );
      } else {
        console.log(`  [${requests}] code ${code} at amount=1 — pool exhausted`);
      }
      continue;
    }

    if (code === 3) {
      // the token expired (OpenTDB drops them after 6h of inactivity)
      console.log(`  [${requests}] token expired — requesting a new one`);
      token = await newToken();
      continue;
    }

    console.log(`  [${requests}] unexpected response_code ${code}, stopping`);
    break;
  }

  const questions = [...seen.values()];
  const byDifficulty = {};
  const byCategory = {};
  for (const q of questions) {
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] ?? 0) + 1;
    byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
  }

  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        ATTRIBUTION:
          "Questions sourced from the Open Trivia Database (https://opentdb.com), " +
          "licensed CC BY-SA 4.0. Attribution and ShareAlike are licence conditions.",
        fetchedAt: new Date().toISOString(),
        requests,
        count: questions.length,
        byDifficulty,
        byCategory,
        advertisedCategories: categories.length,
        questions,
      },
      null,
      2
    )
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`fetched ${questions.length} unique questions in ${requests} requests`);
  console.log(`difficulty 1/2/3: ${byDifficulty[1] ?? 0}/${byDifficulty[2] ?? 0}/${byDifficulty[3] ?? 0}`);
  console.log(`categories: ${Object.keys(byCategory).length}`);
  console.log(`written to ${OUT}`);
}

main().catch((err) => {
  console.error("FETCH FAILED:", err);
  process.exit(1);
});
