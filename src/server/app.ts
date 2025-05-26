// app.ts

import express, { Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import "dotenv/config";

// Routes and logic
import {
  attachWSServer,
  client,
  server,
  ws,
} from "./middleware/database_conn/redis/connection.js";
import { helperFunction } from "./apis/websocket_functions.js";
import { getUsernames } from "./apis/get_usernames.js";
import { pressedCircle } from "./apis/pressed_circle.js";
import { startGame } from "./apis/start_game.js";
import { registerUser } from "./apis/login.js";
import { WebSocket } from "ws";
import AWS from "aws-sdk";

const app = express();

const dynamoDb = new AWS.DynamoDB();

dynamoDb
  .putItem({
    TableName: "Players",
    Item: {
      id: { S: "user123" },
      username: { S: "Ognjanija govnarija" },
      email: { S: "nomail" },
    },
  })
  .promise();

// Connect Redis
await client.connect();

// Middleware
app.use(cors({ origin: "http://localhost:3001", credentials: true }));
app.use(cookieParser());
app.use(express.json());

// API routes
app.post("/login", registerUser);
app.post("/pressedCircle", pressedCircle);
app.post("/startGame", startGame);

app.get("/getusernames", getUsernames);
app.get("/getGameState", async (_: Request, res: Response) => {
  const dbData = (await client.get("gameStatus")) as string;
  res.json({ gameState: dbData });
});
app.get("/playerNum", async (_: Request, res: Response) => {
  const usernames = (await client.json.get("usernames:usernames")) as string;
  const parsedUsernames = JSON.parse(usernames);
  res.json(parsedUsernames);
});

// Attach WebSocket server
attachWSServer();
server.on("request", app);

// WebSocket logic
ws.on("connection", async (wss: WebSocket & { username?: string }, req) => {
  const isHomePage = req.url === "/";
  const isGameConnection = req.url === "/game";
  const isEndscreenConnection = req.url === "/endscreen";
  if (isHomePage) {
    const usernames = (await client.json.get("usernames:usernames")) as string;
    const parsedUsernames = JSON.parse(usernames)["usernames"];
    helperFunction({ parsedUsernames: parsedUsernames });
  }
  if (isGameConnection) {
    const usernames = (await client.json.get("usernames:usernames")) as string;
    const parsedUsernames = JSON.parse(usernames)["usernames"];
    helperFunction({ type: "updatedNames", props: parsedUsernames });
  }

  wss.on("message", async (event: string) => {
    if (isHomePage) {
      const message = JSON.parse(event);
      const cookieCheck = req.headers.cookie || "";
      const hasToken = /(?:^|;\s*)token=([^;]+)/.test(cookieCheck);
      if (message?.getCookie && hasToken) {
        const tokenvalue = req.headers.cookie;
        const tokenMatch = tokenvalue.match(/token=([^;]+)/);
        const token = tokenMatch ? tokenMatch[1] : null;
        const verified = jwt.verify(token, process.env.SECRET) as any;

        console.log(verified);
        wss.send(
          JSON.stringify({
            username: verified.username,
            type: "retrievedUsername",
          })
        );
      } else if (!hasToken) {
        wss.send(JSON.stringify({ noCookie: true }));
      }
      if (message.retrieveUsers) {
        const usernames = await client.json.get("usernames:usernames");
        helperFunction({ parsedUsernames: usernames });
      }
    }

    if (isGameConnection) {
      const message = JSON.parse(event);
      const getRounds = (await client.json.get("rounds")) as any;
      const parsed = JSON.parse(getRounds);
      const randomNumber = Math.floor(Math.random() * (10000 - 2 + 1)) + 2;
      const getGameStatus = (await client.get("gameStatus")) as string;
      if (message?.joined) {
        wss.username = message.username;
        console.log(message?.username);
        const usernames = (await client.json.get(
          "usernames:usernames"
        )) as string;
        const parsedUsernames = JSON.parse(usernames)["usernames"];
        helperFunction({
          type: "updatedNames",
          joined: true,
          props: parsedUsernames,
        });
      }
      if (message?.gameStarted) {
        helperFunction({ started: true });
        return;
      }
      if (message?.roundEnded) {
        helperFunction({ roundEnded: true });
      }

      const roundNames = [
        "First Round",
        "Second Round",
        "Third Round",
        "Fourth Round",
        "Fifth Round",
      ];

      for (const round of roundNames) {
        const state = parsed[round]?.state;
        if (state === "started") {
          helperFunction({
            roundCount: round,
            randomNumber,
            gameStarted: JSON.parse(getGameStatus),
          });
          return;
        } else if (round === "Fifth Round" && state === "finished") {
          await client.set("gameStatus", "false");
          helperFunction({ matchEnd: true });
          return;
        }
      }
    }

    if (isEndscreenConnection) {
      const users = (await client.json.get("usernames:usernames")) as string;
      const parsed = JSON.parse(users);
      const message = JSON.parse(event);

      if (message?.playAgain) {
        await client.json.set("rounds", "$", {
          "First Round": { winner: "", state: "notStarted" },
          "Second Round": { winner: "", state: "notStarted" },
          "Third Round": { winner: "", state: "notStarted" },
          "Fourth Round": { winner: "", state: "notStarted" },
          "Fifth Round": { winner: "", state: "notStarted" },
        });
        await client.set("gameStatus", "false");
        await client.json.set("usernames:usernames", "$", { usernames: [] });
      }

      if (parsed) {
        const flattened = [].concat(...Object.values(parsed));
        const maxHealth = Math.max(...flattened.map((u: any) => u.health));
        const topPlayers = flattened.filter((u: any) => u.health === maxHealth);
        helperFunction({
          topPlayers: topPlayers.map((u: any) => u.username),
          maxHealth,
        });
      } else {
        helperFunction({ topPlayers: [], maxHealth: null });
      }
    }
  });

  wss.on("close", async () => {
    if (isGameConnection) {
      if (wss.username) {
        console.log(`${wss.username} disconnected`);

        const usernames = (await client.json.get("usernames:usernames")) as any;
        if (usernames?.usernames) {
          const updated = usernames.usernames.filter(
            (u: any) => u.username !== wss.username
          );
          await client.json.set("usernames:usernames", "$", {
            usernames: updated,
          });

          helperFunction({ type: "updatedNames", props: updated });
        }
      }
    }
  });
});

ws.on("close", () => {
  console.log("WebSocket connection closed");
});

server.listen(Number(process.env.PORT), () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
