import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { queryByKey } from "../../../helpers/query_db.js";

export default async function logIn(req: Request, res: Response): Promise<any> {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Missing username or password" });
  }

  try {
    const users = await queryByKey("Players", "username", String(username), "username-index");

    if (!users || users.length === 0) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const user = users[0];

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const token = jwt.sign(
      {
        username: user.username,
        id: user.id,
      },
      process.env.SECRET!,
      {
        expiresIn: "48h",
      }
    );

    res.cookie("token", token, {
      sameSite: "lax",
      maxAge: 178_800_000,
      secure: true,
    });

    return res.status(200).json({
      message: "Login successful",
      user: { username: user.username, id: user.id },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
