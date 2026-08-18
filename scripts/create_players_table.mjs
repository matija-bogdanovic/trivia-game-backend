// One-off: creates the Players table (PK: username) — the full player record:
// money, stats, lobby credits, shop coins, owned avatars, friends, achievements.
// Safe to re-run — skips if the table exists. (Was 'Wallets' until the table was
// renamed; DynamoDB cannot rename, so that was a create-copy-cutover-delete.)
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import 'dotenv/config';

// must match the region hardcoded in src/server/middleware/database_conn —
// the .env AWS_REGION says us-east-1 but the app actually uses eu-west-3
const client = new DynamoDBClient({ region: 'eu-west-3' });

try {
  await client.send(new DescribeTableCommand({ TableName: 'Players' }));
  console.log('Players table already exists — nothing to do.');
} catch (err) {
  if (err.name !== 'ResourceNotFoundException') throw err;
  await client.send(
    new CreateTableCommand({
      TableName: 'Players',
      AttributeDefinitions: [{ AttributeName: 'username', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'username', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log('Players table created (on-demand billing).');
}
