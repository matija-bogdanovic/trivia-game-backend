/**
 * The succession logic exists twice — once in lambda-ws/lib/succession.mjs and
 * once copied into lambda/leaveRoom.mjs, because the two functions deploy as
 * separate zips with no shared package.
 *
 * A copy that drifts is worse than no copy: the two leave paths would disagree
 * about whether a room still exists. This compares them by BEHAVIOUR over a
 * spread of rosters, not by text, so reformatting is allowed and a changed
 * decision is not.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ws from "../lambda-ws/lib/succession.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "..", "lambda", "leaveRoom.mjs"), "utf8");
const start = src.indexOf("function heirOf");
const end = src.indexOf("// ─── handler ─");
if (start < 0 || end < 0) {
  console.log("  FAILED: could not find the copy inside leaveRoom.mjs");
  process.exit(1);
}
const copyFile = path.join(HERE, ".succession.copy.mjs");
fs.writeFileSync(copyFile, src.slice(start, end) + "\nexport { heirOf, rosterAfterLeaving };");
process.on("exit", () => fs.rmSync(copyFile, { force: true }));
const rest = await import(copyFile);

const seat = (player, role, joinedAt) => ({
  id: player, player, role, points: 500,
  ...(joinedAt === null ? {} : { joinedAt }),
});

const CASES = [
  [[seat("ana", "Admin", 1), seat("bob", "Member", 2), seat("cara", "Member", 3)], "ana"],
  [[seat("ana", "Admin", 1), seat("cara", "Member", 3), seat("bob", "Member", 2)], "ana"],
  [[seat("ana", "Admin", 1)], "ana"],
  [[], "ana"],
  [[seat("ana", "Admin", 1), seat("bob", "Member", 2)], "bob"],
  [[seat("ana", "Admin", null), seat("bob", "Member", null), seat("cara", "Member", null)], "ana"],
  [[seat("ana", "Admin", null), seat("cara", "Member", null), seat("bob", "Member", 9)], "ana"],
  [[seat("ana", "Admin", 1), seat("bob", "Admin", 2), seat("cara", "Member", 3)], "ana"],
  [[seat("ana", "Admin", 1), seat("bob", "Member", 2)], "zoe"],
];

let pass = 0;
const failures = [];
CASES.forEach(([roster, leaving], i) => {
  const a = JSON.stringify(ws.rosterAfterLeaving(roster, leaving));
  const b = JSON.stringify(rest.rosterAfterLeaving(roster, leaving));
  const ha = JSON.stringify(ws.heirOf(roster, leaving));
  const hb = JSON.stringify(rest.heirOf(roster, leaving));
  if (a === b && ha === hb) { pass++; console.log(`  ok   case ${i + 1}: identical`); }
  else {
    failures.push(i + 1);
    console.log(`  FAIL case ${i + 1}\n       ws:   ${a}\n       rest: ${b}`);
  }
});

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`DRIFTED on cases ${failures.join(", ")}`); process.exit(1); }
console.log(`PASSED: the two copies agree on all ${pass} rosters`);
