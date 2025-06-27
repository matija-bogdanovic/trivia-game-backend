import { Request, Response } from "express";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";

export default async function incorrectAnswer(
  req: Request,
  res: Response
): Promise<any> {
  const { username, roomCode } = req.body;

  try {
    const result = await queryByKey(
      "Lobbies",
      "code",
      Number(roomCode),
      "code-index"
    );

    const item = result[0];
    
    const playerIndex = item.players.findIndex(
      (e: any) => e.player === username
    );

    if (playerIndex === -1) {
      console.error("Player not found");
      return res.status(404).json({ message: "Player not found" });
    }

    const updatedPoints = (item.players[playerIndex].points || 0) - 100;
    const updateResult = await docClient.send(
      new UpdateCommand({
        TableName: "Lobbies",
        Key: { lobby_id: String(item.lobby_id) },
        UpdateExpression: `SET players[${playerIndex}].points = :newPoints`,
        ExpressionAttributeValues: {
          ":newPoints": updatedPoints,
        },
        ReturnValues: "UPDATED_NEW",
      })
    );

    if (updateResult.Attributes) {  
      return res.status(200).json({ message: "Player points updated" });
    } else {
      return res.status(500).json({ message: "Update failed" });
    }
  } catch (error) {
    console.error("Error updating player points:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
