/**
 * ===========================================================================
 * lib/connections.mjs — the Connections table, postToConnection and lobby fan-out
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { ddb } from "./aws.mjs";
import {
  CONNECTIONS_TABLE,
  CONNECTION_TTL_SECONDS,
  LOBBY_INDEX,
  REGION,
  WS_ENDPOINT,
} from "./config.mjs";

// ─── outbound: ApiGatewayManagementApi ─────────────────────────────────────
// The management endpoint is per-API-and-stage and arrives on every event, so
// it is derived from the event rather than configured. Cached per endpoint so
// a warm container reuses the HTTP connection.
const managementClients = new Map();

function managementClientFor(event) {
  const domainName = event?.requestContext?.domainName;
  const stage = event?.requestContext?.stage;
  // a custom domain already carries its own base path; the default
  // execute-api domain needs the stage appended. A phase-timer invocation
  // arrives from Step Functions with no requestContext at all, so it falls
  // back to the configured endpoint.
  const endpoint =
    domainName && stage ? `https://${domainName}/${stage}` : WS_ENDPOINT;
  let client = managementClients.get(endpoint);
  if (!client) {
    client = new ApiGatewayManagementApiClient({ region: REGION, endpoint });
    managementClients.set(endpoint, client);
  }
  return client;
}

function isGone(err) {
  return (
    err?.name === "GoneException" || err?.$metadata?.httpStatusCode === 410
  );
}

/**
 * Send one message to one connection. A 410 means the client is long gone and
 * API Gateway has already forgotten it — reap the row so presence stops
 * counting a ghost. Returns false when the connection was dropped.
 */
async function postTo(event, connectionId, message) {
  try {
    await managementClientFor(event).send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      })
    );
    return true;
  } catch (err) {
    if (isGone(err)) {
      await deleteConnection(connectionId).catch(() => {});
      return false;
    }
    // one bad socket must not fail the whole broadcast
    console.error("postToConnection failed", connectionId, err);
    return false;
  }
}

// ─── the Connections table ─────────────────────────────────────────────────
function ttlFromNow() {
  return Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS;
}

async function getConnection(connectionId) {
  const res = await ddb.send(
    new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
  return res.Item ?? null;
}

async function deleteConnection(connectionId) {
  await ddb.send(
    new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })
  );
}

/**
 * Every live connection in one lobby, via the lobby-index GSI.
 *
 * Attribute names go through ExpressionAttributeNames throughout this file —
 * DynamoDB's reserved-word list is long and unmemorable, and a collision is a
 * runtime ValidationException, not something the console catches at paste time.
 */
async function connectionsInLobby(lobbyId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: LOBBY_INDEX,
      KeyConditionExpression: "#lobbyId = :lobbyId",
      ExpressionAttributeNames: { "#lobbyId": "lobbyId" },
      ExpressionAttributeValues: { ":lobbyId": lobbyId },
    })
  );
  return res.Items ?? [];
}

/** fan out to a whole lobby, skipping one connection if asked */
async function broadcast(event, lobbyId, message, exceptConnectionId = null) {
  const rows = await connectionsInLobby(lobbyId);
  await Promise.all(
    rows
      .filter((r) => r.connectionId !== exceptConnectionId)
      .map((r) => postTo(event, r.connectionId, message))
  );
}

export {
  broadcast,
  connectionsInLobby,
  deleteConnection,
  getConnection,
  isGone,
  managementClientFor,
  postTo,
  ttlFromNow,
};
