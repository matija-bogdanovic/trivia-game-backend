import { Request, Response } from "express";
import pkg from "aws-sdk";
import { getWallet, saveWallet } from "../game/wallet.js";

const { S3 } = pkg;
const s3 = new S3({ region: "eu-west-3" });
const AVATAR_BUCKET = "ipak-se-okrece-avatars";
// uploads arrive as a browser-downscaled 256x256 JPEG data URL
const MAX_DATA_URL_LENGTH = 700_000; // ~500 KB decoded

export async function uploadAvatarHandler(
  req: Request,
  res: Response
): Promise<any> {
  const { username, image } = req.body;
  if (!username || typeof username !== "string") {
    return res.status(400).json({ message: "username required" });
  }
  if (typeof image !== "string" || image.length > MAX_DATA_URL_LENGTH) {
    return res.status(400).json({ message: "Image missing or too large" });
  }
  const match = image.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) {
    return res.status(400).json({ message: "Unsupported image format" });
  }
  try {
    const body = Buffer.from(match[2], "base64");
    await s3
      .putObject({
        Bucket: AVATAR_BUCKET,
        Key: `avatars/${encodeURIComponent(username)}.jpg`,
        Body: body,
        ContentType: `image/${match[1]}`,
      })
      .promise();
    // the wallet is the source of truth for the avatar pointer — no
    // Cognito attribute write needed (federated tokens can't do those
    // without extra scopes)
    const avatar = `u|${Date.now()}`;
    const wallet = await getWallet(username);
    wallet.avatar = avatar;
    await saveWallet(wallet);
    return res.json({ avatar });
  } catch (err) {
    console.error("avatar upload error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function getAvatarImageHandler(
  req: Request,
  res: Response
): Promise<any> {
  const { username } = req.params;
  try {
    const obj = await s3
      .getObject({
        Bucket: AVATAR_BUCKET,
        Key: `avatars/${encodeURIComponent(String(username))}.jpg`,
      })
      .promise();
    res.setHeader("Content-Type", obj.ContentType ?? "image/jpeg");
    // versioned query string does the cache-busting
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(obj.Body);
  } catch (err: any) {
    if (err.code === "NoSuchKey") return res.status(404).end();
    console.error("avatar fetch error:", err);
    return res.status(500).end();
  }
}
