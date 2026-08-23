/**
 * ===========================================================================
 * lobby_presence_test.mjs — does a joiner survive an index that has not caught up?
 * ===========================================================================
 *   node scripts/lobby_presence_test.mjs
 *
 * The bug this pins down: connectionsInLobby reads the lobby-index GSI, which
 * is eventually consistent, and `join` queries it microseconds after writing
 * the row. The stub below models exactly that — the index returns everything
 * EXCEPT the connection that just joined — and asserts that the joiner is
 * still described as present and still receives the state.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "lambda-ws", "lib", "presence.mjs");

function buildTestableCopy() {
  let src = fs.readFileSync(SRC, "utf8");
  const swaps = [
    ['import { postTo, broadcast, connectionsInLobby } from "./connections.mjs";',
     "const postTo = (...a) => globalThis.__POST__(...a);\n" +
     "const broadcast = (...a) => globalThis.__BCAST__(...a);\n" +
     "const connectionsInLobby = (...a) => globalThis.__INDEX__(...a);"],
    ['import { resolveLobby } from "./lobbies.mjs";',
     "const resolveLobby = (id) => globalThis.__LOBBY__(id);"],
    ['import { readGameState } from "./state.mjs";',
     "const readGameState = () => globalThis.__STATE__();"],
  ];
  for (const [from, to] of swaps) {
    if (!src.includes(from)) throw new Error(`presence.mjs imports changed: ${from}`);
    src = src.replace(from, to);
  }
  const file = path.join(path.dirname(SRC), ".presence.undertest.mjs");
  fs.writeFileSync(file, src);
  process.on("exit", () => fs.rmSync(file, { force: true }));
  return file;
}

/* the lobby has two seats; only the FIRST is visible in the index */
const HOST = { connectionId: "c-host", username: "ana", displayName: "ANA", joinedAt: 1, lobbyId: "lob1" };
const JOINER = { connectionId: "c-bob", username: "bob", displayName: "BOB", joinedAt: 2, lobbyId: "lob1" };

let indexLagging = true;
globalThis.__INDEX__ = async () => (indexLagging ? [HOST] : [HOST, JOINER]);
globalThis.__LOBBY__ = async () => ({
  roomName: "ARENA", code: 42, maxPlayers: 6, startingMoney: 500,
  players: [
    { player: "ana", role: "Admin", points: 500 },
    { player: "bob", role: "Member", points: 500 },
  ],
});
globalThis.__STATE__ = async () => null;

let posted = [];
let broadcasts = [];
globalThis.__POST__ = async (_e, connectionId, message) => posted.push({ connectionId, message });
globalThis.__BCAST__ = async (_e, lobbyId, message, except = null) =>
  broadcasts.push({ lobbyId, message, except });

const { broadcastLobbyState, lobbyStateMessage } = await import(buildTestableCopy());

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}
const reset = () => { posted = []; broadcasts = []; };
const seat = (msg, who) => msg.players.find((p) => p.username === who);

console.log("\n── the bug: index lagging, joiner NOT handed in ──");
{
  indexLagging = true;
  const msg = await lobbyStateMessage(await globalThis.__LOBBY__(), "lob1");
  check("the joiner's seat exists (it is on the roster)", !!seat(msg, "bob"), true);
  check("but reads as DISCONNECTED — this is the bug", seat(msg, "bob").connected, false);
}

console.log("\n── the fix: the same lag, joiner handed in ──");
{
  indexLagging = true;
  const msg = await lobbyStateMessage(await globalThis.__LOBBY__(), "lob1", JOINER);
  check("the joiner reads as connected", seat(msg, "bob").connected, true);
  check("with their display name", seat(msg, "bob").displayName, "BOB");
  check("and the host is untouched", seat(msg, "ana").connected, true);
  check("the host is still the host", seat(msg, "ana").isHost, true);
}

console.log("\n── delivery: the joiner is told, exactly once ──");
{
  reset();
  indexLagging = true;
  await broadcastLobbyState({}, "lob1", JOINER);
  check("the joiner got a direct copy", posted.map((p) => p.connectionId), ["c-bob"]);
  check("it is the lobby state", posted[0].message.type, "lobby_state");
  check("the room was broadcast to", broadcasts.length, 1);
  check("skipping the joiner, so nobody gets it twice", broadcasts[0].except, "c-bob");
  check("and that broadcast also shows them connected",
    seat(broadcasts[0].message, "bob").connected, true);
}

console.log("\n── no regression once the index catches up ──");
{
  reset();
  indexLagging = false;
  await broadcastLobbyState({}, "lob1", JOINER);
  const msg = broadcasts[0].message;
  check("both seats connected", [seat(msg,"ana").connected, seat(msg,"bob").connected], [true, true]);
  check("the joiner is not duplicated", msg.players.filter((p) => p.username === "bob").length, 1);
}

console.log("\n── a plain rebuild (leave, kick) still works with no row ──");
{
  reset();
  indexLagging = false;
  await broadcastLobbyState({}, "lob1");
  check("nothing is posted directly", posted.length, 0);
  check("one broadcast, to everyone", [broadcasts.length, broadcasts[0].except], [1, null]);
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`FAILED: ${failures.length} of ${pass + failures.length}`); process.exit(1); }
console.log(`PASSED: ${pass}/${pass} assertions`);
