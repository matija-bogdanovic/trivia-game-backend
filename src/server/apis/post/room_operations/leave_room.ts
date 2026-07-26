import { Request, Response } from "express";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";
interface Player {
  id: string;
  player: string;
  role: string;
  points: number;
}

interface RoomDocument {
  code: string | number;
  players: Player[];
  lobby_id: string;
}

export default async function leaveRoom(req: Request, res: Response): Promise<any> {
  const { username, code } = req.body;

  try {
    console.log("Detected")
    const scanResult = await queryByKey("Lobbies", "code", Number(code), "code-index");
    if (!scanResult[0] || scanResult[0].players.length === 0) {
      return res.status(404).json({ message: "User not found in any room" });
    }

    // Assuming player is in only one room; take first match
    const room: RoomDocument = scanResult[0] as RoomDocument;

    // Step 2: Find the leaving player and check role
    const leavingPlayer = room.players.find(p => p.player === username);
    if (!leavingPlayer) {
      return res.status(404).json({ message: "User not found in any room" });
    }

    const isAdmin = leavingPlayer.role === "Admin";
    const updatedPlayers = room.players.filter(p => p.player !== username);

    // if the admin leaves, the next player inherits the room
    if (isAdmin && updatedPlayers.length > 0) {
      updatedPlayers[0] = { ...updatedPlayers[0], role: "Admin" };
    }

    await docClient.send(
      new UpdateCommand({
        TableName: "Lobbies",
        Key: { lobby_id: String(room.lobby_id) },
        UpdateExpression: "SET players = :updatedPlayers",
        ExpressionAttributeValues: {
          ":updatedPlayers": updatedPlayers,
        },
      })
    );

    return res.status(200).json({ message: "User removed from room", player: username });
  } catch (error) {
    console.error("Error in leaveRoom:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
