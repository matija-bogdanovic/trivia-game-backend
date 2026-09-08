/**
 * create_push_table.mjs — the PushSubscriptions table
 *   node scripts/create_push_table.mjs
 *
 * One item per browser, not per person: a player may have a phone and a
 * laptop and both should buzz. So the key is the ENDPOINT — the push
 * service's own unique URL for that browser — and the username is an
 * attribute, read through a GSI when it is time to send.
 *
 * No TTL. A subscription is not a cache: it lives until the browser says it
 * is gone, and the browser says so by making the push service answer 404 or
 * 410, which sendPush reports as `dead` and the sender deletes on. Ageing them
 * out on a timer instead would silently stop notifying someone who had done
 * nothing wrong.
 */
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION || "eu-west-3" });
const TableName = "PushSubscriptions";

try {
  const existing = await ddb.send(new DescribeTableCommand({ TableName }));
  console.log(`${TableName} already exists (${existing.Table.TableStatus})`);
  process.exit(0);
} catch (err) {
  if (err.name !== "ResourceNotFoundException") throw err;
}

await ddb.send(new CreateTableCommand({
  TableName,
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    { AttributeName: "endpoint", AttributeType: "S" },
    { AttributeName: "username", AttributeType: "S" },
  ],
  KeySchema: [{ AttributeName: "endpoint", KeyType: "HASH" }],
  GlobalSecondaryIndexes: [{
    IndexName: "username-index",
    KeySchema: [{ AttributeName: "username", KeyType: "HASH" }],
    Projection: { ProjectionType: "ALL" },
  }],
}));
console.log(`created ${TableName} with username-index`);
