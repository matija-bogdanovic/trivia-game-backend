/**
 * One-off: creates the ChatMessages table — one item per chat line, ever.
 *
 *   node scripts/create_chat_table.mjs      (safe to re-run; skips if it exists)
 *
 * ── THE KEY, AND WHY ───────────────────────────────────────────────────────
 *   PK  lobbyId     every message a room ever carried, gathered under the room
 *   SK  message_id  `<epoch ms>#<8 hex>`
 *
 * The sort key is the timestamp with a short random suffix, as a STRING. That
 * gives three things at once: a Query on lobbyId returns the whole
 * conversation already in chronological order, a time range inside a room is a
 * key-condition rather than a filter, and two messages landing in the same
 * millisecond cannot overwrite each other — which a bare numeric timestamp
 * would allow, and which is exactly what a flurry at the end of a round looks
 * like.
 *
 * ── NO TTL, ON PURPOSE ─────────────────────────────────────────────────────
 * Every other ephemeral table here expires (GameState 24h, Connections 2h).
 * This one does not: the whole point is to COLLECT the messages, so an
 * `expiresAt` attribute is deliberately absent rather than merely unset. If
 * retention ever becomes a cost or privacy question, enabling TTL is a
 * one-line change here plus stamping the attribute at write time.
 *
 * ── NO GSI ─────────────────────────────────────────────────────────────────
 * "Every message in one room" is the access pattern the game has, and the PK
 * serves it. Bulk collection is a Scan, which is the right tool for an export
 * and the wrong one for a request path — nothing on a request path reads this
 * table at all.
 */
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import 'dotenv/config';

const TABLE = 'ChatMessages';

// eu-west-3 throughout, matching every other table in this stack
const client = new DynamoDBClient({ region: 'eu-west-3' });

try {
  const existing = await client.send(
    new DescribeTableCommand({ TableName: TABLE })
  );
  console.log(
    `${TABLE} already exists (${existing.Table.ItemCount} items) — nothing to do.`
  );
} catch (err) {
  if (err.name !== 'ResourceNotFoundException') throw err;
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      AttributeDefinitions: [
        { AttributeName: 'lobbyId', AttributeType: 'S' },
        { AttributeName: 'message_id', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'lobbyId', KeyType: 'HASH' },
        { AttributeName: 'message_id', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    })
  );
  console.log(`${TABLE} created (on-demand billing, no TTL by design).`);
}
