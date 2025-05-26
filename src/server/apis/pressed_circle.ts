import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { client } from "../middleware/database_conn/redis/connection.js";
import { helperFunction } from "./websocket_functions.js";

export async function pressedCircle(req: Request, res: Response) {
  const token = jwt.verify(req.cookies.token, `${process.env.SECRET}`) as any;

  const dbArrayOfNames = (await client.json.get("usernames:usernames", {
    path: "$..usernames[*]",
  })) as string;
  const someparsedvalue = JSON.parse(dbArrayOfNames);
  const updatedUsers = await Promise.all(
    someparsedvalue.map((user: { username: string; health: number }) => {
      if (user.username !== token.username) {
        return {
          ...user,
          health: user.health - 1,
        };
      }
      return user;
    })
  );
  await client.json.set("usernames:usernames", "$.usernames", updatedUsers);
  helperFunction({ props: updatedUsers, type: "updatedNames" });

  const roundFlow: Record<string, string | null> = {
    "First Round": "Second Round",
    "Second Round": "Third Round",
    "Third Round": "Fourth Round",
    "Fourth Round": "Fifth Round",
    "Fifth Round": null,
  };

  const currentRound = req.body.round;
  const nextRound = roundFlow[currentRound];
  const roundKey = String(currentRound);
  await client.json.set("rounds", `$["${roundKey}"]`, {
    winner: `${token.username}`,
    state: "finished",
  });
  if (nextRound) {
    const nextRoundKey = nextRound.toString();
    await client.json.set("rounds", `$["${nextRoundKey}"]`, {
      winner: "",
      state: "started",
    });

    helperFunction({
      roundCount: nextRound,
      props: updatedUsers,
      type: "updatedNames",
    });
  }
  res.json({ success: true });
}
