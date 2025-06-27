import { Request, Response } from "express";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";

export default async function joinRoom(
  req: Request,
  res: Response
): Promise<any> {
  try {
    const { roomCode, id, username } = req.body;

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

    const playerExists = players.some((p: any) => p.player === String(username));
    if (playerExists) {
      return res.status(200).json(data);
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

    const updateResult = await docClient.send(new UpdateCommand(updateParams));
    return res
      .status(200)
      .json({ roomPlayers: updateResult.Attributes?.players });
  } catch (error) {
    console.error("Something went wrong:", error);
    return res.status(500).json({ message: "Server error" });
  }
}
