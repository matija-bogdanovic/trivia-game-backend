import { NextFunction, Request, Response } from "express";
import { client } from "../middleware/database_conn/redis/connection.js";
import jwt from "jsonwebtoken";

export async function registerUser(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> {
  try {
    const username = req.body.username?.trim();
    if (
      !username ||
      username.length < 3 ||
      username.length > 20 ||
      !/^[a-zA-Z0-9_]+$/.test(username)
    ) {
      return res.status(400).json({ error: "Invalid username format" });
    }
    const dbArrayOfNames = (await client.json.get("usernames:usernames", {
      path: "$..usernames[*]",
    })) as string;

    if (!dbArrayOfNames) {
      return res.status(500).json({ error: "Server error" });
    }

    const playerArrayUI = JSON.parse(dbArrayOfNames);

    if (
      playerArrayUI.some(
        (element: any) => element.username === req.body.username
      )
    ) {
      res.send(
        JSON.stringify({
          error: "That username already exists in the database!",
        })
      );
    } else {
      const token = jwt.sign(
        { username: req.body.username },
        `${process.env.SECRET}`,
        {
          expiresIn: "48h",
        }
      );
      await client.json.arrAppend("usernames:usernames", "$.usernames", {
        username: req.body.username,
        health: 5,
      });
      res.cookie("token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 172_800_000,
      });
      res.json({ success: true, username: req.body.username });
    }
  } catch (error) {
    next(error);
  }
}
