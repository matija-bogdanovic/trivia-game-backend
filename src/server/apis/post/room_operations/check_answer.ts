import { Request, Response } from "express";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../../../app.js";
import { queryByKey } from "../../../helpers/query_db.js";

export default async function submitAnswer(
  req: Request,
  res: Response
): Promise<any> {
  const { questionId, selectedOption, roomCode, username } = req.body;
  try {
    const questionsResult = await docClient.send(
      new GetCommand({
        TableName: "Questions",
        Key: {
          question_id: String(questionId),
        },
      })
    );
    const question = questionsResult.Item;

    if (!question) {
      return res.status(404).json({ message: "Question not found" });
    }

    const isCorrect = question.answer === selectedOption;

    if (isCorrect) {
      return res.status(200).json({
        status: true,
        username,
        message: "Correct!",
        correctAnswer: question.answer,
      });
    } else {
      const result = await queryByKey(
        "Lobbies",
        "code",
        Number(roomCode),
        "code-index"
      );

      const item = result[0];
      const rounds = item.rounds;
      const roundIndex = rounds.findIndex((r: any) => r.status === "started");

      if (roundIndex !== -1) {
        await docClient.send(
          new UpdateCommand({
            TableName: "Lobbies",
            Key: { lobby_id: String(item.lobby_id) },
            UpdateExpression: `SET rounds[${roundIndex}].#status = :status`,
            ExpressionAttributeNames: {
              "#status": "status",
            },
            ExpressionAttributeValues: {
              ":status": "finished",
            },
          })
        );
      } else {
        console.warn("No active round with status 'started' found.");
      }

      return res
        .status(400)
        .json({ status: false, username, correctAnswer: question.answer });
    }
  } catch (error) {
    console.error("Error checking answer:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}
