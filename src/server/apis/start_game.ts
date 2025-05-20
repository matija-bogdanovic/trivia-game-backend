import { Request, Response } from "express";
import { client } from "../middleware/connections.js";
import { helperFunction } from "./websocket_functions.js";

export async function startGame(req: Request, res: Response) {
  if (req.body.gameStarted === true) {
    await client.set("gameStatus", "true");
    (await client.json.set("rounds", `$["First\ Round"]`, {
      winner: "",
      state: "started",
    })) as string;

    helperFunction({
      gameStarted: true,
      roundCount: "First Round",
      gameRound: "getGameRound",
    });
    return;
  }
}
