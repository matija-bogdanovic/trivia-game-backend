import { Request, Response } from "express";
import { queryByKey } from "../helpers/query_db.js";

/**
 * Retrieves room details by roomCode.
 */
export async function getRoomDetails(req: Request, res: Response): Promise<any> {
  const { roomCode } = req.body;

  if (!roomCode || isNaN(Number(roomCode))) {
    return res.status(400).json({ message: "Invalid or missing roomCode" });
  }

  try {
    const items = await queryByKey("Lobbies", "code", Number(roomCode), "code-index");

    if (items.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    return res.status(200).json(items[0]);
  } catch (error) {
    console.error("Error getting room details:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
