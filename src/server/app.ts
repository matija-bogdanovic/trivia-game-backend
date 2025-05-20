import {
  attachWSServer,
  client,
  server,
  ws,
} from "./middleware/connections.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { helperFunction } from "./apis/websocket_functions.js";
import "dotenv/config";
import cookieParser from "cookie-parser";
import { getUsernames } from "./apis/get_usernames.js";
import { pressedCircle } from "./apis/pressed_circle.js";
import { startGame } from "./apis/start_game.js";
import { registerUser } from "./apis/login.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cookieParser());
attachWSServer();
await client.connect();
app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
server.on("request", app);

app.use(express.static(path.join(__dirname, "../../public")));

// POST operations
app.post("/login", registerUser);
app.post("/pressedCircle", pressedCircle);
app.post("/startGame", startGame);

// GET operations
app.get("/", (_, res: Response) => {
  res.sendFile(path.join(__dirname, "../../public/index.html"));
});
app.get("/game", (_, res) => {
  res.sendFile(path.join(__dirname, "../../public/game.html"));
});
app.get("/endscreen", (_, res) => {
  res.sendFile(path.join(__dirname, "../../public/endscreen.html"));
});
app.get("/getusernames", getUsernames);
app.get("/getGameState", async (_: Request, res: Response) => {
  const dbData = (await client.get("gameStatus")) as string;
  res.json({ gameState: dbData });
});
app.get("/getGameRounds", async (req: Request, res: Response) => {});
app.get("/playerNum", async (req: Request, res: Response) => {
  const usernames = (await client.json.get("usernames:usernames")) as string;
  const parsedUsernames = JSON.parse(usernames);

  res.json(parsedUsernames);
});

server.listen(Number(process.env.PORT));

ws.on("connection", async (wss, req) => {
  const isGameConnection: boolean = req.url === "/game";
  const isEndscreenConnection: boolean = req.url === "/endscreen";

  if (isGameConnection) {
    const usernames = (await client.json.get("usernames:usernames")) as string;
    const parsedUsernames = JSON.parse(usernames)["usernames"];
    helperFunction({ type: "updatedNames", props: parsedUsernames });
  }

  wss.on("message", async (event: string) => {
    if (isGameConnection) {
      const message = JSON.parse(event);
      const getRounds = (await client.json.get("rounds")) as any;
      const parsed = JSON.parse(getRounds);
      const randomNumber = Math.floor(Math.random() * (10000 - 2 + 1)) + 2;
      const getGameStatus = (await client.get("gameStatus")) as string;

      if (message?.gameStarted) {
        helperFunction({ started: true });
        return;
      }
      if (
        message?.gameRound === "getGameRound" ||
        message?.roundEnded === true
      ) {
        if (parsed["First Round"]["state"] === "started") {
          helperFunction({
            roundCount: "First Round",
            randomNumber: randomNumber,
            gameStarted: JSON.parse(getGameStatus),
          });
          return;
        } else if (parsed["Second Round"]["state"] === "started") {
          helperFunction({
            roundCount: "Second Round",
            randomNumber: randomNumber,
            gameStarted: JSON.parse(getGameStatus),
          });
          return;
        } else if (parsed["Third Round"]["state"] === "started") {
          helperFunction({
            roundCount: "Third Round",
            randomNumber: randomNumber,
            gameStarted: JSON.parse(getGameStatus),
          });
          return;
        } else if (parsed["Fourth Round"]["state"] === "started") {
          helperFunction({
            roundCount: "Fourth Round",
            randomNumber: randomNumber,
            gameStarted: JSON.parse(getGameStatus),
          });
          return;
        } else if (parsed["Fifth Round"]["state"] === "started") {
          helperFunction({
            roundCount: "Fifth Round",
            randomNumber: randomNumber,
            gameStarted: JSON.parse(getGameStatus),
          });
          return;
        } else if (parsed["Fifth Round"]["state"] === "finished") {
          await client.set("gameStatus", "false");
          helperFunction({
            matchEnd: true,
          });
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

        const maxHealth = Math.max(
          ...flattened.map((user: any) => user.health)
        );

        const topPlayers = flattened.filter(
          (user: any) => user.health === maxHealth
        );

        helperFunction({
          topPlayers: topPlayers.map((user: any) => user.username),
          maxHealth: maxHealth,
        });
      } else {
        helperFunction({ topPlayers: [], maxHealth: null });
      }
    }
  });
  wss.on("close", async () => {
    await client.json.get("usernames");
    console.log("someone logged out");
  });
});

ws.on("close", function closingMessage() {
  console.log("The websocket connection is closed");
});
