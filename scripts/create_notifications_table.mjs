/**
 * One-off: creates the Notifications table — the durable half of the bell.
 *
 *   node scripts/create_notifications_table.mjs    (safe to re-run)
 *
 * ── THE KEY ────────────────────────────────────────────────────────────────
 *   PK  username         everything ever sent to one person
 *   SK  notification_id  `<epoch ms>#<8 hex>`
 *
 * The same sort key ChatMessages uses, for the same three reasons: a Query on
 * username comes back already in time order, "since I last looked" is a
 * key-condition rather than a filter, and two events landing in the same
 * millisecond cannot overwrite each other — which a bare timestamp would allow
 * and which is exactly what "three friends invite you at once" looks like.
 *
 * ── TTL, UNLIKE CHAT ───────────────────────────────────────────────────────
 * ChatMessages deliberately has none, because the point there is to collect.
 * The point here is the opposite: a notification is worth reading for a while
 * and worthless afterwards. "X invited you to a room" three weeks later is
 * noise pointing at a lobby that stopped existing the same evening. 30 days,
 * stamped at write time.
 *
 * ── NO GSI ─────────────────────────────────────────────────────────────────
 * "My notifications, newest first" and "mark this one read" are the only two
 * access patterns, and the key serves both. An unread COUNT is derived by the
 * reader rather than indexed — the window is small enough that counting is
 * cheaper than maintaining a counter that can drift.
 */

import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION || "eu-west-3";
const TABLE = process.env.NOTIFICATIONS_TABLE || "Notifications";
const db = new DynamoDBClient({ region: REGION });

async function exists() {
  try {
    await db.send(new DescribeTableCommand({ TableName: TABLE }));
    return true;
  } catch (err) {
    if (err?.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

if (await exists()) {
  console.log(`  ${TABLE} already exists — nothing to do.`);
} else {
  await db.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "username", AttributeType: "S" },
        { AttributeName: "notification_id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "username", KeyType: "HASH" },
        { AttributeName: "notification_id", KeyType: "RANGE" },
      ],
    })
  );
  console.log(`  ${TABLE} creating…`);
  for (let i = 0; i < 30; i++) {
    const res = await db.send(new DescribeTableCommand({ TableName: TABLE }));
    if (res.Table.TableStatus === "ACTIVE") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`  ${TABLE} is ACTIVE.`);
}

try {
  await db.send(
    new UpdateTimeToLiveCommand({
      TableName: TABLE,
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    })
  );
  console.log("  TTL enabled on expiresAt.");
} catch (err) {
  if (err?.name === "ValidationException") console.log("  TTL already enabled.");
  else throw err;
}
