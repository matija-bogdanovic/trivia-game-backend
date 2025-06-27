import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import "dotenv/config";
import { client } from "./middleware/database_conn/dynamodb/connection.js";
import router from "./apis/operations.js";
import { createServer } from "http";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { WebSocketServer } from "ws";
import { broadcastMessage } from "./middleware/websocket/broadcast.js";
import { queryByKey } from "./helpers/query_db.js";
import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";

export const app = express();
const server = createServer(app);
export const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request);
  });
});

wss.on("connection", (ws) => {
  ws.on("message", async (message) => {
    try {
      const parsed = JSON.parse(message.toString());

      if (parsed.message === "question_retrieval") {
        const queriedItem = await queryByKey(
          "Lobbies",
          "code",
          Number(parsed.code),
          "code-index"
        );
        const data = queriedItem[0];
        const index = data.rounds.findIndex(
          (r: { status: string }) => r.status === "started"
        );

        const oppositeAnswerer = data.rounds[index].currentlyAnswering;
        const oppositeAnswererToUpdate = data.players.find(
          (p: { player: string }) => p.player !== oppositeAnswerer
        );

        const randomQuestionId = Math.floor(Math.random() * 14) + 1;

        await docClient.send(
          new UpdateCommand({
            TableName: "Lobbies",
            Key: { lobby_id: data.lobby_id },
            UpdateExpression: `
      SET 
        #rounds[${index}].#currentlyAnswering = :currentlyAnswering,
        #rounds[${index}].#currentQuestionId = :currentQuestionId,
    `,
            ExpressionAttributeNames: {
              "#rounds": "rounds",
              "#currentlyAnswering": "currentlyAnswering",
              "#currentQuestionId": "currentQuestionId",
            },
            ExpressionAttributeValues: {
              ":currentlyAnswering": oppositeAnswererToUpdate.player,
              ":currentQuestionId": String(randomQuestionId),
              ":status": "started",
            },
            ReturnValues: "ALL_NEW",
          })
        );

        // Get the question data
        const questionData = await docClient.send(
          new GetCommand({
            TableName: "Questions",
            Key: {
              question_id: String(randomQuestionId),
            },
          })
        );
        // Combine both into a single broadcast payload
        broadcastMessage(wss, {
          type: "question_retrieval",
          question_details: questionData.Item,
        });
      } else if (parsed.message === "submit_answer") {
        try {
          const questions = await docClient.send(
            new GetCommand({
              TableName: "Questions",
              Key: {
                question_id: String(parsed.questionId),
              },
            })
          );
          const lobbies = await queryByKey(
            "Lobbies",
            "code",
            Number(parsed.roomCode),
            "code-index"
          );

          const question = questions.Item;

          if (!question) {
            return broadcastMessage(wss, { message: "Question not found" });
          }

          const isCorrect = question.answer === parsed.selectedOption;

          if (isCorrect) {
            return broadcastMessage(wss, {
              status: true,
              username: parsed.username,
              message: "Correct!",
              correctAnswer: question.answer,
              type: "submit_answer",
            });
          } else {
            const item = lobbies[0];
            const rounds = item.rounds;
            const roundStatus = rounds.findIndex(
              (r: any) => r.status === "started"
            );

            if (roundStatus !== -1) {
              await docClient.send(
                new UpdateCommand({
                  TableName: "Lobbies",
                  Key: { lobby_id: String(item.lobby_id) },
                  UpdateExpression: `SET #rounds[${roundStatus}].#status = :status`,
                  ExpressionAttributeNames: {
                    "#rounds": "rounds",
                    "#status": "status",
                  },
                  ExpressionAttributeValues: {
                    ":status": "finished",
                  },
                })
              );
            } else {
              console.warn("No active round with status 'started' found.");
            }

            return broadcastMessage(wss, {
              status: false,
              username: parsed.username,
              correctAnswer: question.answer,
              type: "submit_answer",
            });
          }
        } catch (error) {
          console.error("Error checking answer:", error);
          return broadcastMessage(wss, { message: "Internal server error" });
        }
      } else if (parsed.message === "join_message") {
        try {
          if (isNaN(parsed.roomCode)) {
            ws.send(JSON.stringify({ message: "Invalid room code" }));
          }

          const items = await queryByKey(
            "Lobbies",
            "code",
            Number(parsed.roomCode),
            "code-index"
          );
          const data = items[0];
          data.type = "join_message";
          if (!data) {
            return ws.send(JSON.stringify({ message: "Room not found" }));
          }

          const primaryKey = data.lobby_id;
          const players = data.players || [];

          const playerExists = players.some(
            (p: any) => p.player === parsed.username
          );

          if (playerExists) {
            const updatedItems = items[0];
            updatedItems.message =
              "A player already exists in the database, nothing had changed.";
            broadcastMessage(wss, updatedItems);
          } else {
            const updateParams = {
              TableName: "Lobbies",
              Key: { lobby_id: String(primaryKey) },
              UpdateExpression:
                "SET players = list_append(if_not_exists(players, :emptyList), :newPlayerList)",
              ExpressionAttributeValues: {
                ":newPlayerList": [
                  {
                    id: parsed.id,
                    player: parsed.username,
                    role: "Member",
                    points: 500,
                  },
                ],
                ":emptyList": [],
              },
              ReturnValues: "ALL_NEW" as const,
            };
            await docClient.send(new UpdateCommand(updateParams));
            const roomitem = await queryByKey(
              "Lobbies",
              "code",
              Number(parsed.roomCode),
              "code-index"
            );
            const updatedItems = roomitem[0];
            updatedItems.type = "join_message";
            broadcastMessage(wss, updatedItems);
          }
        } catch (error) {
          console.error("Something went wrong:", error);
          return ws.send(JSON.stringify({ message: "Server error" }));
        }
      } else if (parsed.message === "game_start") {
        const code = Number(parsed.code);

        const room = await queryByKey(
          "Lobbies",
          "code",
          Number(code),
          "code-index"
        );
        const data = room[0];

        if (!data) {
          return broadcastMessage(wss, { message: "No room found!" });
        }

        const playersArray = data.players;

        if (playersArray.length === 0) {
          return broadcastMessage(wss, { message: "No players in the room!" });
        }

        const randomQuestionId = Math.floor(Math.random() * 14) + 1;
        const randomPlayer =
          playersArray[Math.floor(Math.random() * playersArray.length)];
        const index = data.rounds.findIndex(
          (data: {
            status: string;
            currentQuestionId: string;
            currentlyAnswering: string;
          }) => data.status === "notStarted"
        );
        await client.send(
          new UpdateCommand({
            TableName: "Lobbies",
            Key: { lobby_id: String(data.lobby_id) },
            UpdateExpression: `SET #rounds[${index}].#status = :status, #rounds[${index}].#currentlyAnswering = :randomPlayer, #rounds[${index}].#currentQuestionId = :currentQuestionId`,
            ExpressionAttributeNames: {
              "#rounds": "rounds",
              "#status": "status",
              "#currentlyAnswering": "currentlyAnswering",
              "#currentQuestionId": "currentQuestionId",
            },
            ExpressionAttributeValues: {
              ":currentQuestionId": randomQuestionId,
              ":randomPlayer": String(randomPlayer.player),
              ":status": "started",
            },
            ReturnValues: "ALL_NEW" as const,
          })
        );
        const updatedResults = await queryByKey(
          "Lobbies",
          "code",
          Number(parsed.code),
          "code-index"
        );
        const updatedIndex = updatedResults[0].rounds.findIndex(
          (data: {
            status: string;
            currentQuestionId: string;
            currentlyAnswering: string;
          }) => data.status === "started"
        );
        const player =
          updatedResults[0].rounds[updatedIndex].currentlyAnswering;
        const question = await client.send(
          new GetCommand({
            TableName: "Questions",
            Key: {
              question_id: String(
                updatedResults[0].rounds[updatedIndex].currentQuestionId
              ),
            },
          })
        );

        broadcastMessage(wss, {
          type: "game_start",
          selected_player: player,
          question_details: question.Item,
        });
      } else if (parsed.message === "number_of_players") {
        const result = await queryByKey(
          "Lobbies",
          "code",
          Number(parsed.code),
          "code-index"
        );

        const item = result[0];
        item.type = "number_of_players";
        broadcastMessage(wss, item);
      } else if (parsed.message === "change_current_player") {
        try {
          const queriedItem = await queryByKey(
            "Lobbies",
            "code",
            Number(parsed.code),
            "code-index"
          );
          const data = queriedItem[0]
          const index = data.rounds.findIndex(
            (data: {
              status: string;
              currentQuestionId: string;
              currentlyAnswering: string;
            }) => data.status === "started"
          );
          const oppositeAnswerer = data.rounds[index].currentlyAnswering;
          const oppositeAnswererToUpdate = data.players.find(
            (data: {
              id: string;
              player: string;
              points: number;
              role: string;
            }) => data.player !== oppositeAnswerer
          );
          const randomQuestionId = Math.floor(Math.random() * 14) + 1;
          await client.send(
            new UpdateItemCommand({
              TableName: "Lobbies",
              Key: { lobby_id: { S: String(data.lobby_id) } },
              UpdateExpression: `
      SET 
        #rounds[${index}].#currentlyAnswering = :currentlyAnswering,
        #rounds[${index}].#currentQuestionId = :questionId
    `,
              ExpressionAttributeNames: {
                "#rounds": "rounds",
                "#currentlyAnswering": "currentlyAnswering",
                "#currentQuestionId": "currentQuestionId",
              },
              ExpressionAttributeValues: {
                ":questionId": { S: String(randomQuestionId) },
                ":currentlyAnswering": {
                  S: String(oppositeAnswererToUpdate.player),
                },
              },
              ReturnValues: "ALL_NEW",
            })
          );
        } catch (error) {
          console.error(error);
          return ws.send(JSON.stringify({ error: "Internal server error" }));
        }
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
      ws.send(
        JSON.stringify({ type: "error", message: "Internal server error" })
      );
    }
  });
});
app.use(cors({ origin: "http://localhost:3000", credentials: true }));
app.use(cookieParser());
app.use(express.json());

export const docClient = DynamoDBDocumentClient.from(client);

app.use("/", router);
// Middleware
server.listen(process.env.PORT);
