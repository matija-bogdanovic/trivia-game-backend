/**
 * ===========================================================================
 * friends_state_test.mjs — the friendship state machine, offline
 * ===========================================================================
 * Exercises lambda/friendsAction.mjs against an in-memory DynamoDB stub: no
 * AWS account, no credentials, no network. Run it after touching the friend
 * transitions.
 *
 *   node scripts/friends_state_test.mjs
 *
 * HOW IT GETS AT THE CODE: the transitions are module-private and the document
 * client is built at module scope, so the file is read, two lines are changed
 * (the client becomes the stub, and the transitions are exported) and the
 * result is imported from a temp file. Everything else is the deployed source
 * byte for byte — this is not a reimplementation.
 *
 * WHAT THE STUB MODELS: GetCommand, and TransactWriteItems with real
 * ConditionExpression evaluation and all-or-nothing application, which is what
 * makes the lost-race test meaningful. It understands only the two expression
 * shapes this handler emits and throws on anything else, so a change in how
 * the writes are built fails loudly here rather than passing vacuously.
 * ===========================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "..", "lambda", "friendsAction.mjs");

function buildTestableCopy() {
  let src = fs.readFileSync(SOURCE, "utf8");
  const clientLine =
    "const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));";
  if (!src.includes(clientLine)) {
    throw new Error(
      "friendsAction.mjs no longer builds its client the expected way — " +
        "update buildTestableCopy() in this script."
    );
  }
  src = src.replace(clientLine, "const ddb = globalThis.__TEST_DDB__;");
  src += `

export {
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend,
};
`;
  /*
   * Inside the repo, not os.tmpdir(): the copy imports @aws-sdk/lib-dynamodb,
   * and Node resolves that by walking up from the file's own directory. A copy
   * in /tmp has no node_modules above it and fails to load.
   */
  const dir = fs.mkdtempSync(path.join(HERE, "..", ".friends-test-"));
  const file = path.join(dir, "engine.mjs");
  fs.writeFileSync(file, src);
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}



const table = new Map();
const clone = (v) => JSON.parse(JSON.stringify(v));

let getCount = 0;
/** fires after the Nth GetCommand, so the mutation lands after BOTH reads */
let raceHook = null;
let raceAfterGets = 0;

class TransactionCanceledException extends Error {
  constructor(reasons) {
    super('Transaction cancelled');
    this.name = 'TransactionCanceledException';
    this.CancellationReasons = reasons;
  }
}

