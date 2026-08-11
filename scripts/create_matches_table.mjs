// One-off: creates the Matches table (PK: match_id) holding one item per
// finished match — final standings, winner, margin, rounds. Players keep a
// trimmed copy of each match in their own Wallets record; this table is what
// a match-detail lookup reads. Safe to re-run — skips if the table exists.
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
  await client.send(new DescribeTableCommand({ TableName: 'Matches' }));
  console.log('Matches table already exists — nothing to do.');
} catch (err) {
  if (err.name !== 'ResourceNotFoundException') throw err;
  await client.send(
    new CreateTableCommand({
      TableName: 'Matches',
      AttributeDefinitions: [{ AttributeName: 'match_id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'match_id', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log('Matches table created (on-demand billing).');
}
