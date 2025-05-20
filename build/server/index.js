import { attachWSServer, client, server, ws, } from "./middleware/connections.js";
import express from "express";
import cors from "cors";
import { helperFunction } from "./apis/websocket_functions.js";
import "dotenv/config";
import cookieParser from "cookie-parser";
import { getUsernames } from "./apis/get_usernames.js";
import { pressedCircle } from "./apis/pressed_circle.js";
import { startGame } from "./apis/start_game.js";
import { registerUser } from "./apis/login.js";
const app = express();
app.use(cookieParser());
attachWSServer();
await client.connect();
app.use(cors({ origin: "http://localhost:5500", credentials: true }));
app.use(express.json());
server.on("request", app);
// POST operations
app.post("/login", registerUser);
app.post("/pressedCircle", pressedCircle);
app.post("/startGame", startGame);
// GET operations
app.get("/getusernames", getUsernames);
app.get("/getgamestate", async (_, res) => {
    const dbData = (await client.get("gameStatus"));
    res.json({ data: dbData });
});
server.listen(Number(process.env.PORT));
ws.on("connection", async (wss, req) => {
    const isGameConnection = req.url === "/game";
    if (isGameConnection) {
        const buttonState = await client.get("gameStatus");
        wss.send(JSON.stringify({ type: "buttonState", state: buttonState }));
    }
    wss.on("message", async (event) => {
        if (isGameConnection) {
            const message = JSON.parse(event);
            if (message === null || message === void 0 ? void 0 : message.gameStarted) {
                helperFunction({ started: true });
            }
        }
    });
    wss.on("close", async () => { });
});
ws.on("close", function closingMessage() {
    console.log("The websocket connection is closed");
});
//# sourceMappingURL=index.js.map