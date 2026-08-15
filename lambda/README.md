# Paste-ready Lambda handlers

Every HTTP route of the trivia backend, one self-contained file per route.
**No dependencies to install and no layer** — each file imports only AWS SDK v3
(which ships in the Node.js 18/20/22/24 Lambda runtime) and Node built-ins
(`node:crypto`, global `fetch`).

Run them either as **one Lambda** behind `index.mjs`, a router over a single
`ANY /{proxy+}` route (§2b — the current deployment), or as **sixteen Lambdas**,
each file pasted into its own function (§2c).

The real-time WebSocket game is **not** here — see
[`docs/websocket-game-later.md`](../docs/websocket-game-later.md).

---

## 1. Inventory: every route in the Express app

21 HTTP routes exist (17 on the API router, 4 auth routes on `app.ts`).
**14 are ported here.**

### Paste-ready, behaviour identical to Express (10)

| File | Route | Auth | Reads/writes |
| --- | --- | --- | --- |
| `avatarUpload.mjs` | `POST /avatar` | yes | S3 + `Wallets` |
| `avatarServe.mjs` | `GET /avatar/img/{username}` | no | S3 |
| `wallet.mjs` | `POST /wallet` | yes | `Wallets` |
| `shopBuy.mjs` | `POST /shop/buy` | yes | `Wallets` |
| `friendsAction.mjs` | `POST /friends/action` | yes | `Wallets` |
| `matchDetail.mjs` | `POST /matches/detail` | yes | `Matches` |
| `leaderboard.mjs` | `GET /leaderboard` | no | `Wallets` (Scan) |
| `leaveRoom.mjs` | `POST /leaveRoom` | yes | `Lobbies` |
| `getRoomDetails.mjs` | `POST /getRoomDetails` | no | `Lobbies` |
| `createRoom.mjs` | `POST /createRoom` | yes | `Lobbies` + `Wallets` |

