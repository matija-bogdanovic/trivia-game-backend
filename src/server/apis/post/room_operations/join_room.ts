import { Request, Response } from "express";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import bcrypt from "bcrypt";
import { docClient } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";
import { MAX_PLAYERS } from "../../../game/room.js";
import { isLiveRoomFull } from "../../../game/manager.js";

export default async function joinRoom(
  req: Request,
  res: Response
): Promise<any> {
  try {
    const { roomCode, id, username, password } = req.body;

    if (isNaN(roomCode)) {
      return res.status(400).json({ message: "Invalid room code" });
    }

    const items = await queryByKey(
      "Lobbies",
      "code",
      Number(roomCode),
      "code-index"
    );
    const data = items[0];
    if (!data) {
      return res.status(404).json({ message: "Room not found" });
    }

    const primaryKey = data.lobby_id;
    const players = data.players || [];
    const playerExists = players.some(
      (p: any) => p.player === String(username)
    );

    // members who already joined don't re-enter the password
    if (data.isPrivate && !playerExists) {
      if (typeof password !== "string" || password.length === 0) {
        return res.status(401).json({ message: "password_required" });
      }
      const ok = await bcrypt.compare(password, data.passwordHash ?? "");
      if (!ok) {
        return res.status(403).json({ message: "wrong_password" });
      }
    }

    if (playerExists) {
      return res.status(200).json({ lobbyId: primaryKey });
    }
    const liveFull = isLiveRoomFull(Number(roomCode));
    if (liveFull ?? players.length >= MAX_PLAYERS) {
      return res.status(409).json({ message: "room_full" });
    }
    if (!id || typeof id !== "string") {
      return res.status(400).json({ message: "Invalid or missing player ID" });
    }

    const updateParams = {
      TableName: "Lobbies",
      Key: { lobby_id: String(primaryKey) },
      UpdateExpression:
        "SET players = list_append(if_not_exists(players, :emptyList), :newPlayerList)",
      ExpressionAttributeValues: {
        ":newPlayerList": [
          {
            id: String(id),
            player: String(username),
            points: Number(500),
            role: String("Member"),
          },
        ],
        ":emptyList": [],
      },
      ReturnValues: "ALL_NEW" as const,
    };

    await docClient.send(new UpdateCommand(updateParams));
    return res.status(200).json({ lobbyId: primaryKey });
  } catch (error) {
    console.error("Something went wrong:", error);
    return res.status(500).json({ message: "Server error" });
  }
}
