import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResultV2 } from "aws-lambda";

export const AWS_REGION = process.env.AWS_REGION ?? "eu-west-3";
export const AVATAR_BUCKET =
  process.env.AVATAR_BUCKET ?? "ipak-se-okrece-avatars";
export const WALLETS_TABLE = process.env.WALLETS_TABLE ?? "Wallets";

/** clients live at module scope so warm containers reuse the connections */
export const s3 = new S3Client({ region: AWS_REGION });
export const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION })
);

/**
 * The one place the object key is built. Identical to the Express handler:
 * `avatars/{username}.jpg`, url-encoded so a username with a slash or space
 * can't reshape the key. The extension stays `.jpg` even for a png/webp body
 * — the key is an identity pointer, not a filename, and the real type rides
 * on the object's Content-Type.
 */
export function avatarKey(username: string): string {
  return `avatars/${encodeURIComponent(username)}.jpg`;
}

/** JSON response in the shape API Gateway expects */
export function json(
  statusCode: number,
  body: unknown
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * A brand-new wallet row. These defaults are a deliberate mirror of
 * freshWallet() in src/server/game/wallet.ts — the Express upload handler
 * calls getWallet(), which invents a full row when the player has none, and
 * an avatar upload can legitimately be a player's first write. Keep the two
 * in sync when the Wallet shape changes.
 */
export function freshWallet(username: string, avatar: string) {
  return {
    username,
    credits: 5, // CREDIT_CAP
    lastRefillAt: Date.now(),
    coins: 0,
    ownedAvatars: [] as string[],
    wins: 0,
    gamesPlayed: 0,
    roundsPlayed: 0,
    matchHistory: [] as unknown[],
    points: 0,
    currentStreak: 0,
    bestStreak: 0,
    betsWon: 0,
    achievements: [] as string[],
    friends: [] as string[],
    friendRequests: [] as string[],
    avatar,
    displayName: null as string | null,
  };
}
