# Avatar upload/serve on Lambda

The two avatar endpoints are the only stateless things in this backend, so
they are the only ones that can move off the always-on Express host. Everything
else — live rooms, WebSocket handles, in-process match timers — still needs the
persistent process described in [render-deployment.md](./render-deployment.md).

```
POST /avatar                        UploadAvatarFunction   lambda/src/upload_avatar.ts
GET  /avatar/img/{username}?v=..    GetAvatarImageFunction lambda/src/get_avatar_image.ts
```

The contract is unchanged from the Express routes, because the frontend already
depends on it:

| | |
| --- | --- |
| Upload auth | `Authorization: Bearer <Cognito **access** token>` |
| Upload body | `{ "image": "data:image/(jpeg\|png\|webp);base64,..." }`, ≤ 700 000 chars |
| Upload 200 | `{ "avatar": "u|<epoch-ms>" }` |
| Username | read off the verified token, **never** off the body |
| Object | `s3://ipak-se-okrece-avatars/avatars/{urlencoded-username}.jpg` |
| Pointer | `Wallets.avatar = "u|<epoch-ms>"` — this is what makes the new picture appear |
| Serve headers | `Cache-Control: public, max-age=86400, immutable` |
| Serve 404 | missing object |

## What differs from `src/server/apis/avatars.ts`

Same validation regex, same size cap, same key, same pointer format. Three
deliberate changes:

1. **AWS SDK v3.** The `nodejs22.x` runtime ships v3 only; the v2 `aws-sdk`
   package the Express handler uses is not available there and bundling it
   would add ~60 MB.
2. **The wallet write is a targeted `UpdateExpression`,** not the
   `getWallet()` → mutate → `saveWallet()` round-trip. Same end state, but a
   whole-item rewrite can clobber a coin/streak write from a match finishing at
   the same moment. If the player has no wallet row yet, the conditional update
   fails and the handler creates the full default row — those defaults mirror
   `freshWallet()` in `src/server/game/wallet.ts` and must be kept in sync with
   it.
3. **Auth is inline** rather than `requireAuth` middleware, since there is no
   Express pipeline. The verifier is identical (`aws-jwt-verify`, same pool,
   same client, `tokenUse: "access"`).

## Binary responses — the API Gateway bit to get right

`template.yaml` provisions an **HTTP API** (payload format 2.0), not a REST
API. That choice matters for the image endpoint:

- On an **HTTP API**, a response with `isBase64Encoded: true` is decoded to raw
  bytes automatically. No `BinaryMediaTypes` setting exists or is needed.
- On a **REST API** (`AWS::Serverless::Api`), the same response is only decoded
  if the API's `BinaryMediaTypes` list contains a type matching the client's
  `Accept` header. Miss it and the browser receives a base64 *string* with an
  `image/jpeg` content type — a broken image, with a 200 status and nothing in
  the logs.

So: **if you ever move this to a REST API**, you must add

```yaml
  AvatarApi:
    Type: AWS::Serverless::Api
    Properties:
      BinaryMediaTypes: ["image/jpeg", "image/png", "image/webp"]
```

(or `"*/*"`, which sidesteps the `Accept`-matching rule entirely). The handler
code needs no change either way — it already sets `isBase64Encoded: true`.

## Deploying

### 0. Prerequisites

The SAM CLI is **not currently installed on this machine**:

```bash
brew install aws-sam-cli     # or: pipx install aws-sam-cli
sam --version                # expect 1.100+
```

AWS credentials are already configured (`aws sts get-caller-identity` resolves
to account `637423486388`). The region is not set in the CLI config, so pass
`--region eu-west-3` or export `AWS_REGION=eu-west-3`.

### 1. Permissions the *deploying* identity needs

This is separate from what the functions get at runtime. Deploying a SAM stack
needs CloudFormation plus the right to create the resources in it:

- `cloudformation:*` on the stack
- `lambda:*` on the two functions
- `apigateway:*` (creating the HTTP API, routes, stage)
- `iam:CreateRole`, `iam:AttachRolePolicy`, `iam:PutRolePolicy`,
  `iam:PassRole`, `iam:GetRole`, `iam:DeleteRole`, `iam:DetachRolePolicy`
  — SAM creates one execution role per function
- `s3:*` on the `aws-sam-cli-managed-default-*` artifact bucket that
  `--guided` creates on first run

The `notewriter-deploy` user that the local credentials resolve to almost
certainly does not have `iam:CreateRole`. Either attach a deploy policy with
the above, or run the deploy as an administrator principal.

### 2. Deploy

```bash
cd /Users/matijabogdanovic/trivia-game-backend
cd lambda && npm install && cd ..   # required: sam build runs esbuild from lambda/node_modules
sam build                           # bundles lambda/src/*.ts with esbuild
sam deploy --guided                 # first run only; answers saved to samconfig.toml
```

At the `--guided` prompts:

| Prompt | Answer |
| --- | --- |
| Stack Name | `ipak-se-okrece-avatars` |
| AWS Region | `eu-west-3` (must match the bucket and the Cognito pool) |
| Parameter AllowedOrigins | `https://<your-vercel-domain>,http://localhost:3000` |
| Parameter AvatarBucket | `ipak-se-okrece-avatars` (default) |
| Parameter WalletsTable | `Wallets` (default) |
| Parameter CognitoUserPoolId | `eu-west-3_Uylh5ZFUK` (default) |
| Parameter CognitoClientId | `3j69q67dfk60kl92gukqhdlr91` (default) |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | **`y`** — this is what needs the IAM permissions above |
| Disable rollback | `n` |
| Save arguments to configuration file | `y` |

