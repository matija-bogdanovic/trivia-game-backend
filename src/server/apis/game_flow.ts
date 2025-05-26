import { Request, Response } from "express";
import { client } from "../middleware/database_conn/redis/connection";

export async function gameFlow(res: Response, req: Request) {
  const getRounds = (await client.json.get("rounds")) as string;
  const parsedRounds = JSON.parse(getRounds);
  Array.of(parsedRounds).some((element: any) =>
    console.log(element === parsedRounds.state)
  );
  console.log(Object.values(parsedRounds)[0]);
}
