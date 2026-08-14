import { PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { identityFromEvent } from "./shared/auth.js";
import {
  AVATAR_BUCKET,
  WALLETS_TABLE,
  avatarKey,
  docClient,
  freshWallet,
  json,
  s3,
} from "./shared/avatars.js";

/**
 * POST /avatar
 *
 * Authorization: Bearer <Cognito ACCESS token>
 * Body: { "image": "data:image/jpeg;base64,..." }
 * 200:  { "avatar": "u|<version>" }
 *
 * Lambda port of uploadAvatarHandler in src/server/apis/avatars.ts. Same
 * validation, same S3 key, same `u|<ts>` pointer — only the transport and the
 * SDK version differ (the Node 22 Lambda runtime ships AWS SDK v3, not v2).
 */

// uploads arrive as a browser-downscaled 256x256 JPEG data URL
const MAX_DATA_URL_LENGTH = 700_000; // ~500 KB decoded

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  // you can only ever overwrite your own avatar
  const identity = await identityFromEvent(event);
  if (!identity) {
    return json(401, { message: "Authentication required" });
  }
  const username = identity.username;

  let image: unknown;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : event.body ?? "";
    image = JSON.parse(raw).image;
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }

  if (typeof image !== "string" || image.length > MAX_DATA_URL_LENGTH) {
    return json(400, { message: "Image missing or too large" });
  }
  const match = image.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) {
    return json(400, { message: "Unsupported image format" });
  }

  try {
    const body = Buffer.from(match[2], "base64");
    await s3.send(
      new PutObjectCommand({
        Bucket: AVATAR_BUCKET,
        Key: avatarKey(username),
        Body: body,
        ContentType: `image/${match[1]}`,
      })
    );

    // the wallet is the source of truth for the avatar pointer — no Cognito
    // attribute write needed (federated tokens can't do those without extra
    // scopes). This pointer is what makes the new picture show up: the
    // frontend reads `avatar` off the wallet and appends the version as ?v=.
    const avatar = `u|${Date.now()}`;
    await setAvatarPointer(username, avatar);

    return json(200, { avatar });
  } catch (err) {
    console.error("avatar upload error:", err);
    return json(500, { message: "Internal server error" });
  }
};

/**
 * Writes just the `avatar` attribute instead of rewriting the whole item the
 * way the Express handler's getWallet/saveWallet pair does. Same end state,
 * but a concurrent coin/streak write from a finishing match can no longer be
 * clobbered by a read-modify-write race. When the player has no wallet yet,
 * the conditional update fails and we create the full default row.
 */
async function setAvatarPointer(username: string, avatar: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: WALLETS_TABLE,
        Key: { username },
        UpdateExpression: "SET avatar = :avatar",
        ExpressionAttributeValues: { ":avatar": avatar },
        ConditionExpression: "attribute_exists(username)",
      })
    );
  } catch (err: any) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
    await docClient.send(
      new PutCommand({
        TableName: WALLETS_TABLE,
        Item: freshWallet(username, avatar),
        // lost the race against a wallet created in between — retry the update
        ConditionExpression: "attribute_not_exists(username)",
      })
    ).catch(async (putErr: any) => {
      if (putErr?.name !== "ConditionalCheckFailedException") throw putErr;
      await docClient.send(
        new UpdateCommand({
          TableName: WALLETS_TABLE,
          Key: { username },
          UpdateExpression: "SET avatar = :avatar",
          ExpressionAttributeValues: { ":avatar": avatar },
        })
      );
    });
  }
}
