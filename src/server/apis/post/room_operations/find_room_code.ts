import { Request, Response } from "express";
import { docClient } from "../../../app.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";

export default async function findRoomCode(req: Request, res: Response) {
  try {
    const { roomCode } = req.body;

    if (isNaN(roomCode)) {
      return res.status(400).json({ error: "Invalid room code" });
    }

    const params = {
      TableName: "Lobbies", // replace with your actual table name
      Key: {
        code: roomCode, // assuming 'code' is your partition key attribute
      },
    };

    const command = new GetCommand(params);
    const result = await docClient.send(command);

    if (result.Item) {
      res.status(200).json({ foundRoomCode: result.Item });
    } else {
      res.status(404).json({ error: "Room not found" });
    }
  } catch (err) {
    console.error("Error fetching room code:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
