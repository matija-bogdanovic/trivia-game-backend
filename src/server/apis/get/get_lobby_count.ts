import { Request, Response } from "express";
import { listActiveLobbies } from "../economy.js";

export default async function getActiveRooms(_: Request, res: Response) {
  try {
    const lobbies = await listActiveLobbies();
    res.status(200).json({ roundCount: lobbies.length });
  } catch (error) {
    console.error("Failed to get lobby count", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
}
