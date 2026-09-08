/**
 * ===========================================================================
 * succession_test.mjs — who inherits the room
 * ===========================================================================
 *   node scripts/succession_test.mjs
 *
 * Pure logic, no AWS. Runs the real lib/succession.mjs.
 * ===========================================================================
 */
import { heirOf, rosterAfterLeaving } from "../lambda-ws/lib/succession.mjs";

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}
const seat = (player, role, joinedAt, points = 500) => ({
  id: player, player, role, points, ...(joinedAt === null ? {} : { joinedAt }),
});
const roles = (r) => r.map((s) => `${s.player}:${s.role}`);

console.log("\n── the second person in inherits ──");
{
  const roster = [seat("ana", "Admin", 1000), seat("bob", "Member", 2000), seat("cara", "Member", 3000)];
  check("heir is the earliest joiner left", heirOf(roster, "ana").player, "bob");
  const after = rosterAfterLeaving(roster, "ana");
  check("ana is gone", after.map((s) => s.player), ["bob", "cara"]);
  check("bob is Admin, cara untouched", roles(after), ["bob:Admin", "cara:Member"]);
  check("bob keeps his points", after[0].points, 500);
  check("and his joinedAt", after[0].joinedAt, 2000);
}

console.log("\n── join ORDER decides it, not roster position ──");
{
  // cara sits earlier in the array but joined later
  const roster = [seat("ana", "Admin", 1000), seat("cara", "Member", 3000), seat("bob", "Member", 2000)];
  check("bob inherits despite being last in the array", heirOf(roster, "ana").player, "bob");
}

console.log("\n── the last player out closes the room ──");
{
  check("one seat, they leave", rosterAfterLeaving([seat("ana", "Admin", 1)], "ana"), null);
  check("empty roster", rosterAfterLeaving([], "ana"), null);
  check("heirOf agrees", heirOf([seat("ana", "Admin", 1)], "ana"), null);
}

console.log("\n── a MEMBER leaving changes no host ──");
{
  const roster = [seat("ana", "Admin", 1000), seat("bob", "Member", 2000)];
  const after = rosterAfterLeaving(roster, "bob");
  check("ana is still Admin", roles(after), ["ana:Admin"]);
}

console.log("\n── rooms written before joinedAt existed ──");
{
  const roster = [seat("ana", "Admin", null), seat("bob", "Member", null), seat("cara", "Member", null)];
  check("falls back to roster position", heirOf(roster, "ana").player, "bob");

  const mixed = [seat("ana", "Admin", null), seat("cara", "Member", null), seat("bob", "Member", 5000)];
  check("a real timestamp outranks a missing one", heirOf(mixed, "ana").player, "bob");
}

console.log("\n── never two hosts ──");
{
  const broken = [seat("ana", "Admin", 1000), seat("bob", "Admin", 2000), seat("cara", "Member", 3000)];
  const after = rosterAfterLeaving(broken, "ana");
  check("bob inherits and stays the only Admin", roles(after), ["bob:Admin", "cara:Member"]);
  check("exactly one Admin", after.filter((s) => s.role === "Admin").length, 1);
}

console.log("\n── the leaver is not on the roster at all ──");
{
  const roster = [seat("ana", "Admin", 1000), seat("bob", "Member", 2000)];
  const after = rosterAfterLeaving(roster, "zoe");
  check("nothing is removed", after.map((s) => s.player), ["ana", "bob"]);
  check("and the host is unchanged", roles(after), ["ana:Admin", "bob:Member"]);
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`FAILED: ${failures.length} of ${pass + failures.length}`); process.exit(1); }
console.log(`PASSED: ${pass}/${pass} assertions`);
