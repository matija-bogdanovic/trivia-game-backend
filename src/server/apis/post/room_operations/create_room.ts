import { Request, Response } from "express";
import { docClient } from "../../../app.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import uuid4 from "uuid4";

export default async function createRoom(
  req: Request,
  res: Response
): Promise<any> {
  try {
    const dateNow = new Date().toISOString();

    const roomCode = Math.floor(Math.random() * 900000) + 100000;

    const { playerId, createdBy, roomName } = req.body;
    if (!createdBy || !roomName) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    await docClient.send(
      new PutCommand({
        TableName: "Lobbies",
        Item: {
          lobby_id: uuid4(),
          createdAt: dateNow,
          admin: String(createdBy),
          roomName: String(roomName),
          code: Number(roomCode),
          players: [
            {
              id: String(playerId),
              player: String(createdBy),
              role: "Admin",
              points: Number(500),
            },
          ],
          rounds: [
            {
              status: "notStarted",
              currentlyAnswering: "",
              currentQuestionId: "",
            },
            {
              status: "notStarted",
              currentlyAnswering: "",
              currentQuestionId: "",
            },
            {
              status: "notStarted",
              currentlyAnswering: "",
              currentQuestionId: "",
            },
            {
              status: "notStarted",
              currentlyAnswering: "",
              currentQuestionId: "",
            },
            {
              status: "notStarted",
              currentlyAnswering: "",
              currentQuestionId: "",
            },
          ],
          spectators: [],
        },
      })
    );

    res.json({ message: "Room created", roomCode: roomCode });
  } catch (error) {
    console.error("Error creating room:", error);
    res.status(500).json({ error: "Failed to create room" });
  }
}
