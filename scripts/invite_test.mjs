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
      'import { isHostOf, resolveLobby, seatName } from "../lobbies.mjs";',
      "const resolveLobby = (id) => globalThis.__LOBBY__(id);\n" +
        // the real ones — they are pure, so there is nothing to fake and
        // faking them would stop this file testing the thing it names
        'const seatName = (s) => (typeof s === "string" ? s : ' +
        "(s?.player ?? s?.username ?? s?.id) == null ? null : " +
        "String(s?.player ?? s?.username ?? s?.id));\n" +
        "const isHostOf = (l, u) => { if (!u || !Array.isArray(l?.players)) return false; " +
        'const h = l.players.find((p) => p?.role === "Admin"); ' +
        "return Boolean(h && seatName(h) === String(u)); };",
    ],
    [
      'import { notify } from "../notify.mjs";',
      "const notify = (...a) => globalThis.__NOTIFY__(...a);",
    ],
    [
      'import { identityFromToken } from "../auth.mjs";',
      "const identityFromToken = (t) => globalThis.__IDENT__(t);",
    ],
    [
      'import { CONNECTIONS_TABLE, PLAYERS_TABLE, capacityOf } from "../config.mjs";',
      'const CONNECTIONS_TABLE = "Connections";\nconst PLAYERS_TABLE = "Players";\n' +
        "const capacityOf = (l) => Number(l?.maxPlayers ?? 6);",
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
/*
 * notify() is the real module in production; here it is a spy, because what
 * this file is testing is that invite_friend CALLS it with the right thing —
 * notify's own write-then-push is covered by its own behaviour, not by an
 * invite test pretending to be a database.
 */
let notified = [];
let notifyFails = false;
globalThis.__NOTIFY__ = async (_event, payload) => {
  if (notifyFails) return null;
  notified.push(payload);
  return { id: "1#abcd", at: 1700000000000, ...payload };
};
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
const reset = () => { sent = []; updates = []; notified = []; notifyFails = false; };
const lastToSender = () => sent.filter((s) => s.connectionId === "c-ana").pop()?.message;

const ANA_IN_ROOM = { username: "ana", lobbyId: "lob1", displayName: "ANA" };

/*
 * A seat in the shape createRoom and joinRoom write: `player` holds the name
 * and there is no `username` key. The old fixtures invented one, which is
 * precisely why invite.mjs's already-here guard could read p?.username and
 * still pass its tests while never firing in production.
 */
const seat = (name, role = "Member") => ({
  id: name,
  player: name,
  role,
  points: 500,
  joinedAt: 1,
});

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

  players = { ana: { username: "ana", friends: ["bob"] } };
  lobby = null;
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("room vanished", lastToSender().reason, "room-gone");

  /*
   * A NON-HOST naming someone who is not a friend. Ana sits as a Member, so
   * the friend list is the only thing that could let her through.
   */
  players = { ana: { username: "ana", friends: ["cara"] }, bob: { username: "bob" } };
  lobby = { code: 4242, roomName: "ARENA", players: [seat("dana", "Admin"), seat("ana")] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("a member cannot name a non-friend", lastToSender().reason, "not-friend");

  players = { ana: { username: "ana", friends: ["bob"] } };
  lobby = { code: 4242, roomName: "ARENA", players: [seat("bob", "Admin")] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("already at this table", lastToSender().reason, "already-here");

  lobby = { code: 4242, roomName: "ARENA", players: [seat("ana", "Admin")] };
  connections = [];
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("offline is NOT a refusal any more", lastToSender().type, "invite_sent");
  check("the notification was still written", notified.length, 1);
  check("and the sender is told it was not live", lastToSender().live, false);
  check("no banner went anywhere",
    sent.filter((x) => x.message.type === "room_invite").length, 0);

  reset();
  notifyFails = true;
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("a failed durable write IS a refusal", lastToSender().reason, "generic");
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

  check("the notification is written once", notified.length, 1);
  check("addressed to the target", notified[0].username, "bob");
  check("with the kind the client switches on", notified[0].kind, "room_invite");
  check("no display sentence is stored", "text" in notified[0].data, false);

  const invites = sent.filter((s) => s.message.type === "room_invite");
  check("every one of bob's sockets got the live banner", invites.length, 2);
  check("and nobody else's did",
    invites.every((i) => i.connectionId.startsWith("c-bob")), true);
  const inv = invites[0].message;
  check("the banner and the row carry the same data",
    JSON.stringify(notified[0].data.lobbyId), JSON.stringify(inv.lobbyId));
  check("carries the lobby to navigate to", inv.lobbyId, "lob1");
  check("carries the room name", inv.roomName, "ARENA");
  check("carries the code", inv.code, 4242);
  check("says who is asking", inv.from, "ana");
  check("with their display name", inv.fromName, "ANA");
  check("marks a private room as private", inv.isPrivate, true);
  check("NEVER carries the password", "password" in inv, false);
  check("the sender is told it went", lastToSender().type, "invite_sent");
  check("and that it landed live", lastToSender().live, true);
}

console.log("\n── a full room refuses the invite ──");
{
  // six seats taken, none of them the target
  lobby = {
    code: 1, roomName: "R", maxPlayers: 6,
    players: ["p1","p2","p3","p4","p5","p6"].map((u) => ({ username: u })),
  };
  connections = [{ connectionId: "c-bob-1", username: "bob" }];
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("refused as full", lastToSender().reason, "room-full");
  check("and nothing was written", notified.length, 0);

  // the same room with a seat free
  lobby.players = lobby.players.slice(0, 5);
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("one seat free is enough", lastToSender().type, "invite_sent");

  // a room built for four is full at four, not at six
  lobby = {
    code: 1, roomName: "R", maxPlayers: 4,
    players: ["p1","p2","p3","p4"].map((u) => ({ username: u })),
  };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("capacity is the ROOM's, not a constant", lastToSender().reason, "room-full");
}

console.log("\n── the lobby's player list may hold bare strings ──");
{
  lobby = { code: 1, roomName: "R", players: ["bob"] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "bob" });
  check("string entries are read too", lastToSender().reason, "already-here");
}

console.log("\n── the host may name anyone by username ──");
{
  /*
   * Option A: the username IS the identifier. There is no #1234 to type
   * beside it, because usernames are already unique — so "add a player" is a
   * single field, and these are the answers it can come back with.
   */
  const ANA_HOSTS = { code: 7, roomName: "R", maxPlayers: 6, players: [seat("ana", "Admin")] };

  players = { ana: { username: "ana", friends: [] }, zoran: { username: "zoran" } };
  lobby = ANA_HOSTS;
  connections = [];
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "zoran" });
  check("the host reaches a stranger", lastToSender().type, "invite_sent");
  check("and the invite was written", notified.length, 1);
  check("addressed to them", notified[0].username, "zoran");

  // the name was simply typed wrong — a thing a friend list can never do
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "zorna" });
  check("a name nobody holds", lastToSender().reason, "no-such-player");
  check("and nothing was written", notified.length, 0);

  // the host is not exempt from the other rules
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "ana" });
  check("the host still cannot invite themselves", lastToSender().reason, "self");

  lobby = { ...ANA_HOSTS, players: [seat("ana", "Admin"), seat("zoran")] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "zoran" });
  check("nor someone already seated", lastToSender().reason, "already-here");
  check("which is the guard that never fired before, on a REAL seat shape",
    notified.length, 0);

  lobby = {
    ...ANA_HOSTS, maxPlayers: 2,
    players: [seat("ana", "Admin"), seat("pera")],
  };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "zoran" });
  check("nor into a full room", lastToSender().reason, "room-full");

  // and a friend still needs no host badge
  players = { ana: { username: "ana", friends: ["zoran"] }, zoran: { username: "zoran" } };
  lobby = { code: 7, roomName: "R", maxPlayers: 6, players: [seat("dana", "Admin"), seat("ana")] };
  reset();
  await onInviteFriend({}, "c-ana", ANA_IN_ROOM, { target: "zoran" });
  check("a member may still invite a friend", lastToSender().type, "invite_sent");
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`FAILED: ${failures.length} of ${pass + failures.length}`); process.exit(1); }
console.log(`PASSED: ${pass}/${pass} assertions`);
