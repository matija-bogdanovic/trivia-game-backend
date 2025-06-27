import { Request, Response } from "express";
import { queryByKey } from "../../../helpers/query_db.js";

export default async function getRoomCode(
  req: Request,
  res: Response
): Promise<any> {
  try {
    const items = await queryByKey(
      "Lobbies",
      "admin",
      String(req.body.username),
      "admin-index"
    );

    if (!items || items.length === 0) {
      return res.status(404).json({ message: "Room not found" });
    }

    const room = items[0];
    const code = room.code;
    res.status(200).json({ code: code });
  } catch (error) {
    console.error("Error getting room code:", error);
    res.status(500).json({ message: "Internal server error" });
  }
}
