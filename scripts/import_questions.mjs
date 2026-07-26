// Imports trivia questions from the free Open Trivia DB (opentdb.com) into
// the Questions table, tagged with difficulty (easy=1, medium=2, hard=3) so
// the in-game difficulty ramp works. Usage:
//   node scripts/import_questions.mjs [amount]
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: 'eu-west-3' });
const doc = DynamoDBDocumentClient.from(client);

const amount = Math.min(50, Number(process.argv[2]) || 50);
// encode=url3986 -> everything percent-encoded, so decodeURIComponent gives
// clean text without an HTML-entity table
const res = await fetch(
  `https://opentdb.com/api.php?amount=${amount}&type=multiple&encode=url3986`
);
const data = await res.json();
if (data.response_code !== 0) {
  console.error('OpenTDB error, response_code:', data.response_code);
  process.exit(1);
}

const difficultyMap = { easy: 1, medium: 2, hard: 3 };
const now = Date.now();
const items = data.results.map((q, i) => {
  const answer = decodeURIComponent(q.correct_answer);
  const options = [
    answer,
    ...q.incorrect_answers.map((a) => decodeURIComponent(a)),
  ].sort(() => Math.random() - 0.5);
  return {
    question_id: `otdb-${now}-${i}`,
    question_text: decodeURIComponent(q.question),
    question_options: options,
    answer,
    difficulty: difficultyMap[q.difficulty] ?? 1,
    category: decodeURIComponent(q.category),
    source: 'opentdb',
  };
});

// BatchWrite in chunks of 25 (DynamoDB limit)
for (let i = 0; i < items.length; i += 25) {
  const chunk = items.slice(i, i + 25);
  await doc.send(
    new BatchWriteCommand({
      RequestItems: {
        Questions: chunk.map((Item) => ({ PutRequest: { Item } })),
      },
    })
  );
}
const byDiff = items.reduce((acc, q) => {
  acc[q.difficulty] = (acc[q.difficulty] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `Imported ${items.length} questions (difficulty 1/2/3: ${byDiff[1] ?? 0}/${byDiff[2] ?? 0}/${byDiff[3] ?? 0})`
);
