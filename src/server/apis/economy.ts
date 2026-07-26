import { Request, Response } from "express";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";
import {
  buyItem,
  getWallet,
  msUntilNextCredit,
  SHOP_ITEMS,
} from "../game/wallet.js";
import { getLiveRoomSummaries } from "../game/manager.js";

export async function walletHandler(req: Request, res: Response): Promise<any> {
  const { username } = req.body;
  if (!username || typeof username !== "string") {
    return res.status(400).json({ message: "username required" });
  }
  try {
    const wallet = await getWallet(username);
    return res.json({
      credits: wallet.credits,
      coins: wallet.coins,
      ownedAvatars: wallet.ownedAvatars,
      wins: wallet.wins,
      gamesPlayed: wallet.gamesPlayed,
      nextCreditInMs: msUntilNextCredit(wallet),
      shop: SHOP_ITEMS,
    });
  } catch (err) {
    console.error("wallet error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function shopBuyHandler(req: Request, res: Response): Promise<any> {
  const { username, itemId } = req.body;
  if (!username || !itemId) {
    return res.status(400).json({ message: "username and itemId required" });
  }
  try {
    const result = await buyItem(String(username), String(itemId));
    if (typeof result === "string") {
      return res.status(400).json({ message: result });
    }
    return res.json({
      credits: result.credits,
      coins: result.coins,
      ownedAvatars: result.ownedAvatars,
    });
  } catch (err) {
    console.error("shop buy error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function lobbiesHandler(_req: Request, res: Response): Promise<any> {
  try {
    const scan = await docClient.send(
      new ScanCommand({
        TableName: "Lobbies",
        ProjectionExpression:
          "code, roomName, players, createdAt, #st",
        ExpressionAttributeNames: { "#st": "state" },
      })
    );
    const live = getLiveRoomSummaries();
    const lobbies = (scan.Items ?? [])
      .filter((l: any) => {
        if (l.state === "finished") return false;
        const age = Date.now() - new Date(l.createdAt ?? 0).getTime();
        return age < DAY_MS; // hide stale rooms
      })
      .map((l: any) => {
        const liveRoom = live.find((r) => r.code === Number(l.code));
        return {
          code: Number(l.code),
          roomName: l.roomName ?? `Room ${l.code}`,
          playerCount: liveRoom
            ? liveRoom.connectedCount
            : (l.players ?? []).length,
          phase: liveRoom ? liveRoom.phase : "lobby",
          createdAt: l.createdAt ?? null,
        };
      })
      .filter((l) => l.phase === "lobby" || l.phase === "countdown")
      .sort(
        (a, b) =>
          new Date(b.createdAt ?? 0).getTime() -
          new Date(a.createdAt ?? 0).getTime()
      )
      .slice(0, 20);
    return res.json({ lobbies });
  } catch (err) {
    console.error("lobbies error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function leaderboardHandler(_req: Request, res: Response): Promise<any> {
  try {
    const scan = await docClient.send(
      new ScanCommand({ TableName: "Wallets" })
    );
    const top = (scan.Items ?? [])
      .map((w: any) => ({
        username: w.username,
        wins: w.wins ?? 0,
        gamesPlayed: w.gamesPlayed ?? 0,
        coins: w.coins ?? 0,
      }))
      .filter((w) => w.gamesPlayed > 0)
      .sort((a, b) => b.wins - a.wins || b.coins - a.coins)
      .slice(0, 20);
    return res.json({ leaderboard: top });
  } catch (err) {
    console.error("leaderboard error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}
