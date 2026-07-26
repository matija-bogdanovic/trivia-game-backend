// One-off: creates the Wallets table (PK: username) used for lobby credits,
// shop coins, and owned avatars. Safe to re-run — skips if the table exists.
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
  await client.send(new DescribeTableCommand({ TableName: 'Wallets' }));
  console.log('Wallets table already exists — nothing to do.');
} catch (err) {
  if (err.name !== 'ResourceNotFoundException') throw err;
  await client.send(
    new CreateTableCommand({
      TableName: 'Wallets',
      AttributeDefinitions: [{ AttributeName: 'username', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'username', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log('Wallets table created (on-demand billing).');
}
