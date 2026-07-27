import { Request, Response } from "express";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../app.js";
import {
  acceptFriendRequest,
  ACHIEVEMENTS,
  buyItem,
  declineFriendRequest,
  getWallet,
  getWalletIfExists,
  msUntilNextCredit,
  removeFriend,
  saveWallet,
  sendFriendRequest,
  SHOP_ITEMS,
} from "../game/wallet.js";
import { getLiveRoomSummaries, isUserOnline } from "../game/manager.js";

export async function walletHandler(req: Request, res: Response): Promise<any> {
  const { username, displayName } = req.body;
  if (!username || typeof username !== "string") {
    return res.status(400).json({ message: "username required" });
  }
  try {
    const wallet = await getWallet(username);
    if (
      typeof displayName === "string" &&
      displayName.trim() &&
      wallet.displayName !== displayName.trim().slice(0, 50)
    ) {
      wallet.displayName = displayName.trim().slice(0, 50);
      await saveWallet(wallet);
    }
    return res.json({
      credits: wallet.credits,
      coins: wallet.coins,
      avatar: wallet.avatar,
      ownedAvatars: wallet.ownedAvatars,
      wins: wallet.wins,
      gamesPlayed: wallet.gamesPlayed,
      points: wallet.points,
      currentStreak: wallet.currentStreak,
      bestStreak: wallet.bestStreak,
      achievements: wallet.achievements,
      achievementCatalog: ACHIEVEMENTS.map((a) => ({
        id: a.id,
        name: a.name,
      })),
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

const FRESH_LOBBY_MS = 60 * 60 * 1000;

/**
 * The single definition of an "active" lobby, shared by the homepage list
 * and the active-rooms counter: joinable (waiting/countdown) AND either
 * someone is connected right now or it was created within the last hour.
 */
export async function listActiveLobbies() {
  const scan = await docClient.send(
    new ScanCommand({
      TableName: "Lobbies",
      ProjectionExpression: "code, roomName, players, createdAt, #st",
      ExpressionAttributeNames: { "#st": "state" },
    })
  );
  const live = getLiveRoomSummaries();
  return (scan.Items ?? [])
    .filter((l: any) => l.state !== "finished")
    .map((l: any) => {
      const liveRoom = live.find((r) => r.code === Number(l.code));
      return {
        code: Number(l.code),
        roomName: l.roomName ?? `Room ${l.code}`,
        playerCount: liveRoom ? liveRoom.connectedCount : 0,
        phase: liveRoom ? liveRoom.phase : "lobby",
        isLive: Boolean(liveRoom),
        createdAt: l.createdAt ?? null,
      };
    })
    .filter((l) => {
      if (l.phase !== "lobby" && l.phase !== "countdown") return false;
      if (l.isLive && l.playerCount > 0) return true;
      const age = Date.now() - new Date(l.createdAt ?? 0).getTime();
      return age < FRESH_LOBBY_MS;
    })
    .sort(
      (a, b) =>
        new Date(b.createdAt ?? 0).getTime() -
        new Date(a.createdAt ?? 0).getTime()
    )
    .slice(0, 20);
}

export async function lobbiesHandler(_req: Request, res: Response): Promise<any> {
  try {
    return res.json({ lobbies: await listActiveLobbies() });
  } catch (err) {
    console.error("lobbies error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

// ---------------------------------------------------------------- friends

export async function friendsListHandler(
  req: Request,
  res: Response
): Promise<any> {
  const { username } = req.body;
  if (!username) return res.status(400).json({ message: "username required" });
  try {
    const me = await getWallet(String(username));
    const friends = await Promise.all(
      me.friends.map(async (name) => {
        const w = await getWalletIfExists(name);
        return {
          username: name,
          displayName: w?.displayName ?? name,
          online: isUserOnline(name),
          points: w?.points ?? 0,
          currentStreak: w?.currentStreak ?? 0,
          wins: w?.wins ?? 0,
        };
      })
    );
    return res.json({
      friends: friends.sort(
        (a, b) => Number(b.online) - Number(a.online) || b.points - a.points
      ),
      requests: me.friendRequests,
    });
  } catch (err) {
    console.error("friends list error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

export async function friendActionHandler(
  req: Request,
  res: Response
): Promise<any> {
  const { username, target, action } = req.body;
  if (!username || !target || !action) {
    return res
      .status(400)
      .json({ message: "username, target and action required" });
  }
  try {
    const me = String(username);
    const them = String(target);
    if (action === "request") {
      const result = await sendFriendRequest(me, them);
      if (result !== "sent" && result !== "accepted") {
        return res.status(400).json({ message: result });
      }
      return res.json({ status: result });
    }
    if (action === "accept") {
      const result = await acceptFriendRequest(me, them);
      if (result !== "accepted") {
        return res.status(400).json({ message: result });
      }
      return res.json({ status: result });
    }
    if (action === "decline") {
      await declineFriendRequest(me, them);
      return res.json({ status: "declined" });
    }
    if (action === "remove") {
      await removeFriend(me, them);
      return res.json({ status: "removed" });
    }
    return res.status(400).json({ message: "Unknown action" });
  } catch (err) {
    console.error("friend action error:", err);
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
        displayName: w.displayName ?? w.username,
        wins: w.wins ?? 0,
        gamesPlayed: w.gamesPlayed ?? 0,
        coins: w.coins ?? 0,
        points: w.points ?? 0,
        currentStreak: w.currentStreak ?? 0,
        bestStreak: w.bestStreak ?? 0,
      }))
      .filter((w) => w.gamesPlayed > 0)
      .sort((a, b) => b.points - a.points || b.wins - a.wins)
      .slice(0, 20);
    return res.json({ leaderboard: top });
  } catch (err) {
    console.error("leaderboard error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}
