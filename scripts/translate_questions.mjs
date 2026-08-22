/**
 * ===========================================================================
 * translate_questions.mjs — machine-translate the English pool into Serbian
 * ===========================================================================
 *   node scripts/translate_questions.mjs                  translate + checkpoint
 *   node scripts/translate_questions.mjs --write           also write to DynamoDB
 *   node scripts/translate_questions.mjs --limit 50        try a small slice first
 *
 * Amazon Translate, en -> sr. Resumable: every question is appended to a JSONL
 * checkpoint the moment it comes back, and a re-run skips what is already
 * there. A job this long should never have to start over.
 *
 * ── ONE CALL PER QUESTION, NOT ONE PER STRING ──────────────────────────────
 * The question and its options go up as a single newline-joined block and come
 * back the same way, which turns 24,869 calls into 5,289. Amazon Translate
 * preserves the line structure reliably — but "reliably" is not "always", so
 * every response is checked for the same line count and anything that does not
 * match falls back to translating that question's strings one at a time. The
 * batching is an optimisation; the fallback is what makes it safe.
 *
 * ── THE CORRECT ANSWER MUST SURVIVE ────────────────────────────────────────
 * This is the part that quietly breaks if done casually. The engine matches
 * the answer against the options by STRING EQUALITY, so translating the answer
 * separately from the options is a bug waiting to happen: "True" translated on
 * its own and "True" translated inside the option list can come back as
 * different words, and the question becomes unanswerable.
 *
 * So the answer is never translated as its own string. Its INDEX in the option
 * array is found first, the options are translated as a block, and the
 * translated answer is whatever landed at that index. Identity by position,
 * not by text.
 *
 * ── WHAT GETS DROPPED, AND WHY ─────────────────────────────────────────────
 * A translated question is rejected if two options collapse to the same
 * Serbian string. English distinguishes pairs that Serbian renders
 * identically, and a question offering the same answer twice is worse than one
 * that is missing. Rejections are counted and listed rather than silently
 * skipped.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * Billed per character submitted. The full pool is ~561k characters, about
 * $8.41 at $15/M, and inside the 2M/month free tier if the account still has
 * it. --limit exists so the shape can be checked before spending the rest.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT = path.join(HERE, "..", "questions-sr-translated.jsonl");

const TABLE = process.env.QUESTIONS_TABLE || "Questions";
const REGION = process.env.AWS_REGION || "eu-west-3";

const SOURCE_LANG = "en";
const TARGET_LANG = "sr";

/** requests per second; Amazon Translate's default TranslateText quota is 10 */
const RATE_PER_SEC = 8;
/** backoff on a ThrottlingException, doubled each consecutive time */
const THROTTLE_BASE_MS = 1000;
const MAX_RETRIES = 5;
const BATCH = 25;

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : Infinity;
})();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const translate = new TranslateClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function translateOne(text) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await translate.send(
        new TranslateTextCommand({
          Text: text,
          SourceLanguageCode: SOURCE_LANG,
          TargetLanguageCode: TARGET_LANG,
        })
      );
      return res.TranslatedText ?? "";
    } catch (err) {
      const name = err?.name ?? "";
      const retriable =
        name === "ThrottlingException" ||
        name === "TooManyRequestsException" ||
        name === "ServiceUnavailableException" ||
        name === "InternalServerException";
      if (!retriable || attempt === MAX_RETRIES) throw err;
      await sleep(THROTTLE_BASE_MS * 2 ** attempt);
    }
  }
  throw new Error("unreachable");
}

/**
 * Translate a question and its options together, falling back to one string at
 * a time when the block does not come back with the same number of lines.
 */
async function translateQuestion(q) {
  const strings = [q.question_text, ...q.question_options];
  const joined = strings.join("\n");
  const out = await translateOne(joined);
  let lines = out.split("\n").map((l) => l.trim());

  if (lines.length !== strings.length || lines.some((l) => !l)) {
    // the block came back reshaped — pay for the individual calls instead
    lines = [];
    for (const s of strings) lines.push((await translateOne(s)).trim());
    return { lines, batched: false };
  }
  return { lines, batched: true };
}

async function scanEnglish() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey })
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.filter((i) => i.language === "en");
}

