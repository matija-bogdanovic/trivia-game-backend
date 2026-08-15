/**
 * ===========================================================================
 * lib/aws.mjs — the shared DynamoDB document client
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { REGION } from "./config.mjs";

// clients at module scope so warm invocations reuse the connections.
// removeUndefinedValues: the game state has genuinely optional branches (turn,
// duel, currentPick) and an undefined would otherwise fail the whole write.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export {
  ddb,
};
