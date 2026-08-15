/**
 * ===========================================================================
 * lib/lobbies.mjs — reads against the Lobbies and Wallets tables
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import {
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import { LOBBIES_TABLE, WALLETS_TABLE } from "./config.mjs";

// ─── the Lobbies table (shared with the REST stack) ────────────────────────
/** accepts a lobby_id (UUID, the URL form) or a numeric room code */
async function resolveLobby(idOrCode) {
  const key = String(idOrCode ?? "").trim();
  if (!key) return null;
  if (/^\d+$/.test(key)) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: LOBBIES_TABLE,
        IndexName: "code-index",
        KeyConditionExpression: "#code = :val",
        ExpressionAttributeNames: { "#code": "code" },
        ExpressionAttributeValues: { ":val": Number(key) },
      })
    );
    return res.Items?.[0] ?? null;
  }
  const res = await ddb.send(
    new GetCommand({ TableName: LOBBIES_TABLE, Key: { lobby_id: key } })
  );
  return res.Item ?? null;
}

/** cosmetic only: streak badge + avatar. Never fatal. */
async function walletProfile(username) {
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: WALLETS_TABLE, Key: { username } })
    );
    return {
      streak: Number(res.Item?.currentStreak ?? 0),
      avatar: res.Item?.avatar ?? null,
    };
  } catch {
    return { streak: 0, avatar: null };
  }
}

export {
  resolveLobby,
  walletProfile,
};