Subsequent deploys are just `sam build && sam deploy`.

The stack prints `AvatarApiUrl` on success, e.g.
`https://abc123.execute-api.eu-west-3.amazonaws.com`. Because the stage is
`$default` there is no `/Prod` prefix — the paths sit at the root, exactly as
the frontend writes them.

### 3. Runtime IAM (already in the template, nothing to do by hand)

SAM attaches these to the per-function execution roles:

| Function | Permission | Resource |
| --- | --- | --- |
| Upload | `s3:PutObject` | `arn:aws:s3:::ipak-se-okrece-avatars/avatars/*` |
| Upload | `dynamodb:GetItem`, `PutItem`, `UpdateItem` | `table/Wallets` |
| Serve | `s3:GetObject` | `arn:aws:s3:::ipak-se-okrece-avatars/avatars/*` |

`s3:ListBucket` is deliberately absent. It is not needed, and without it a
`GetObject` on a key the role *can* read returns a clean `NoSuchKey` (→ 404)
when the object is missing, which is what the handler expects.

The bucket stays private — no public read, no bucket policy change. The serve
Lambda is the only reader.

### 4. CORS

Handled by the HTTP API from the `AllowedOrigins` parameter, including the
`OPTIONS` preflight the JSON upload triggers. The handlers deliberately do
**not** set `Access-Control-Allow-*` themselves — doing both produces duplicate
headers, which browsers reject.

To change the allowed origins later, redeploy with a new parameter value:

```bash
sam deploy --parameter-overrides \
  "AllowedOrigins=https://new-domain.example,http://localhost:3000"
```

Origins must have no trailing slash and must include the scheme.

### 5. Point the frontend at it

⚠️ **This is the one thing that is not just a backend deploy.** The frontend
builds every URL from a single `getPort()` base
(`trivia-game-frontend/src/app/helpers/port.ts`):

```ts
apiFetch('/avatar', { body: { image: preview } })
`${getPort()}/avatar/img/${encodeURIComponent(username)}?v=${info.version}`
```

Moving these two routes to API Gateway puts them on a *different host* from the
rest of the API. Pick one:

- **(a) Leave the frontend alone.** Keep serving `/avatar*` from Express on
  Render and treat this stack as unused/standby. Nothing breaks.
- **(b) Put both behind one domain.** A CloudFront distribution (or any
  reverse proxy) with `/avatar*` → the HTTP API and everything else → Render.
  `getPort()` keeps returning one base and no frontend code changes.
- **(c) Give the frontend a second base URL.** Add e.g.
  `NEXT_PUBLIC_AVATAR_API` and use it for those two call sites only. Smallest
  change, but it splits the base URL in two places.

(b) is the clean end state; (c) is the fastest. The request/response contract
is identical either way — only the host changes.

Once the frontend points at the Lambda routes, delete the two Express routes in
`src/server/apis/operations.ts` so there is one implementation, not two:

```ts
router.post("/avatar", requireAuth, uploadAvatarHandler);
router.get("/avatar/img/:username", getAvatarImageHandler);
```

Until then both work and write the same keys and the same pointer, so running
them side by side is safe.

### 6. Verify

```bash
API=https://<AvatarApiUrl from the stack outputs>

# unauthenticated upload must be rejected, not silently accepted
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/avatar" \
  -H 'Content-Type: application/json' -d '{"image":"x"}'          # expect 401

# a real upload (grab an access token from the app's devtools)
curl -s -X POST "$API/avatar" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"image\":\"data:image/jpeg;base64,$(base64 -i pic.jpg)\"}"
# expect {"avatar":"u|1699999999999"}

# the image must come back as BYTES, not a base64 string —
# `file` saying "JPEG image data" is the whole point of the binary check
curl -s "$API/avatar/img/<username>?v=1699999999999" -o /tmp/a.jpg -D - | \
  grep -i 'cache-control\|content-type'
file /tmp/a.jpg                                      # expect: JPEG image data
curl -s -o /dev/null -w '%{http_code}\n' "$API/avatar/img/nobody-here"   # expect 404

# preflight from the app origin
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$API/avatar" \
  -H 'Origin: https://<your-vercel-domain>' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'   # expect 204
```

If the upload returns 500, check `sam logs -n UploadAvatarFunction --stack-name
ipak-se-okrece-avatars --tail`. `AccessDenied` on `s3:PutObject` means the
bucket name parameter and the policy resource disagree;
`ResourceNotFoundException` means the `Wallets` table is in a different region
than the stack.

## Local development

```bash
cd lambda && npm install && npm run typecheck
sam local start-api --port 3067    # needs Docker
```

`sam local start-api` does *not* emulate the HTTP API's automatic base64
decoding, so the image endpoint returns a base64 string locally even though it
is correct in AWS. Verify the binary path against a deployed stage.

## Teardown

```bash
sam delete --stack-name ipak-se-okrece-avatars
```

This removes the functions, the API, and the execution roles. It does **not**
touch the S3 bucket or the `Wallets` table — neither is owned by the stack.