function loadCheckpoint() {
  const done = new Map();
  if (!fs.existsSync(CHECKPOINT)) return done;
  for (const line of fs.readFileSync(CHECKPOINT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.base_id) done.set(row.base_id, row);
    } catch {
      // a half-written final line from an interrupted run; ignore it
    }
  }
  return done;
}

async function main() {
  console.log(`Amazon Translate ${SOURCE_LANG} -> ${TARGET_LANG}`);
  console.log(WRITE ? "MODE: translate + WRITE to DynamoDB\n" : "MODE: translate + checkpoint only\n");

  const english = await scanEnglish();
  console.log(`English rows in ${TABLE}: ${english.length}`);

  const done = loadCheckpoint();
  console.log(`already in checkpoint  : ${done.size}`);

  const todo = english.filter((q) => !done.has(q.question_id)).slice(0, LIMIT);
  console.log(`to translate this run  : ${todo.length}\n`);

  const out = fs.createWriteStream(CHECKPOINT, { flags: "a" });
  const spacing = 1000 / RATE_PER_SEC;
  let ok = 0, fellBack = 0, rejected = [];
  let last = 0;

  for (let i = 0; i < todo.length; i++) {
    const q = todo[i];
    const since = Date.now() - last;
    if (since < spacing) await sleep(spacing - since);
    last = Date.now();

    let result;
    try {
      result = await translateQuestion(q);
    } catch (err) {
      rejected.push({ id: q.question_id, why: `translate failed: ${err.name}` });
      continue;
    }
    if (!result.batched) fellBack++;

    const [text, ...options] = result.lines;

    // the answer is the option at the SAME INDEX it held in English — never a
    // separately translated string, see the header
    const answerIndex = q.question_options.findIndex((o) => o === q.answer);
    if (answerIndex < 0) {
      rejected.push({ id: q.question_id, why: "answer not among the English options" });
      continue;
    }
    const answer = options[answerIndex];

    if (new Set(options).size !== options.length) {
      rejected.push({ id: q.question_id, why: "options collapsed to duplicates" });
      continue;
    }
    if (!answer || !options.includes(answer)) {
      rejected.push({ id: q.question_id, why: "answer lost in translation" });
      continue;
    }

    const row = {
      question_id: `${q.question_id}-sr`,
      base_id: q.question_id,
      question_text: text,
      question_options: options,
      answer,
      difficulty: Number(q.difficulty) || 1,
      category: q.category,
      source: q.source ?? "opentdb",
      language: "sr",
      translated_by: "amazon-translate",
      translated_at: new Date().toISOString(),
    };
    out.write(JSON.stringify(row) + "\n");
    ok++;

    if ((i + 1) % 100 === 0 || i === todo.length - 1) {
      process.stdout.write(
        `\r  ${i + 1}/${todo.length} translated (ok ${ok}, rejected ${rejected.length}, per-string fallbacks ${fellBack})`
      );
    }
  }
  out.end();
  await new Promise((r) => out.on("close", r));
  console.log("\n");

  const all = loadCheckpoint();
  console.log(`checkpoint now holds: ${all.size} Serbian questions`);
  console.log(`rejected this run   : ${rejected.length}`);
  for (const r of rejected.slice(0, 10)) console.log(`   ${r.id}: ${r.why}`);

  if (!WRITE) {
    console.log(`\nNot written to ${TABLE}. Re-run with --write to insert.`);
    return;
  }

  const rows = [...all.values()];
  console.log(`\nwriting ${rows.length} Serbian rows to ${TABLE}...`);
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    let chunk = rows.slice(i, i + BATCH).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; attempt < 5 && chunk.length; attempt++) {
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [TABLE]: chunk } })
      );
      const left = res.UnprocessedItems?.[TABLE] ?? [];
      written += chunk.length - left.length;
      chunk = left;
      if (chunk.length) await sleep(250 * (attempt + 1));
    }
    if (chunk.length) throw new Error(`${chunk.length} rows would not write`);
    process.stdout.write(`\r  put ${written}/${rows.length}`);
  }
  console.log(`\n\nwrote ${written} Serbian rows`);
}

main().catch((err) => {
  console.error("\nTRANSLATE FAILED:", err);
  process.exit(1);
});
