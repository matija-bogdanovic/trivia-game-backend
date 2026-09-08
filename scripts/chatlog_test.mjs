/**
 * ===========================================================================
 * chatlog_test.mjs — what a chat line writes, offline
 * ===========================================================================
 *   node scripts/chatlog_test.mjs
 *
 * Runs lambda-ws/lib/chatlog.mjs against an in-memory stub. No AWS, no
 * credentials. The real source is used with one line swapped: the DynamoDB
 * client becomes a global the harness provides.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_MAX_LENGTH } from "../lambda-ws/lib/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "lambda-ws", "lib", "chatlog.mjs");

function buildTestableCopy() {
  let src = fs.readFileSync(SRC, "utf8");
  const drop = 'import { ddb } from "./aws.mjs";';
  if (!src.includes(drop)) throw new Error("chatlog.mjs imports changed");
  src = src.replace(drop, "const ddb = globalThis.__TEST_DDB__;");
  // beside the original so its relative config import still resolves
  const file = path.join(path.dirname(SRC), ".chatlog.undertest.mjs");
  fs.writeFileSync(file, src);
  process.on("exit", () => fs.rmSync(file, { force: true }));
  return file;
}

const written = [];
const queries = [];
let failNext = false;
globalThis.__TEST_DDB__ = {
  async send(cmd) {
    if (failNext) {
      failNext = false;
      const e = new Error("boom");
      e.name = "ProvisionedThroughputExceededException";
      throw e;
    }
    written.push(JSON.parse(JSON.stringify(cmd.input)));
    return {};
  },
};

const { recordChatMessage, messageId, loadChatHistory } = await import(buildTestableCopy());

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`); }
}
const last = () => written[written.length - 1];
const reset = () => { written.length = 0; };

console.log("\n── message_id sorts by time and survives a collision ──");
{
  const a = messageId(1000), b = messageId(2000);
  check("earlier sorts first", a < b, true);
  const same = new Set(Array.from({ length: 500 }, () => messageId(1700000000000)));
  check("500 ids in the same millisecond are all distinct", same.size, 500);
  check("the timestamp is the sortable prefix", messageId(1700000000000).split("#")[0], "1700000000000");
}

console.log("\n── a player message ──");
{
  reset();
  const ok = await recordChatMessage({
    lobbyId: "lob1", username: "ana", displayName: "ANA",
    text: "zdravo", at: 1700000000000, kind: "player",
  });
  check("written", ok, true);
  check("table", last().TableName, "ChatMessages");
  check("partition is the lobby", last().Item.lobbyId, "lob1");
  check("author kept", last().Item.username, "ana");
  check("display name kept", last().Item.displayName, "ANA");
  check("text kept", last().Item.text, "zdravo");
  check("kind", last().Item.kind, "player");
  check("timestamp kept as a number", last().Item.at, 1700000000000);
  check("no reason on a player line", "reason" in last().Item, false);
  check("no TTL attribute — this is a collection", "expiresAt" in last().Item, false);
}

console.log("\n── a system message ──");
{
  reset();
  await recordChatMessage({ lobbyId: "lob1", text: "ANA joined the room", kind: "system", reason: "joined" });
  check("kind", last().Item.kind, "system");
  check("reason kept", last().Item.reason, "joined");
  check("no author — the room has no username", "username" in last().Item, false);
  check("and no displayName", "displayName" in last().Item, false);
}

console.log("\n── refusals and limits ──");
{
  reset();
  check("no lobbyId -> not written", await recordChatMessage({ text: "x" }), false);
  check("empty text -> not written", await recordChatMessage({ lobbyId: "l", text: "" }), false);
  check("nothing hit the table", written.length, 0);

  const long = "x".repeat(CHAT_MAX_LENGTH + 500);
  await recordChatMessage({ lobbyId: "lob1", text: long, username: "ana" });
  check("text truncated to CHAT_MAX_LENGTH", last().Item.text.length, CHAT_MAX_LENGTH);
}

console.log("\n── a failed write never throws at the caller ──");
{
  reset();
  failNext = true;
  let threw = false;
  let result;
  try { result = await recordChatMessage({ lobbyId: "lob1", text: "hi", username: "ana" }); }
  catch { threw = true; }
  check("did not throw", threw, false);
  check("reported the failure", result, false);
}

console.log("\n── two messages in the same millisecond both survive ──");
{
  reset();
  await recordChatMessage({ lobbyId: "lob1", text: "a", username: "ana", at: 1700000000001 });
  await recordChatMessage({ lobbyId: "lob1", text: "b", username: "bob", at: 1700000000001 });
  check("two rows written", written.length, 2);
  check("distinct sort keys", written[0].Item.message_id !== written[1].Item.message_id, true);
  check("same partition", written[0].Item.lobbyId, written[1].Item.lobbyId);
}

console.log("\n── reading the room back, oldest first ──");
{
  reset();
  /*
   * The stub answers a Query with newest-first rows, which is what
   * ScanIndexForward:false returns — the reader has to put them back in
   * reading order itself.
   */
  globalThis.__TEST_DDB__.send = async (cmd) => {
    if (cmd.constructor.name === "QueryCommand") {
      queries.push(cmd.input);
      return {
        Items: [
          { username: "cara", displayName: "CARA", text: "third", at: 3 },
          { username: "bob", displayName: "BOB", text: "second", at: 2 },
          { username: null, text: "ANA joined", at: 1, kind: "system" },
        ],
      };
    }
    written.push(JSON.parse(JSON.stringify(cmd.input)));
    return {};
  };

  const history = await loadChatHistory("lob1");
  check("newest-first rows come back oldest-first",
    history.map((m) => m.text), ["ANA joined", "second", "third"]);
  check("a system line keeps its kind", history[0].kind, "system");
  check("a player line has no kind", "kind" in history[1], false);
  check("queried the right room", queries[0].ExpressionAttributeValues[":l"], "lob1");
  check("asked newest-first", queries[0].ScanIndexForward, false);
  check("and capped", queries[0].Limit, 60);

  check("no lobbyId -> empty, no query", await loadChatHistory(""), []);
}

console.log("\n── a failed read never breaks the join ──");
{
  globalThis.__TEST_DDB__.send = async () => {
    const e = new Error("boom");
    e.name = "ProvisionedThroughputExceededException";
    throw e;
  };
  let threw = false;
  let out;
  try { out = await loadChatHistory("lob1"); } catch { threw = true; }
  check("did not throw", threw, false);
  check("answered with an empty conversation", out, []);
}

console.log(`\n${"=".repeat(60)}`);
if (failures.length) { console.log(`FAILED: ${failures.length} of ${pass + failures.length}`); process.exit(1); }
console.log(`PASSED: ${pass}/${pass} assertions`);
