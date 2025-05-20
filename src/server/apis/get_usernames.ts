import { Request, Response } from "express";
import { client } from "../middleware/connections.js";

export async function getUsernames(_: Request, res: Response) {
  const playerArrayDB = (await client.json.get("usernames:usernames", {
    path: "$..usernames[*]",
  })) as string;

  res.json({ information: JSON.parse(playerArrayDB) });
}
