import { Request, Response } from "express";
import { docClient, wss } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";
import { broadcastMessage } from "../../../middleware/websocket/broadcast.js";
import { generateRandomNumber } from "../../../helpers/generate_random_number.js";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { client } from "../../../middleware/database_conn/dynamodb/connection.js";

export async function startGame(req: Request, res: Response): Promise<any> {
  const { gameStarted, code, currentlyAnswering, currentQuestionId } = req.body;

  if (!gameStarted || !code) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {

    const rooms = await queryByKey(
      "Lobbies",
      "code",
      Number(code),
      "code-index"
    );
    const getCommand = new GetItemCommand({
      TableName: "Lobbies",
      Key: {
        lobby_id: { S: rooms[0].lobby_id },
      },
    });

    const { Item } = await client.send(getCommand);

    if (!rooms || rooms.length === 0) {
      return res.status(404).json({ message: "Room not found by code" });
    }

    const room = rooms[0];
    const roomId = room.lobby_id;
    const players = room.players;
    const randomPlayer = players[Math.floor(Math.random() * players.length)];
    const randomLength = Math.floor(Math.random() * players.length);
    const data = unmarshall(Item);
    const index = data.rounds.findIndex(
      (round: any) => round.status === "started"
    );
    if (index === -1) {
      return res.status(400).json({ message: "No started round found" });
    }
    data.rounds[index].currentlyAnswering = currentlyAnswering;
    data.rounds[index].currentQuestionId = currentQuestionId;

    const updateCommand = new UpdateItemCommand({
      TableName: "Lobbies",
      Key: {
        lobby_id: { S: roomId },
      },
      UpdateExpression: `SET #rounds = :updatedRounds, #state = :state`,
      ExpressionAttributeNames: {
        "#rounds": "rounds",
        "#state": "state",
      },
      ExpressionAttributeValues: {
        ":updatedRounds": {
          L: data.rounds.map(
            (data: {
              currentlyAnswering: string;
              currentQuestionId: string;
              status: string;
            }) => ({
              M: marshall(data),
            })
          ),
        },
        ":state": { S: "started" },
      },
      ReturnValues: "UPDATED_NEW",
    });
    const roomsUpdated = await queryByKey(
      "Lobbies",
      "code",
      Number(code),
      "code-index"
    );
    await client.send(updateCommand);
    console.log(
      roomsUpdated[0]!.rounds.find(
        (data: {
          status: string;
          currently_answering: string;
          question_id: string;
        }) => data.status === "started"
      ).currentlyAnswering
    );
    broadcastMessage(wss, {
      type: "game_start",
      time: generateRandomNumber(5000, 10000),
      selected_player: String(players[randomLength].player),

      currentlyAnswering: roomsUpdated[0]!.rounds.find(
        (data: any) => data.status === "started"
      ).currentlyAnswering,
    });

    return res.status(200).json({
      message: "Game started",
    });
  } catch (error) {
    console.error("Error starting game:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
