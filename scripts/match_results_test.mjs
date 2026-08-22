/**
 * ===========================================================================
 * match_results_test.mjs — what a finished match writes, offline
 * ===========================================================================
 *   node scripts/match_results_test.mjs
 *
 * Runs lambda-ws/lib/results.mjs against an in-memory DynamoDB stub. No AWS,
 * no credentials, no socket. The stub implements the exact GetItem /
 * conditional PutItem / ADD+SET UpdateItem semantics this module relies on,
 * so a change to how the writes are built fails here loudly instead of
 * passing vacuously.
 *
 * The module's real source is used, with two lines swapped: the DynamoDB
 * client and the broadcast function become globals the harness provides.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "lambda-ws", "lib", "results.mjs");

function buildTestableCopy() {
  let src = fs.readFileSync(SRC, "utf8");
  const dropAws = 'import { ddb } from "./aws.mjs";';
  const dropConn = 'import { broadcast } from "./connections.mjs";';
  if (!src.includes(dropAws) || !src.includes(dropConn)) {
    throw new Error("results.mjs imports changed — update buildTestableCopy()");
  }
  src = src.replace(dropAws, "const ddb = globalThis.__TEST_DDB__;");
  src = src.replace(dropConn, "const broadcast = globalThis.__TEST_BROADCAST__;");
  /*
   * Written BESIDE the original, not in a temp dir: results.mjs imports
   * "./config.mjs" and "./aws.mjs" relatively, so a copy anywhere else cannot
   * resolve them. Dot-prefixed and removed on exit.
   */
  const file = path.join(path.dirname(SRC), ".results.undertest.mjs");
  fs.writeFileSync(file, src);
  process.on("exit", () => fs.rmSync(file, { force: true }));
  return file;
}

// ── the stub ──────────────────────────────────────────────────────────────
const players = new Map();
const matches = new Map();
const sent = [];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class ConditionalCheckFailedException extends Error {
  constructor() {
    super("The conditional request failed");
    this.name = "ConditionalCheckFailedException";
  }
}

/** evaluates the two condition shapes this module emits */
function conditionHolds(item, input) {
  const expr = input.ConditionExpression;
  if (!expr) return true;
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};

  if (expr === "attribute_not_exists(match_id)") return item === undefined;

  // (attribute_not_exists(#cs) OR #cs = :prevCs) AND (attribute_not_exists(#ach) OR size(#ach) = :prevAchCount)
  const cs = names["#cs"], ach = names["#ach"];
  const streakOk = item?.[cs] === undefined || item[cs] === values[":prevCs"];
  const achOk =
    item?.[ach] === undefined || (item[ach] ?? []).length === values[":prevAchCount"];
  return streakOk && achOk;
}