`createRoom.mjs` is identical *except* for private-room password hashing — see
[the bcrypt section](#4-bcrypt-the-one-real-incompatibility).

### Ported but DEGRADED — they need live game state a Lambda cannot see (4)

The game server keeps its rooms, players and phases in memory. Four "REST"
routes read that memory, so in Lambda those specific fields go blank. Each file
says so loudly in its header.

| File | Route | What degrades |
| --- | --- | --- |
| `lobbies.mjs` | `GET /lobbies` | `playerCount` always 0, `phase` always `"lobby"`, `isLive` always false. Knock-on: a lobby is listed only if it was created in the last hour — a busy older lobby disappears. |
| `getActiveRooms.mjs` | `GET /getActiveRooms` | Counts the same degraded list. |
| `friendsList.mjs` | `POST /friends/list` | `online` always false. Everything else exact. |
| `myActiveRoom.mjs` | `POST /myActiveRoom` | **Always returns `{room: null}`.** The only route with no database behind it at all — the reconnect prompt simply never appears. |

`joinRoom.mjs` is a mild case: Express checks the live seat count first and
falls back to the stored roster; Lambda only has the stored roster.

### NOT ported, and why (7)

| Route | Why not |
| --- | --- |
| `GET /getusernames` | The handler is an **empty function** — it sends no response, so the request hangs until the client times out. Nothing to port. Delete the route. |
| `POST /getRoomCode` | Ported as `getRoomCode.mjs`, but **broken upstream, twice**: (1) the `Lobbies` table has no `admin-index` — checked against the live table, the only GSI is `code-index` — so the Query raises `ResourceNotFoundException` and the route answers **500**; (2) even with that index, `createRoom` never writes an `admin` attribute (the owner is `players[0].role === "Admin"`), so it would match nothing and answer 404. Included so the port is complete; the file explains the fix. No frontend code calls it — consider deleting the route. |
| `GET /auth/login`, `GET /auth/callback`, `GET /auth/me`, `POST /auth/logout` | Dead. They implement a **server-side OIDC session flow** with `express-session` + `openid-client`, storing the user in a cookie session. The frontend does not use them — it authenticates client-side with Amplify (`fetchAuthSession`) and sends a Bearer token. Porting them would mean bundling `openid-client` *and* adding a shared session store (DynamoDB/ElastiCache) to replace in-process sessions, to rebuild something already done client-side. Recommendation: **delete them** from the Express app rather than port them. |
| `find_room_code.ts` | Dead file — not wired to any route. |

---

## 2. Deploying — pick ONE layout

Two ways to run these, and they are mutually exclusive:

- **[§2b One function + router](#2b-one-function--router-current-deployment)** —
  one Lambda, one `ANY /{proxy+}` API Gateway resource, `index.mjs` dispatching
  to the 16 handlers. **This is what is currently deployed.** Fewest moving
  parts; a zip upload rather than a console paste.
- **[§2c Sixteen functions](#2c-sixteen-functions-paste-per-function)** — one
  Lambda per route, each file pasted as `index.mjs`, 16 API Gateway routes.
  True paste-and-go, per-function metrics and throttles.

Both use the same handler files and the same shared role from
[§2a](#2a-one-shared-execution-role). Read §2a first either way.

## 2a. One shared execution role

Create **one** role and give it to all 16 functions. Do this once, before
creating the first function.

1. IAM → Roles → **Create role**
2. Trusted entity type **AWS service** → Use case **Lambda** → Next
3. Skip attaching managed policies (the inline policy below covers logging too)
   → Next
4. Name it `ipak-se-okrece-lambda` → Create role
5. Open the role → Permissions → **Add permissions → Create inline policy** →
   the **JSON** tab → paste the whole of [`iam-policy.json`](./iam-policy.json)
   → Next → name it `ipak-se-okrece-lambda-policy` → Create policy

Then for every function: Configuration → Permissions → Edit → Execution role →
**Use an existing role** → `ipak-se-okrece-lambda`.

> If you prefer, you can instead attach the AWS-managed
> **`AWSLambdaBasicExecutionRole`** and delete the two `CloudWatchLog*`
> statements from the JSON — they do the same job. Attaching both is also fine,
> just redundant. The inline policy is written to be self-sufficient so the
> role works with nothing else attached.

### What the policy grants, and why

This is the exact union of what all 16 handlers call — 10 actions, no
wildcards, every statement scoped to a specific ARN.

| Statement | Actions | Resource | Used by |
| --- | --- | --- | --- |
| `CloudWatchLogGroup` / `CloudWatchLogStreams` | `logs:CreateLogGroup`, `CreateLogStream`, `PutLogEvents` | `/aws/lambda/*` log groups | all 16 (`console.error`) |
| `AvatarObjects` | `s3:GetObject`, `s3:PutObject` | `arn:aws:s3:::ipak-se-okrece-avatars/avatars/*` | avatarServe (Get), avatarUpload (Put) |
| `AvatarMissingKeyReturns404` | `s3:ListBucket` | `arn:aws:s3:::ipak-se-okrece-avatars` (the bucket) | avatarServe — see the note below |
| `WalletsTable` | `dynamodb:GetItem`, `PutItem`, `UpdateItem`, `Scan` | `…:table/Wallets` | wallet, shopBuy, friendsList, friendsAction, createRoom (Get/Put); avatarUpload (Put/Update); leaderboard (Scan) |
| `LobbiesTable` | `dynamodb:PutItem`, `UpdateItem`, `Scan` | `…:table/Lobbies` | createRoom (Put); joinRoom, leaveRoom (Update); lobbies, getActiveRooms (Scan) |
| `LobbiesIndexes` | `dynamodb:Query` | `…:table/Lobbies/index/code-index` and `…/admin-index` | getRoomDetails, joinRoom, leaveRoom (code-index); getRoomCode (admin-index) |
| `MatchesTable` | `dynamodb:GetItem` | `…:table/Matches` | matchDetail |

`s3:ListBucket` is granted on the **bucket** even though no handler ever lists
anything, because S3 decides what a `GetObject` on a *missing* key returns based
on it: with `ListBucket` you get `NoSuchKey` (404), which `avatarServe` maps to
a clean 404; without it S3 answers `AccessDenied` (403) instead, so as not to
reveal whether the object exists, and the handler surfaces that as a 500. An
earlier version of this file claimed the opposite and omitted the permission —
that was wrong, and it made every missing avatar a 500 on the live API.

Deliberately **absent**:

- **`dynamodb:DeleteItem`** — no handler deletes anything. (The Express server's
  policy in [`render-deployment.md`](../docs/render-deployment.md) has it; these
  Lambdas don't need it.)
- **`dynamodb:GetItem` on `Lobbies`** — no handler does a keyed get on a lobby;
  they all go through `code-index`.
- **`dynamodb:Query` on the `Lobbies` *table* ARN** — a GSI query is authorised
  against the *index* ARN only, so the table ARN would be dead weight.

`myActiveRoom` needs nothing but logs; it touches no AWS resource at all.

### ⚠ Two things to keep consistent

**1. Table and bucket names are env-driven.** The ARNs above are hard-coded to
the code's defaults. If you set `WALLETS_TABLE`, `LOBBIES_TABLE`,
`MATCHES_TABLE` or `AVATAR_BUCKET` to anything other than `Wallets`, `Lobbies`,
`Matches`, `ipak-se-okrece-avatars`, **you must edit the matching ARN in
`iam-policy.json`** or every call fails with `AccessDeniedException`. Simplest
path: leave those four unset and let the defaults apply.

**2. The policy is region- and account-pinned** to `eu-west-3` /
`637423486388`. Create the functions in `eu-west-3` — the same region as the
tables, the bucket and the Cognito pool.

**Note on `admin-index`:** it is in the policy for completeness, but **that
index does not currently exist** on the `Lobbies` table (checked against the
live table — the only GSI is `code-index`). `getRoomCode` therefore fails with
`ResourceNotFoundException` regardless of permissions; see the inventory above.
Granting `Query` on an ARN that doesn't exist is harmless, and means permissions
won't be the blocker if the index is ever created. You can drop that one ARN if
you don't deploy `getRoomCode`.

### The tradeoff

One shared role means every function carries the union: `leaderboard` could
technically write to `Lobbies`, `avatarServe` could read `Matches`. At this
scale — one app, one account, 16 functions you wrote — that is a fine trade for
not maintaining 16 policies. The stricter alternative is a role per function
using the policy block printed in each file's header, which is 16 roles and 16
policies to keep in sync. If a function is ever exposed to untrusted input in a
new way, split that one out rather than tightening all of them.

Each file still documents its own minimal permissions in its header, so
splitting later is copy-and-paste.

## 2b. One function + router (current deployment)

One Lambda serves every route; `index.mjs` dispatches on method + path. This is
the layout currently deployed as the `ipakseokrece` function.

### Upload the code

The console cannot paste 17 files, so this layout is a zip upload. The zip's
**root** must contain `index.mjs` plus all 16 handler files, with no wrapping
folder — `zip -j` flattens for exactly that reason:

```bash
cd /Users/matijabogdanovic/trivia-game-backend/lambda
zip -j ../ipakseokrece-lambda.zip *.mjs      # 17 files at the zip root
```

Lambda console → the function → **Code → Upload from → .zip file** → select it
→ Save. Then under Runtime settings confirm:

| Setting | Value |
| --- | --- |
| Handler | `index.handler` |
| Runtime | Node.js 22.x or 24.x |
| Timeout | **15 s** (3 s is too tight for a cold start plus the first JWKS fetch) |
| Memory | **512 MB** |

Environment variables: set the **union** of every handler's needs on this one
function — see [the table below](#environment-variables-at-a-glance).

### Collapse API Gateway to one route

Replace the 16 separately wired resources with a single catch-all:

1. Resources → **Create Resource** → tick **Configure as proxy resource**
   (path `{proxy+}`) → Create.
2. It creates an **ANY** method. Integration type **Lambda Function** →
   **⚠ tick "Use Lambda Proxy integration"** → function `ipakseokrece` → Save.
3. Delete the 16 old resources (`/avatar`, `/wallet`, …) so nothing shadows the
   catch-all.
4. API settings → **Binary media types** → add the wildcard `*/*` (needed by
   `GET /avatar/img/{username}`; see [the binary route](#the-one-binary-route)).
5. **Actions → Deploy API** → stage `prod`. Nothing takes effect until you
   deploy.

> **"Use Lambda Proxy integration" is not optional.** The integration type is
> currently `AWS` (non-proxy), which is why a crashing function came back as
> HTTP **200** carrying the raw error JSON: non-proxy hands the function's
> return value through as the response *body* and ignores `statusCode` and
> `headers` completely. Under non-proxy the handlers also never receive
> `event.headers`, `event.body` or `pathParameters`, so auth and CORS cannot
> work at all. Tick the box.

`ANY /{proxy+}` also delivers `OPTIONS` to the function, which is what makes
the CORS preflight work — `index.mjs` answers it directly with 204.

`/getRoomCode` is deliberately not in the router's table and falls through to
404; see the inventory above for why it cannot work.

### Trade-off vs sixteen functions

One function means one set of CloudWatch logs and one concurrency pool for
every route — a burst of avatar uploads can throttle the leaderboard, and you
cannot tune memory or timeout per route. Against that: one thing to deploy, one
route to wire, one place to set env vars. At this scale that is the better
trade; splitting later is just uploading the same files to more functions.

## 2c. Sixteen functions (paste per function)

Repeat per file. In the Lambda console:

1. **Create function** → Author from scratch → Runtime **Node.js 22.x** →
   Architecture `arm64`.
2. Name it after the file (`wallet`, `createRoom`, …).
3. The default code file is **`index.mjs`** — keep that name. Paste the file
   over it, **Deploy**. (Renaming it to `index.js` breaks `export const
   handler` with `Cannot use import statement outside a module`.)
4. Configuration → General → **Timeout 15s, Memory 512 MB**.
5. Configuration → Environment variables — from the file's own header block.
6. Configuration → Permissions → Execution role → **Use an existing role** →
   pick the one shared role from [§2a](#2a-one-shared-execution-role). Create
   that role once, before the first function.
7. **Add trigger → API Gateway → HTTP API → Security: Open**, then edit the
   route so the path and method match the table above exactly.

> Leave every route **Open** in API Gateway. The handlers verify the Cognito
> token themselves and return their own 401. Adding a JWT authorizer on top
> would also work but is redundant.

### Environment variables at a glance

| Variable | Value | Needed by |
| --- | --- | --- |
| `ALLOWED_ORIGIN` | `https://<your-vercel-domain>,http://localhost:3000` | all |
| `COGNITO_USER_POOL_ID` | `eu-west-3_Uylh5ZFUK` | the 11 authed ones |
| `COGNITO_CLIENT_ID` | `3j69q67dfk60kl92gukqhdlr91` | the 11 authed ones |
| `WALLETS_TABLE` | `Wallets` | wallet, shopBuy, friends*, createRoom, avatarUpload |
| `LOBBIES_TABLE` | `Lobbies` | lobbies, getActiveRooms, create/join/leaveRoom, getRoom* |
| `MATCHES_TABLE` | `Matches` | matchDetail |
| `AVATAR_BUCKET` | `ipak-se-okrece-avatars` | avatarUpload, avatarServe |

**Do not set `AWS_REGION`** — it is reserved, Lambda sets it, and the console
refuses to save it. Every variable has a working default compiled in, so a bare
paste runs; setting them is still correct.

### CORS — pick one, never both

The handlers emit CORS headers themselves from `ALLOWED_ORIGIN` and answer the
`OPTIONS` preflight, so a bare paste works with no API Gateway CORS config.
If you *also* enable CORS in the API Gateway console you get duplicate
`Access-Control-Allow-Origin` headers and the browser rejects the response.
Either leave API Gateway CORS off (recommended) or turn it on and set
`ALLOWED_ORIGIN` to an empty string.

### The one binary route

`avatarServe.mjs` returns the image with `isBase64Encoded: true`. An **HTTP API**
decodes that to raw bytes automatically — nothing to configure. On a **REST
API** you must add `*/*` to Binary media types and redeploy the stage, or the
browser gets a base64 string labelled `image/jpeg`: broken image, 200 status,
nothing in the logs. Use the wildcard, not `image/jpeg` — REST APIs only decode
when the *client's* `Accept` header matches, and browsers send
`image/avif,image/webp,*/*` for `<img>` tags.

---

## 3. Auth: verified locally, not via `/oauth2/userInfo`

**Which I used: local JWT verification with `node:crypto` against the pool's
JWKS.** Not `/oauth2/userInfo`. This was a deliberate reversal of the original
instruction, for one blocking reason:

`userInfo` **requires the access token to carry the `openid` scope.** This app
has two sign-in paths:

- `signInWithRedirect({ provider: 'Google' })` → Hosted UI → token **has**
  `openid`.
- `signIn({ username, password })` → Amplify SRP / `InitiateAuth` → token
  carries `aws.cognito.signin.user.admin` and **no `openid`**.

`userInfo` answers the second kind with `403 invalid_token`. Every
email/password login would have broken while Google logins kept working — the
worst possible failure shape to debug. (Scopes confirmed in the frontend's
`src/app/lib/amplify_configure.ts` and `(auth)/login/page.tsx`.)

Local verification is also strictly better here: it needs no scope, adds **no
network call per request** (the JWKS is cached for the container's life, where
userInfo would add a round trip to every call), and checks more than userInfo
does — RS256 signature, `iss`, `exp`, `token_use` (an id token is rejected
where an access token is required) and `client_id` (a token minted by another
app client in the same pool is rejected). That is the same set
`aws-jwt-verify` checks in `src/server/middleware/auth.ts`.

### Why you can trust the hand-rolled part

The concern about hand-rolling JWT verification is fair, so it is mitigated
three ways:

1. **One implementation, not twelve.** All 11 authed handlers embed a
   *byte-identical* copy of the block (verified by hashing the region between
   `let jwksCache` and the end of `bearerFrom` in every file). There is one
   thing to audit.
2. **Tested against forgeries.** Signed with a foreign key, tampered
   signature, `alg: none`, unknown `kid`, an id token, wrong `client_id`,
   wrong issuer, expired, missing `exp`, garbage, empty — all rejected 401. The
   suite also asserts that *all 11* handlers 401 on a tampered signature, and
   that a body claiming `username: "victim"` still resolves to the token's
   subject. 83 assertions total, all passing.
3. **A consolidation path.** If you would rather have exactly one place where
   auth happens, make a single **Lambda REQUEST authorizer** containing that
   block, attach it to every protected route, and have each handler read
   `event.requestContext.authorizer.lambda.username`. That is a mechanical
   change and a good cleanup once the routes are live — it just needs more
   console wiring than "paste and go", which is why it is not the default here.

If you still prefer `userInfo`, the only safe way is to first add the `openid`
scope to the SRP login path — which is a frontend/Cognito change, not a
backend one.

---

## 4. bcrypt: the one real incompatibility

`createRoom` and `joinRoom` hash private-room passwords with **`bcrypt`, a
native module**. Native modules cannot be pasted into the console — they need a
compiled binary in a zip or layer built for the function's architecture. To
keep the paste-and-go promise, both handlers use **scrypt from `node:crypto`**
instead (format `scrypt$N$r$p$salt$hash`).

**Consequence you must decide about:** the two hash formats are mutually
unreadable.

- A private room created by **Express** has a bcrypt hash these Lambdas cannot
  verify. `joinRoom.mjs` detects it, logs it, and answers
  `500 {"message":"legacy_password_hash"}` rather than pretending the password
  was wrong.
- A private room created by **Lambda** has a scrypt hash Express cannot verify.

Options: **(a)** move private rooms to Lambda in one cut and let existing ones
expire; **(b)** keep `createRoom`/`joinRoom` on Express and move the other 12
routes; **(c)** put bcrypt in a Lambda layer for those two functions, giving up
console-pasting for them. **Public rooms are unaffected** — they have no
password at all.

---

## 5. Known issues carried over unchanged

These are pre-existing Express behaviours, ported as-is so the move is a port
and not a silent rewrite. Each is noted in the relevant file.

- **`getRoomDetails` returns the raw lobby item**, including `passwordHash` for
  a private room. Worth fixing (project only the fields you need), but it would
  be a contract change.
- **`leaderboard` and `lobbies` Scan without pagination.** A Scan reads at most
  1 MB; past that the leaderboard silently considers only the first page.
- **`getRoomCode` cannot work** — the `admin-index` it queries does not exist on
  the `Lobbies` table, and the `admin` attribute it filters on is never written
  (see the inventory above). This is true of the Express route too, not just
  the port.
- One fix *was* applied: `queryByKey` in `src/server/helpers/query_db.ts` builds
  its placeholder name out of the *value* (`code = :123`), which throws a
  `ValidationException` as soon as the value contains a `.`, `-` or space — any
  username that isn't plain alphanumeric. The Lambda copies use a constant
  `:val`. Behaviour is otherwise identical.

---

## 6. Pointing the frontend at the API

The frontend builds every URL from one `getPort()` base
(`trivia-game-frontend/src/app/helpers/port.ts`). These routes on API Gateway
sit on a different host from the Express server, and the WebSocket game still
needs Express. So:

- **(a)** Move only some routes and give the frontend a second base URL for
  them.
- **(b)** Put a CloudFront distribution (or any reverse proxy) in front:
  `/avatar*`, `/wallet`, … → API Gateway, everything else + the WebSocket
  upgrade → Render. `getPort()` keeps returning one base and no frontend code
  changes. **This is the clean end state.**

Both implementations read and write the same tables and keys, so Express and
Lambda can run side by side for every route except private-room passwords.

The frontend currently calls exactly ten endpoints: `/avatar`,
`/avatar/img/:username`, `/createRoom`, `/joinRoom`, `/leaveRoom`, `/lobbies`,
`/wallet`, `/myActiveRoom`, `/friends/list`, `/friends/action`. The other four
ported files (`leaderboard`, `shopBuy`, `matchDetail`, `getRoomDetails`) are
live routes with no current caller.

---

## 7. Verify after deploying

```bash
API=https://<your-api-id>.execute-api.eu-west-3.amazonaws.com

# auth is enforced, not decorative
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/wallet" \
  -H 'Content-Type: application/json' -d '{}'                     # expect 401

# a real call (grab an access token from the app's devtools)
curl -s -X POST "$API/wallet" -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | head -c 200       # expect JSON

curl -s "$API/lobbies"                                            # expect 200
curl -s "$API/leaderboard"                                        # expect 200

# the image must come back as BYTES, not a base64 string
curl -s "$API/avatar/img/<username>?v=1" -o /tmp/a.jpg
file /tmp/a.jpg                                          # expect JPEG image data

# preflight from the app origin
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$API/wallet" \
  -H 'Origin: https://<your-vercel-domain>' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'  # expect 204
```

Failure modes worth recognising in CloudWatch: `401` with a valid token means
`COGNITO_CLIENT_ID`/`COGNITO_USER_POOL_ID` disagree with the pool the frontend
uses, or the JWKS fetch failed (the handler logs it); `AccessDeniedException`
means the inline policy is missing an action or names the wrong resource — the
message says which; `ResourceNotFoundException` means the table is in another
region than the function.