/** evaluates `(attribute_not_exists(#kN) OR #kN = :oldN) AND ...` */
function conditionHolds(item, input) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  for (const clause of input.ConditionExpression.split(' AND ')) {
    const m = clause.match(/attribute_not_exists\((#k\d+)\) OR (#k\d+) = (:old\d+)/);
    if (!m) throw new Error('harness cannot parse condition: ' + clause);
    const attr = names[m[1]];
    const expected = values[m[3]];
    const actual = item?.[attr];
    if (actual === undefined) continue; // attribute_not_exists branch
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function applyUpdate(item, input) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  for (const pair of input.UpdateExpression.replace(/^SET /, '').split(', ')) {
    const [lhs, rhs] = pair.split(' = ');
    item[names[lhs.trim()]] = clone(values[rhs.trim()]);
  }
}

globalThis.__TEST_DDB__ = {
  async send(cmd) {
    const kind = cmd.constructor.name;
    const input = cmd.input;

    if (kind === 'GetCommand') {
      getCount++;
      const item = table.get(input.Key.username);
      // read the row first, THEN let the interloper write: this reproduces a
      // commit that was decided on a snapshot which is stale by write time
      const snapshot = item ? clone(item) : undefined;
      if (raceHook && getCount >= raceAfterGets) {
        const hook = raceHook;
        raceHook = null;
        hook();
      }
      return { Item: snapshot };
    }

    if (kind === 'TransactWriteCommand') {
      const targets = input.TransactItems.map((t) => {
        const key = t.Update.Key.username;
        return { key, item: table.get(key), input: t.Update };
      });
      const reasons = targets.map((t) =>
        conditionHolds(t.item, t.input)
          ? { Code: 'None' }
          : { Code: 'ConditionalCheckFailed' }
      );
      if (reasons.some((r) => r.Code === 'ConditionalCheckFailed')) {
        throw new TransactionCanceledException(reasons);
      }
      // all-or-nothing, so mutate only after every condition passed
      for (const t of targets) {
        const next = t.item ? clone(t.item) : { username: t.key };
        applyUpdate(next, t.input);
        table.set(t.key, next);
      }
      return {};
    }

    throw new Error('harness got an unexpected command: ' + kind);
  },
};


const engine = await import(buildTestableCopy());


// ── assertions ────────────────────────────────────────────────────────────
let pass = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}\n       expected ${e}\n       actual   ${a}`);
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}

function seed(...names) {
  table.clear();
  for (const n of names) {
    table.set(n, {
      username: n,
      coins: 500,
      credits: 5,
      lastRefillAt: Date.now(),
      friends: [],
      friendRequests: [],
      outgoingRequests: [],
      deniedRequests: [],
    });
  }
}
const get = (n) => table.get(n);
const deniedNames = (n) => (get(n).deniedRequests ?? []).map((d) => d.username);

console.log('\n── send: pending is written to BOTH sides ──');
seed('ana', 'bob');
check('status', await engine.sendFriendRequest('ana', 'bob'), 'pending');
check('sender outgoing', get('ana').outgoingRequests, ['bob']);
check('recipient incoming', get('bob').friendRequests, ['ana']);
check('nobody is a friend yet', get('ana').friends, []);

console.log('\n── duplicates are refused ──');
check('second send', await engine.sendFriendRequest('ana', 'bob'), 'Request already sent');
check('outgoing not duplicated', get('ana').outgoingRequests, ['bob']);
check('self', await engine.sendFriendRequest('ana', 'ana'), "That's you");
check('unknown target', await engine.sendFriendRequest('ana', 'ghost'), 'User not found');

console.log('\n── accept: both sides become friends, pending clears ──');
check('status', await engine.acceptFriendRequest('bob', 'ana'), 'accepted');
check('recipient friends', get('bob').friends, ['ana']);
check('sender friends', get('ana').friends, ['bob']);
check('incoming cleared', get('bob').friendRequests, []);
check('outgoing cleared', get('ana').outgoingRequests, []);
check('already friends', await engine.sendFriendRequest('ana', 'bob'), 'Already friends');

console.log('\n── deny: recorded on the sender, not deleted ──');
seed('ana', 'bob');
await engine.sendFriendRequest('ana', 'bob');
check('status', await engine.declineFriendRequest('bob', 'ana'), 'denied');
check('incoming cleared', get('bob').friendRequests, []);
check('outgoing cleared', get('ana').outgoingRequests, []);
check('denial kept on sender', deniedNames('ana'), ['bob']);
check('denial is stamped', typeof get('ana').deniedRequests[0].at, 'number');
check('not friends', get('ana').friends, []);

console.log('\n── re-request after a denial clears it ──');
check('status', await engine.sendFriendRequest('ana', 'bob'), 'pending');
check('denial cleared', deniedNames('ana'), []);
check('pending again', get('bob').friendRequests, ['ana']);

console.log('\n── cancel: sender withdraws ──');
check('status', await engine.cancelFriendRequest('ana', 'bob'), 'cancelled');
check('outgoing cleared', get('ana').outgoingRequests, []);
check('incoming cleared', get('bob').friendRequests, []);
check('cancel with nothing pending', await engine.cancelFriendRequest('ana', 'bob'), 'No such request');
check('no denial invented', deniedNames('ana'), []);

console.log('\n── reverse case: both sent, second becomes an accept ──');
seed('ana', 'bob');
await engine.sendFriendRequest('ana', 'bob');
check('bob asks back', await engine.sendFriendRequest('bob', 'ana'), 'accepted');
check('ana friends', get('ana').friends, ['bob']);
check('bob friends', get('bob').friends, ['ana']);
check('ana outgoing cleared', get('ana').outgoingRequests, []);
check('bob incoming cleared', get('bob').friendRequests, []);
check('ana incoming cleared', get('ana').friendRequests, []);

console.log('\n── accept without a request ──');
seed('ana', 'bob');
check('refused', await engine.acceptFriendRequest('bob', 'ana'), 'No such request');

console.log('\n── remove: unfriends both sides ──');
seed('ana', 'bob');
await engine.sendFriendRequest('ana', 'bob');
await engine.acceptFriendRequest('bob', 'ana');
check('status', await engine.removeFriend('ana', 'bob'), 'removed');
check('ana friends', get('ana').friends, []);
check('bob friends', get('bob').friends, []);

console.log('\n── conditional write: a lost race is retried, not clobbered ──');
seed('ana', 'bob', 'cy');
// between the read and the write of ana->bob, cy sends bob a request
raceAfterGets = getCount + 2; // after ana AND bob have both been read
raceHook = () => {
  const b = get('bob');
  b.friendRequests = [...b.friendRequests, 'cy'];
  table.set('bob', b);
};
const before = getCount;
check('status after retry', await engine.sendFriendRequest('ana', 'bob'), 'pending');
check('both requests survive', get('bob').friendRequests.sort(), ['ana', 'cy']);
check('it did re-read after the conflict', getCount >= before + 4, true);
check('the interloper was not clobbered', get('bob').friendRequests.includes('cy'), true);

console.log('\n── unrelated fields are never rewritten ──');
seed('ana', 'bob');
await engine.sendFriendRequest('ana', 'bob');
check('coins untouched', get('ana').coins, 500);
check('credits untouched', get('bob').credits, 5);

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`FAILED: ${failures.length} of ${pass + failures.length}`);
  process.exit(1);
}
console.log(`PASSED: ${pass}/${pass} assertions`);
