import { wss } from "../../../app.js";
import { broadcastMessage } from "../../../middleware/websocket/broadcast.js";
import { queryByKey } from "../../../helpers/query_db.js";
import { Request, Response } from "express";

export default async function getRandomQuestions(
  req: Request,
  res: Response
): Promise<any> {
  const { code } = req.body;
  try {
    const query = await queryByKey(
      "Lobbies",
      "code",
      Number(code),
      "code-index"
    );

    broadcastMessage(wss, query[0]);
  } catch (err) {
    console.error("WebSocket message error:", err);
    res.send(
      JSON.stringify({ type: "error", message: "Internal server error" })
    );
  }
}
