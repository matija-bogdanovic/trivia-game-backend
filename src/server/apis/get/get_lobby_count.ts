import { Request, Response } from "express";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../app.js";

export default async function getActiveRooms(_: Request, res: Response) {
  try {
    const command = new ScanCommand({
      TableName: "Lobbies",
      Select: "COUNT", 
    });

    const result = await docClient.send(command);

    res.status(200).json({ roundCount: result.Count ?? 0 });
  } catch (error) {
    console.error("Failed to get lobby count", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
}
