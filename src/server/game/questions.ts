import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "fs";
import { docClient } from "../app.js";
import { GameQuestion } from "./types.js";

/**
 * Raw question records can come from DynamoDB or questions.json and are not
 * uniform: options may be plain strings or { question_option_text } objects,
 * and some records (templates, drafts) have no answer at all.
 */
function normalize(raw: any, fallbackId: string): GameQuestion | null {
  if (!raw || typeof raw.question_text !== "string") return null;
  const rawOptions = Array.isArray(raw.question_options)
    ? raw.question_options
    : [];
  const options = rawOptions
    .map((o: any) =>
      typeof o === "string" ? o : o?.question_option_text ?? null
    )
    .filter((o: any): o is string => typeof o === "string" && o.length > 0);
  const answer = typeof raw.answer === "string" ? raw.answer : null;
  if (options.length < 2 || !answer || !options.includes(answer)) return null;
  return {
    id: String(raw.question_id ?? fallbackId),
    text: raw.question_text,
    options,
    answer,
  };
}

function loadLocalQuestions(): GameQuestion[] {
  try {
    const file = readFileSync(
      new URL("../../../questions.json", import.meta.url),
      "utf-8"
    );
    const parsed = JSON.parse(file);
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    return list
      .map((q: any, i: number) => normalize(q, `local-${i}`))
      .filter(Boolean) as GameQuestion[];
  } catch (err) {
    console.error("Failed to read local questions.json:", err);
    return [];
  }
}

export async function loadQuestions(): Promise<GameQuestion[]> {
  try {
    const res = await docClient.send(
      new ScanCommand({ TableName: "Questions" })
    );
    const questions = (res.Items ?? [])
      .map((item, i) => normalize(item, `db-${i}`))
      .filter(Boolean) as GameQuestion[];
    if (questions.length > 0) return questions;
    console.warn("Questions table is empty, falling back to questions.json");
  } catch (err) {
    console.error(
      "Failed to scan Questions table, falling back to questions.json:",
      err
    );
  }
  return loadLocalQuestions();
}

export function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
