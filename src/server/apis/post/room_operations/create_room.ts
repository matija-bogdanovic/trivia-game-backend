import { Request, Response } from "express";
import { docClient } from "../../../app.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import uuid4 from "uuid4";
import bcrypt from "bcrypt";
import {
  getWallet,
  msUntilNextCredit,
  spendLobbyCredit,
} from "../../../game/wallet.js";
import { AuthedRequest, authedUsername } from "../../../middleware/auth.js";

export default async function createRoom(
  req: AuthedRequest,
  res: Response
): Promise<any> {
  try {
    const dateNow = new Date().toISOString();

    const roomCode = Math.floor(Math.random() * 900000) + 100000;

    const createdBy = authedUsername(req);
    const { playerId, roomName, isPrivate, password } = req.body;
    if (!roomName) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const roomIsPrivate = Boolean(isPrivate);
    if (roomIsPrivate) {
      if (typeof password !== "string" || password.length < 4) {
        return res
          .status(400)
          .json({ error: "Private rooms need a password (4+ characters)" });
      }
    }
    const passwordHash = roomIsPrivate
      ? await bcrypt.hash(String(password), 10)
      : null;

    // creating a lobby costs a credit — the anti-spam throttle
    const wallet = await spendLobbyCredit(createdBy);
    if (!wallet) {
      const current = await getWallet(createdBy);
      return res.status(403).json({
        error: "Not enough credits",
        credits: current.credits,
        nextCreditInMs: msUntilNextCredit(current),
      });
    }
    const lobbyId = uuid4();
    await docClient.send(
      new PutCommand({
        TableName: "Lobbies",
        Item: {
          lobby_id: lobbyId,
          createdAt: dateNow,
          roomName: String(roomName),
          code: Number(roomCode),
          isPrivate: roomIsPrivate,
          ...(passwordHash ? { passwordHash } : {}),
          players: [
            {
              id: String(playerId),
              player: createdBy,
              role: "Admin",
              points: Number(500),
            },
          ],
          // no rounds array — games always run until one player has money
          spectators: [],
        },
      })
    );

    res.json({
      message: "Room created",
      roomCode: roomCode,
      lobbyId,
      creditsLeft: wallet.credits,
    });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
}
