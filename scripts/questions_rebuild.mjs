/**
 * ===========================================================================
 * questions_rebuild.mjs — replace the Questions table's contents
 * ===========================================================================
 *   node scripts/questions_rebuild.mjs --pool /tmp/otdb_pool.json [--apply]
 *
 * Without --apply it is a DRY RUN: it reads, normalises, dedups and prints
 * exactly what it would do, and writes nothing. Nothing about a data
 * operation on a live table should be discoverable only by doing it.
 *
 * ── WRITE FIRST, PRUNE AFTER — the table is never empty ────────────────────
 * The obvious shape is "delete everything, then insert". It is also the one
 * shape with a window where the live game scans an EMPTY table and every
 * match falls back to generated arithmetic. So the order is inverted:
 *
 *   1. write every new row      (the table now holds old ∪ new)
 *   2. delete the old rows that the new set does not contain
 *
 * At no instant is there less than a full pool of questions. The cost is a
 * brief period holding both, which on a 64-row table against a few thousand
 * new ones is nothing.
 *
 * Ids are deterministic — `otdb-<sha1(normalised text)>` — so a re-run
 * overwrites rather than duplicates, and the prune can tell "the same
 * question, re-imported" from "a row that is genuinely gone".
 *
 * ── THE SERBIAN 14 ─────────────────────────────────────────────────────────
 * Re-inserted verbatim from questions-serbian-preserved.json, keeping their
 * original numeric ids, tagged language "sr". They are the only questions
 * written for this game and the only non-English content; they are never
 * sourced from the pool file and never pruned.
 *
 * ── REFUSALS ───────────────────────────────────────────────────────────────
 * It stops rather than proceeding if the backup is missing, if the pool file
 * is absent or unreadable, or if the incoming set is smaller than MIN_IMPORT.
 * A truncated download that quietly replaced a working table with 30 rows is
 * the failure worth engineering against.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

const TABLE = process.env.QUESTIONS_TABLE || "Questions";
const REGION = process.env.AWS_REGION || "eu-west-3";

/** below this many incoming questions, assume the fetch broke and refuse */
const MIN_IMPORT = 200;
/** DynamoDB's hard limit for BatchWriteItem */
const BATCH = 25;
/** breathing room between batches; on-demand still throttles under a burst */
const BATCH_PAUSE_MS = 120;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const poolPath = (() => {
  const i = args.indexOf("--pool");
  return i >= 0 && args[i + 1] ? args[i + 1] : "/tmp/otdb_pool.json";
})();

const normText = (t) =>
  String(t).toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

const idFor = (text) =>
  "otdb-" + crypto.createHash("sha1").update(normText(text)).digest("hex").slice(0, 20);

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey })
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** BatchWrite with the UnprocessedItems retry the SDK does not do for you */
async function batchWrite(requests, label) {
  let done = 0;
  for (let i = 0; i < requests.length; i += BATCH) {
    let chunk = requests.slice(i, i + BATCH);
    for (let attempt = 0; attempt < 5 && chunk.length; attempt++) {
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [TABLE]: chunk } })
      );
      const left = res.UnprocessedItems?.[TABLE] ?? [];
      done += chunk.length - left.length;
      chunk = left;
      if (chunk.length) await sleep(250 * (attempt + 1));
    }
    if (chunk.length) {
      throw new Error(`${label}: ${chunk.length} items would not write after retries`);
    }
    process.stdout.write(`\r  ${label}: ${done}/${requests.length}`);
    await sleep(BATCH_PAUSE_MS);
  }
  process.stdout.write("\n");
  return done;
}