function applyUpdate(item, input) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const expr = input.UpdateExpression;
  const setPart = expr.slice(expr.indexOf("SET ") + 4, expr.indexOf(" ADD "));
  const addPart = expr.slice(expr.indexOf(" ADD ") + 5);

  // split on commas that are NOT inside parentheses — `if_not_exists(#a, :b)`
  // contains one, and a naive split tears the clause in half
  const clauses = [];
  let depth = 0, buf = "";
  for (const ch of setPart) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { clauses.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) clauses.push(buf);

  for (const clause of clauses) {
    const [lhs, rhs] = clause.split(" = ");
    const attr = names[lhs.trim()];
    const r = rhs.trim();
    const ifNot = /^if_not_exists\((#\w+),\s*(:\w+)\)$/.exec(r);
    if (ifNot) {
      if (item[names[ifNot[1]]] === undefined) item[names[ifNot[1]]] = clone(values[ifNot[2]]);
    } else {
      item[attr] = clone(values[r]);
    }
  }
  for (const pair of addPart.split(/,\s*/)) {
    const [nameRef, valRef] = pair.trim().split(/\s+/);
    const attr = names[nameRef];
    item[attr] = (item[attr] ?? 0) + values[valRef];
  }
  return item;
}

globalThis.__TEST_DDB__ = {
  async send(cmd) {
    const kind = cmd.constructor.name;
    const input = cmd.input;
    if (kind === "GetCommand") {
      const table = input.TableName === "Matches" ? matches : players;
      return { Item: clone(table.get(input.Key.username ?? input.Key.match_id)) };
    }
    if (kind === "PutCommand") {
      const key = input.Item.match_id ?? input.Item.username;
      const table = input.TableName === "Matches" ? matches : players;
      if (!conditionHolds(table.get(key), input)) throw new ConditionalCheckFailedException();
      table.set(key, clone(input.Item));
      return {};
    }
    if (kind === "UpdateCommand") {
      const key = input.Key.username;
      const existing = players.get(key);
      if (!conditionHolds(existing, input)) throw new ConditionalCheckFailedException();
      players.set(key, applyUpdate(existing ? clone(existing) : { username: key }, input));
      return {};
    }
    throw new Error("unexpected command " + kind);
  },
};
globalThis.__TEST_BROADCAST__ = async (_event, lobbyId, msg) => {
  sent.push({ lobbyId, msg });
};

const results = await import(buildTestableCopy());

// ── assertions ────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}

function makeState({ matchId = "m1", winner = "ana", stats = {} } = {}) {
  const names = ["ana", "bob", "cy"];
  return {
    matchId, lobbyId: "lob1", roomName: "Soba 1", code: 4242,
    startedAt: Date.now() - 300000, round: 7, winner,
    players: names.map((u) => ({
      username: u, displayName: u.toUpperCase(), avatar: null, isSpectator: false,
      stats: { correct: 3, wrong: stats[u]?.wrong ?? 1, betsWon: stats[u]?.betsWon ?? 0,
               maxBetWin: stats[u]?.maxBetWin ?? 0, roundsPlayed: 5 },
    })),
    standings: [
      { username: "ana", displayName: "ANA", money: 900, alive: true },
      { username: "bob", displayName: "BOB", money: 300, alive: false },
      { username: "cy", displayName: "CY", money: 0, alive: false },
    ],
  };
}
const reset = () => { players.clear(); matches.clear(); sent.length = 0; };

console.log("\n── the archive row ──");
{
  reset();
  const m = results.buildMatchRecord(makeState());
  check("match_id", m.match_id, "m1");
  check("placement is standings order", m.standings.map((s) => s.placement), [1, 2, 3]);
  check("winner", m.winner, "ana");
  check("winnerName uses displayName", m.winnerName, "ANA");
  check("margin = 1st - 2nd", m.margin, 600);
  check("participants", m.participants, ["ana", "bob", "cy"]);
  check("rounds carried", m.rounds, 7);
}

console.log("\n── persist: archive + per-player window ──");
{
  reset();
  await results.persistMatchResults({}, makeState());
  check("one archive row written", matches.size, 1);
  check("all three players updated", players.size, 3);

  const ana = players.get("ana");
  check("winner wins +1", ana.wins, 1);
  check("gamesPlayed +1", ana.gamesPlayed, 1);
  check("winner points = 25", ana.points, 25);
  check("winner coins = 25 + 100", ana.coins, 125);
  check("winner streak = 1", ana.currentStreak, 1);
  check("bestStreak tracks it", ana.bestStreak, 1);
  check("history has this match", ana.matchHistory.map((h) => h.matchId), ["m1"]);
  check("history says won", ana.matchHistory[0].won, true);
  check("history placement", ana.matchHistory[0].placement, 1);
  check("credits seeded for a fresh record", ana.credits, 5);

  const bob = players.get("bob");
  check("loser wins stays 0", bob.wins, 0);
  check("loser still played a game", bob.gamesPlayed, 1);
  check("loser points 0", bob.points, 0);
  check("loser coins = 25", bob.coins, 25);
  check("loser streak 0", bob.currentStreak, 0);
  check("loser history says lost", bob.matchHistory[0].won, false);
}

console.log("\n── exactly-once: a second call pays nothing more ──");
{
  const anaBefore = clone(players.get("ana"));
  await results.persistMatchResults({}, makeState());
  await results.persistMatchResults({}, makeState());
  check("still one archive row", matches.size, 1);
  check("wins unchanged", players.get("ana").wins, anaBefore.wins);
  check("coins unchanged", players.get("ana").coins, anaBefore.coins);
  check("history not duplicated", players.get("ana").matchHistory.length, 1);
}

console.log("\n── achievements unlock and are announced ──");
{
  reset();
  await results.persistMatchResults({}, makeState());
  const unlockMsgs = sent.filter((s) => s.msg.type === "achievements_unlocked");
  check("an unlock was broadcast", unlockMsgs.length > 0, true);
  const anaUnlock = unlockMsgs.find((m) => m.msg.username === "ana");
  check("winner got first_win", anaUnlock.msg.achievements.map((a) => a.id).includes("first_win"), true);
  check("recorded on the player", players.get("ana").achievements.includes("first_win"), true);
  check("chat line accompanies it", sent.some((s) => s.msg.type === "chat_message" && /🏅/.test(s.msg.text)), true);
  check("loser unlocked nothing", unlockMsgs.some((m) => m.msg.username === "bob"), false);
}

console.log("\n── flawless_win needs a clean sheet ──");
{
  reset();
  await results.persistMatchResults({}, makeState({ matchId: "m2", stats: { ana: { wrong: 0 } } }));
  check("flawless unlocked", players.get("ana").achievements.includes("flawless_win"), true);
  reset();
  await results.persistMatchResults({}, makeState({ matchId: "m3", stats: { ana: { wrong: 2 } } }));
  check("not unlocked with a wrong answer", players.get("ana").achievements.includes("flawless_win"), false);
}

console.log("\n── streak accumulates across matches, and points scale with it ──");
{
  reset();
  for (let i = 1; i <= 3; i++) {
    await results.persistMatchResults({}, makeState({ matchId: `s${i}` }));
  }
  const ana = players.get("ana");
  check("streak = 3", ana.currentStreak, 3);
  // 25 + (25+5) + (25+10)
  check("points = 25 + 30 + 35", ana.points, 90);
  check("three matches in history", ana.matchHistory.length, 3);
  check("newest first", ana.matchHistory[0].matchId, "s3");
}

console.log("\n── a loss resets the streak but keeps bestStreak ──");
{
  await results.persistMatchResults({}, makeState({ matchId: "s4", winner: "bob" }));
  const ana = players.get("ana");
  check("streak reset", ana.currentStreak, 0);
  check("bestStreak remembered", ana.bestStreak, 3);
  check("bob now has a win", players.get("bob").wins, 1);
}

console.log("\n── the history window is CAPPED (the 400KB guard) ──");
{
  reset();
  for (let i = 1; i <= 30; i++) {
    await results.persistMatchResults({}, makeState({ matchId: `cap${i}` }));
  }
  const ana = players.get("ana");
  check("capped at 20", ana.matchHistory.length, 20);
  check("kept the newest", ana.matchHistory[0].matchId, "cap30");
  check("dropped the oldest", ana.matchHistory.some((h) => h.matchId === "cap1"), false);
  check("but all 30 are in the archive", matches.size, 30);
  check("gamesPlayed counted all 30", ana.gamesPlayed, 30);
}

console.log("\n── spectators are not paid and not archived ──");
{
  reset();
  const s = makeState({ matchId: "spec1" });
  s.players.push({ username: "watcher", displayName: "WATCHER", isSpectator: true, stats: {} });
  await results.persistMatchResults({}, s);
  check("watcher got no record", players.has("watcher"), false);
  check("archive lists three", matches.get("spec1").participants.length, 3);
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`FAILED: ${failures.length} of ${pass + failures.length}`); process.exit(1); }
console.log(`PASSED: ${pass}/${pass} assertions`);
