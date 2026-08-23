/**
 * ===========================================================================
 * invite_test.mjs — every refusal invite_friend can make, offline
 * ===========================================================================
 *   node scripts/invite_test.mjs
 *
 * Runs lambda-ws/lib/handlers/invite.mjs against in-memory stubs. No AWS, no
 * credentials. The real source is used with two lines swapped: the DynamoDB
 * client and postTo become globals the harness provides.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "lambda-ws", "lib", "handlers", "invite.mjs");

function buildTestableCopy() {
  let src = fs.readFileSync(SRC, "utf8");
  const swaps = [
    ['import { ddb } from "../aws.mjs";', "const ddb = globalThis.__DDB__;"],
    [
      'import { postTo, ttlFromNow } from "../connections.mjs";',
      "const postTo = (...a) => globalThis.__POST__(...a);\nconst ttlFromNow = () => 1;",
    ],
    [
      'import { resolveLobby } from "../lobbies.mjs";',
      "const resolveLobby = (id) => globalThis.__LOBBY__(id);",
    ],
    [
      'import { identityFromToken } from "../auth.mjs";',
      "const identityFromToken = (t) => globalThis.__IDENT__(t);",
    ],
    [
      'import { CONNECTIONS_TABLE, PLAYERS_TABLE } from "../config.mjs";',
      'const CONNECTIONS_TABLE = "Connections";\nconst PLAYERS_TABLE = "Players";',
    ],
  ];
  for (const [from, to] of swaps) {
    if (!src.includes(from)) throw new Error(`invite.mjs imports changed: ${from}`);
    src = src.replace(from, to);
  }
  const file = path.join(path.dirname(SRC), ".invite.undertest.mjs");
  fs.writeFileSync(file, src);
  process.on("exit", () => fs.rmSync(file, { force: true }));
  return file;
}

// ── the world ──────────────────────────────────────────────────────────────
let sent = [];
let players = {};
let connections = [];
let lobby = null;

globalThis.__POST__ = async (_event, connectionId, message) => {
  sent.push({ connectionId, message });
};
globalThis.__LOBBY__ = async () => lobby;
globalThis.__IDENT__ = async (token) =>
  token === "good" ? { username: "ana" } : null;
globalThis.__DDB__ = {
  async send(cmd) {
    const name = cmd.constructor.name;
    if (name === "GetCommand") {
      return { Item: players[cmd.input.Key.username] ?? null };
    }
    if (name === "ScanCommand") {
      const want = cmd.input.ExpressionAttributeValues[":u"];
      return { Items: connections.filter((c) => c.username === want) };
    }
    if (name === "UpdateCommand") {
      updates.push(cmd.input);
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  },
};
let updates = [];

const { onHello, onInviteFriend } = await import(buildTestableCopy());

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}
const reset = () => { sent = []; updates = []; };
const lastToSender = () => sent.filter((s) => s.connectionId === "c-ana").pop()?.message;

const ANA_IN_ROOM = { username: "ana", lobbyId: "lob1", displayName: "ANA" };

console.log("\n── hello ──");
{
  reset();
  await onHello({}, "c-ana", { token: "bad" });
  check("a bad token is denied", sent.pop().message.type, "hello_denied");
  check("and writes nothing", updates.length, 0);

  reset();
  await onHello({}, "c-ana", { token: "good" });
  check("a good token is accepted", sent.pop().message.type, "hello_ok");
  check("writes the username", updates[0].ExpressionAttributeValues[":u"], "ana");
  check("and NO lobbyId — that is what makes it 'online'",
    Object.keys(updates[0].ExpressionAttributeValues).includes(":l"), false);
}

console.log("\n── invite: the refusals ──");
{
  reset();
  await onInviteFriend({}, "c-ana", { username: "ana" }, { target: "bob" });
  check("sender not in a room", lastToSender().reason, "not-in-room");

  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "" });
  check("no target named", lastToSender().reason, "no-target");

  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "ana" });
  check("cannot invite yourself", lastToSender().reason, "self");

  players = { ana: { username: "ana", friends: ["cara"] } };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("not a friend", lastToSender().reason, "not-friend");

  players = { ana: { username: "ana", friends: ["bob"] } };
  lobby = null;
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("room vanished", lastToSender().reason, "room-gone");

  lobby = { code: 4242, roomName: "ARENA", players: [{ username: "bob" }] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("already at this table", lastToSender().reason, "already-here");

  lobby = { code: 4242, roomName: "ARENA", players: [{ username: "ana" }] };
  connections = [];
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("offline — nothing pushed", lastToSender().reason, "offline");
  check("and nothing was stored", updates.length, 0);
}

console.log("\n── invite: the happy path ──");
{
  lobby = { code: 4242, roomName: "ARENA", isPrivate: true, players: [{ username: "ana" }] };
  connections = [
    { connectionId: "c-bob-1", username: "bob" },
    { connectionId: "c-bob-2", username: "bob" },
    { connectionId: "c-zoe", username: "zoe" },
  ];
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });

  const invites = sent.filter((s) => s.message.type === "room_invite");
  check("every one of bob's sockets got it", invites.length, 2);
  check("and nobody else's did",
    invites.every((i) => i.connectionId.startsWith("c-bob")), true);
  const inv = invites[0].message;
  check("carries the lobby to navigate to", inv.lobbyId, "lob1");
  check("carries the room name", inv.roomName, "ARENA");
  check("carries the code", inv.code, 4242);
  check("says who is asking", inv.from, "ana");
  check("with their display name", inv.fromName, "ANA");
  check("marks a private room as private", inv.isPrivate, true);
  check("NEVER carries the password", "password" in inv, false);
  check("the sender is told it went", lastToSender().type, "invite_sent");
  check("and to how many sockets", lastToSender().sockets, 2);
}

console.log("\n── the lobby's player list may hold bare strings ──");
{
  lobby = { code: 1, roomName: "R", players: ["bob"] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("string entries are read too", lastToSender().reason, "already-here");
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`FAILED: ${failures.length} of ${pass + failures.length}`); process.exit(1); }
console.log(`PASSED: ${pass}/${pass} assertions`);