function loadJson(file, what) {
  if (!fs.existsSync(file)) throw new Error(`${what} not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  console.log(`Questions rebuild — table ${TABLE} (${REGION})`);
  console.log(APPLY ? "MODE: APPLY (writes)\n" : "MODE: DRY RUN (writes nothing)\n");

  // ── refusals, before anything is read into memory ────────────────────────
  const backups = fs
    .readdirSync(REPO)
    .filter((f) => /^questions-backup-.*\.json$/.test(f));
  if (!backups.length) {
    throw new Error(
      "no questions-backup-*.json in the repo root — take a backup before rebuilding"
    );
  }
  console.log(`backup present: ${backups.join(", ")}`);

  const pool = loadJson(poolPath, "pool file");
  const serbian = loadJson(
    path.join(REPO, "questions-serbian-preserved.json"),
    "preserved Serbian questions"
  );

  const incoming = pool.questions ?? [];
  if (incoming.length < MIN_IMPORT) {
    throw new Error(
      `pool holds only ${incoming.length} questions (< MIN_IMPORT ${MIN_IMPORT}) — ` +
        "refusing to rebuild from what looks like a truncated fetch"
    );
  }

  // ── build the new set ────────────────────────────────────────────────────
  const bySeen = new Map();
  for (const q of incoming) {
    const k = normText(q.question_text);
    if (!k || bySeen.has(k)) continue;
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length < 2 || !options.includes(q.answer)) continue;
    bySeen.set(k, {
      question_id: idFor(q.question_text),
      question_text: q.question_text,
      question_options: options,
      answer: q.answer,
      difficulty: Number(q.difficulty) || 1,
      category: q.category || "General Knowledge",
      source: "opentdb",
      language: "en",
    });
  }
  const english = [...bySeen.values()];

  const sr = (serbian.questions ?? []).map((q) => ({
    question_id: String(q.question_id),
    question_text: q.question_text,
    question_options: q.question_options,
    answer: q.answer,
    difficulty: Number(q.difficulty) || 1,
    ...(q.category ? { category: q.category } : {}),
    source: q.source || "handwritten",
    language: "sr",
  }));

  const finalItems = [...english, ...sr];
  const keepIds = new Set(finalItems.map((i) => i.question_id));

  // ── what is there now ────────────────────────────────────────────────────
  const existing = await scanAll();
  const stale = existing.filter((i) => !keepIds.has(String(i.question_id)));

  const byDiff = {}, byCat = {}, byLang = {};
  for (const q of finalItems) {
    byDiff[q.difficulty] = (byDiff[q.difficulty] ?? 0) + 1;
    if (q.category) byCat[q.category] = (byCat[q.category] ?? 0) + 1;
    byLang[q.language] = (byLang[q.language] ?? 0) + 1;
  }

  console.log(`\nincoming from pool : ${incoming.length}`);
  console.log(`after dedup/validate: ${english.length} English`);
  console.log(`Serbian preserved  : ${sr.length}`);
  console.log(`TOTAL to write     : ${finalItems.length}`);
  console.log(`currently in table : ${existing.length}`);
  console.log(`stale rows to prune: ${stale.length}`);
  console.log(`\nlanguage: ${JSON.stringify(byLang)}`);
  console.log(`difficulty 1/2/3: ${byDiff[1] ?? 0}/${byDiff[2] ?? 0}/${byDiff[3] ?? 0}`);
  console.log(`categories: ${Object.keys(byCat).length}`);

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
    return;
  }

  // ── 1. write (table now holds old ∪ new, never empty) ────────────────────
  console.log("\nwriting new rows...");
  const written = await batchWrite(
    finalItems.map((Item) => ({ PutRequest: { Item } })),
    "put"
  );

  // ── 2. prune what the new set replaced ───────────────────────────────────
  if (stale.length) {
    console.log("pruning replaced rows...");
    await batchWrite(
      stale.map((i) => ({ DeleteRequest: { Key: { question_id: i.question_id } } })),
      "delete"
    );
  }

  // ── 3. verify ────────────────────────────────────────────────────────────
  const after = await scanAll();
  const langs = {};
  for (const q of after) langs[q.language ?? "(none)"] = (langs[q.language ?? "(none)"] ?? 0) + 1;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`wrote ${written}, pruned ${stale.length}`);
  console.log(`FINAL COUNT IN TABLE: ${after.length}`);
  console.log(`by language: ${JSON.stringify(langs)}`);
  if (after.length === 0) throw new Error("table is EMPTY after rebuild — restore the backup");
  console.log("verified: table is not empty");
}

main().catch((err) => {
  console.error("\nREBUILD FAILED:", err.message);
  process.exit(1);
});
