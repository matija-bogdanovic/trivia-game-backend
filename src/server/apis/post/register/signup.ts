import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import { docClient } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";

export async function signUp(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> {
  try {
    const { username, mail, password } = req.body;

    if (!username || !mail || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }

    // Check username
    const existingUser = await queryByKey(
      "Players",
      "username",
      username,
      "username-index"
    );
    if (existingUser.length) {
      return res.status(409).json({ message: "Username already taken" });
    }

    // Check email
    const existingEmail = await queryByKey(
      "Players",
      "email",
      mail,
      "email-index"
    );
    if (existingEmail.length) {
      return res.status(409).json({ message: "Email already registered" });
    }

    // Create user
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    const now = new Date().toISOString();

    await docClient.send(
      new PutCommand({
        TableName: "Players",
        Item: {
          id: userId,
          username,
          email: mail,
          password: hashedPassword,
          created_at: now,
        },
      })
    );

    const token = jwt.sign({ username }, process.env.SECRET!, {
      expiresIn: "48h",
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 48 * 60 * 60 * 1000, // 48h
    });

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    console.error("Registration error:", error);
    next(error);
  }
}
