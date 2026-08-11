# Deploying the game server (Render or any persistent Node host)

This server is a long-lived Express + `ws` process. It holds live WebSocket
handles and game-room state in memory and drives match phases with in-process
timers, so it needs an always-on instance — it cannot run on serverless
platforms (Vercel functions, Lambda) as written.

---

## Why production is currently returning 500

Every DynamoDB-backed endpoint (`/getActiveRooms`, `/lobbies`, `/leaderboard`,
…) fails with:

```
CredentialsProviderError: Could not load credentials from any providers
```

Neither AWS client in this repo passes credentials explicitly:

- `src/server/middleware/database_conn/dynamodb/connection.ts` → `new DynamoDBClient({ region: "eu-west-3" })`
- `src/server/apis/avatars.ts` → `new S3({ region: "eu-west-3" })`

Both therefore use the AWS SDK **default credential provider chain**:

1. environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, …)
2. the shared credentials file (`~/.aws/credentials`)
3. EC2/ECS instance metadata (an attached IAM role)

On a developer machine step 2 resolves, which is why everything works locally.
On Render there is no `~/.aws` file and no attached AWS role, so the chain
resolves to nothing and every AWS call throws. Reproduce it locally with:

```bash
env AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null \
    AWS_EC2_METADATA_DISABLED=true AWS_ACCESS_KEY_ID= AWS_SECRET_ACCESS_KEY= \
    PORT=3066 node build/server/app.js
```

…then `curl localhost:3066/leaderboard` returns the identical 500 body as
production.

**Render cannot assume an AWS IAM role**, so the fix is a scoped IAM user whose
access key is set as an environment variable. Prefer the least-privilege policy
below over an admin key.

---

## Step 1 — create a least-privilege IAM policy

IAM → Policies → Create policy → JSON. Name it `ipak-se-okrece-backend`.

Account `637423486388`, region `eu-west-3`. The `Players` table is deliberately
absent: it is legacy, empty, and no longer referenced by any code.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "GameTables",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies",
        "arn:aws:dynamodb:eu-west-3:637423486388:table/Questions",
        "arn:aws:dynamodb:eu-west-3:637423486388:table/Wallets",
        "arn:aws:dynamodb:eu-west-3:637423486388:table/Matches"
      ]
    },
    {
      "Sid": "LobbyIndexes",
      "Effect": "Allow",
      "Action": ["dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies/index/code-index",
        "arn:aws:dynamodb:eu-west-3:637423486388:table/Lobbies/index/admin-index"
      ]
    },
    {
      "Sid": "AvatarObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::ipak-se-okrece-avatars/avatars/*"
    }
  ]
}
```

Why exactly these: the code issues `GetItem`, `PutItem`, `UpdateItem`,
`DeleteItem`, `Query` and `Scan` against those four tables; `queryByKey()`
queries `code-index` and `admin-index` on `Lobbies` (a `Query` on an index
needs permission on the *index* ARN, not just the table); and `avatars.ts`
does `putObject`/`getObject` under the `avatars/` prefix only.

## Step 2 — create the IAM user and key

1. IAM → Users → Create user, e.g. `ipak-se-okrece-render`.
2. **Do not** grant console access.
3. Attach the `ipak-se-okrece-backend` policy directly.
4. Security credentials → Create access key → choose *Application running
   outside AWS*. Copy the key ID and secret (the secret is shown once).

## Step 3 — set the environment variables on Render

Render dashboard → your service → Environment:

| Key | Value |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | the new key id |
| `AWS_SECRET_ACCESS_KEY` | the new secret |
| `AWS_REGION` | `eu-west-3` |
| `FRONTEND_ORIGIN` | `https://<your-vercel-domain>` (no trailing slash) — CORS |
| `PORT` | Render sets this automatically; do not override |
| `SESSION_SECRET` | any long random string |
| `COGNITO_USER_POOL_ID` | `eu-west-3_Uylh5ZFUK` (optional; this is the default) |
| `COGNITO_CLIENT_ID` | `3j69q67dfk60kl92gukqhdlr91` (optional; this is the default) |

`AWS_REGION` is belt-and-braces: the clients hardcode `eu-west-3`, but setting
it keeps the SDK from complaining and makes the intent explicit.

Save — Render redeploys automatically.

## Step 4 — verify

```bash
curl -s https://<your-backend-host>/leaderboard        # expect 200 + JSON
curl -s https://<your-backend-host>/lobbies            # expect 200 + JSON
curl -s https://<your-backend-host>/getActiveRooms     # expect 200

# auth is enforced: no token must be rejected, not silently accepted
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<your-backend-host>/wallet \
  -H 'Content-Type: application/json' -d '{"username":"anyone"}'   # expect 401
```

All three reads returning 200 means credentials resolved. If they still 500,
check the Render logs for `CredentialsProviderError` (key not picked up) versus
`AccessDeniedException` (key works but the policy is missing an action or
resource — the message names both).

## Rotation

Access keys are long-lived secrets. Rotate by creating a second key, updating
Render, confirming green, then deleting the old key. Never commit a key to the
repo; `.env` is gitignored for this reason.
