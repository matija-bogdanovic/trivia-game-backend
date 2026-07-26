import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { readFileSync } from "fs";
import { docClient } from "../app.js";
import { GameQuestion, GuessQuestion } from "./types.js";

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let mathCounter = 0;

/** generated arithmetic question: harder tiers get harder forms */
export function generateMathQuestion(difficulty: number): GameQuestion {
  let text: string;
  let answer: number;

  if (difficulty <= 1) {
    const a = randInt(3, 60);
    const b = randInt(2, 40);
    if (Math.random() < 0.5) {
      text = `${a} + ${b} = ?`;
      answer = a + b;
    } else {
      const [hi, lo] = a >= b ? [a, b] : [b, a];
      text = `${hi} - ${lo} = ?`;
      answer = hi - lo;
    }
  } else if (difficulty === 2) {
    if (Math.random() < 0.5) {
      const a = randInt(3, 12);
      const b = randInt(3, 12);
      text = `${a} × ${b} = ?`;
      answer = a * b;
    } else {
      const b = randInt(2, 12);
      const q = randInt(2, 12);
      text = `${b * q} ÷ ${b} = ?`;
      answer = q;
    }
  } else {
    const form = randInt(0, 2);
    const a = randInt(2, 9);
    const b = randInt(2, 9);
    const c = randInt(2, 9);
    if (form === 0) {
      text = `${a} + ${b} × ${c} = ?`;
      answer = a + b * c;
    } else if (form === 1) {
      text = `(${a} + ${b}) × ${c} = ?`;
      answer = (a + b) * c;
    } else {
      const x = randInt(2, 12);
      text = `${a}x + ${b} = ${a * x + b}, x = ?`;
      answer = x;
    }
  }

  // distractors close enough to be tempting
  const options = new Set<number>([answer]);
  while (options.size < 4) {
    const spread = Math.max(2, Math.round(Math.abs(answer) / 5));
    const candidate =
      answer + (Math.random() < 0.5 ? -1 : 1) * randInt(1, spread + 2);
    if (candidate !== answer && candidate >= 0) options.add(candidate);
  }
  return {
    id: `math-${++mathCounter}`,
    text,
    options: shuffle([...options].map(String)),
    answer: String(answer),
    difficulty: Math.min(3, Math.max(1, difficulty)),
  };
}

const GUESS_QUESTIONS: GuessQuestion[] = [
  { text: "In what year did World War II end?", value: 1945 },
  { text: "In what year did the Titanic sink?", value: 1912 },
  { text: "In what year did humans first land on the Moon?", value: 1969 },
  { text: "In what year did the Berlin Wall fall?", value: 1989 },
  { text: "How tall is Mount Everest, in meters?", value: 8849 },
  { text: "In what year was the first iPhone released?", value: 2007 },
  { text: "How many bones does an adult human body have?", value: 206 },
  { text: "In what year did the French Revolution begin?", value: 1789 },
  { text: "How long is the Danube river, in kilometers?", value: 2850 },
  { text: "In what year was Nikola Tesla born?", value: 1856 },
  { text: "How many chemical elements are in the periodic table?", value: 118 },
  { text: "In what year was the Eiffel Tower completed?", value: 1889 },
];

export function drawGuessQuestion(): GuessQuestion {
  return GUESS_QUESTIONS[randInt(0, GUESS_QUESTIONS.length - 1)];
}

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
  const difficulty = Number(raw.difficulty);
  return {
    id: String(raw.question_id ?? fallbackId),
    text: raw.question_text,
    options,
    answer,
    difficulty: difficulty >= 1 && difficulty <= 3 ? Math.round(difficulty) : 1,
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

/**
 * Serves questions in escalating difficulty: the deeper the chain, the higher
 * the requested tier. Falls back to easier tiers when a tier runs dry, and
 * reshuffles used questions when everything has been asked.
 */
export class QuestionDeck {
  private fresh: GameQuestion[];
  private used: GameQuestion[] = [];

  constructor(questions: GameQuestion[]) {
    this.fresh = shuffle(questions);
  }

  draw(targetDifficulty: number): GameQuestion {
    if (this.fresh.length === 0) {
      this.fresh = shuffle(this.used);
      this.used = [];
    }
    const want = Math.min(3, Math.max(1, targetDifficulty));
    // prefer the wanted tier, then the closest easier one, then anything
    const pick =
      this.fresh.find((q) => q.difficulty === want) ??
      this.fresh.find((q) => q.difficulty === want - 1) ??
      this.fresh[0];
    this.fresh = this.fresh.filter((q) => q !== pick);
    this.used.push(pick);
    return pick;
  }
}
