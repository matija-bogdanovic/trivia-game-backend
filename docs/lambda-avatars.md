# Avatar upload/serve as pasteable Lambdas

Two self-contained handlers, meant to be pasted straight into the AWS Lambda
console. **No dependencies to install, no zip, no layer** — everything they use
either ships in the Node.js 18/20/22 Lambda runtime (AWS SDK v3) or is built
into Node itself (`node:crypto`, global `fetch`).

| File | Function | Route |
| --- | --- | --- |
| [`lambda/avatarUpload.mjs`](../lambda/avatarUpload.mjs) | `avatarUpload` | `POST /avatar` |
| [`lambda/avatarServe.mjs`](../lambda/avatarServe.mjs) | `avatarServe` | `GET /avatar/img/{username}` |

Each file carries its own header comment listing env vars, IAM policy JSON, API
Gateway settings and CORS. This page is the walkthrough; the files are the
reference.

These are the only two stateless endpoints in the backend. Everything else —
live rooms, WebSocket handles, in-process match timers — still needs the
always-on Express host described in [render-deployment.md](./render-deployment.md).

## The contract (unchanged — the frontend already depends on it)

| | |
| --- | --- |
| Upload auth | `Authorization: Bearer <Cognito **access** token>` |
| Upload body | `{ "image": "data:image/(jpeg\|png\|webp);base64,..." }`, ≤ 700 000 chars |
| Upload 200 | `{ "avatar": "u\|<epoch-ms>" }` |
| Username | read off the verified token, **never** off the body |
| Object | `s3://ipak-se-okrece-avatars/avatars/{urlencoded-username}.jpg` |
| Pointer | `Wallets.avatar = "u\|<epoch-ms>"` — this is what makes the new picture appear |
| Serve headers | `Cache-Control: public, max-age=86400, immutable` |
| Serve 404 | no avatar for that user |

Same validation regex, same size cap, same key, same field names as
`src/server/apis/avatars.ts`.

## Auth: why the token is verified locally, not via `/oauth2/userInfo`

Calling Cognito's `/oauth2/userInfo` is the obvious no-dependency way to turn an
access token into a username, and it was the first choice here. It does not work
for this app.

`userInfo` requires the access token to carry the **`openid` scope**. This
frontend has two sign-in paths:

- `signInWithRedirect({ provider: 'Google' })` — Hosted UI, token **has**
  `openid`.
- `signIn({ username, password })` — Amplify SRP, direct `InitiateAuth`. That
  token carries `aws.cognito.signin.user.admin` and **no `openid`**.

`userInfo` answers the second kind with `403 invalid_token`, so every
email/password login would have broken while Google logins kept working — the
worst possible failure shape.

Instead the handler verifies the JWT itself with `node:crypto` against the
pool's public JWKS (`https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json`).
Still zero dependencies, and strictly better:

- works for **both** login paths, no scope requirement
- **no extra network call per request** — the JWKS is cached for the life of
  the container (userInfo would have added a round trip to every upload)
- checks more than userInfo does: RS256 signature, `iss`, `exp`, `token_use`
  (an id token is rejected where an access token is required), and `client_id`
  (a token from another app client in the same pool is rejected)

That is the same set of checks `aws-jwt-verify` performs in the Express server,
which is what `src/server/middleware/auth.ts` uses.

This path was tested against forged tokens: signed with a different key,
tampered signature, `alg: none`, unknown `kid`, id token, wrong `client_id`,
wrong issuer, expired, and missing `exp` — all rejected with 401.

## How to paste and deploy

For each of the two functions, in the Lambda console:

1. **Create function** → Author from scratch → Runtime **Node.js 22.x** →
   Architecture `arm64` (cheaper) or `x86_64`.
2. Name it `avatarUpload` / `avatarServe`.
3. In the code editor, the default file is `index.mjs`. **Keep that name** —
   the `.mjs` extension is what makes `export const handler` work. If you
   rename it to `index.js` the function fails at import with
   `Cannot use import statement outside a module`.
4. Select all, paste the contents of the matching file, **Deploy**.
5. Configuration → General configuration → Timeout **15s**, Memory **512 MB**.
6. Configuration → Environment variables — see below.
7. Configuration → Permissions → click the execution role → add the inline
   policy from the file's header comment.
8. Add trigger → API Gateway → **HTTP API** → Security: Open → then edit the
   route so the path is exactly `/avatar` (POST) or `/avatar/img/{username}`
   (GET).

### Environment variables

`avatarUpload`:

| Key | Value |
| --- | --- |
| `AVATAR_BUCKET` | `ipak-se-okrece-avatars` |
| `COGNITO_USER_POOL_ID` | `eu-west-3_Uylh5ZFUK` |
| `COGNITO_CLIENT_ID` | `3j69q67dfk60kl92gukqhdlr91` |
| `WALLETS_TABLE` | `Wallets` |
| `ALLOWED_ORIGIN` | `https://<your-vercel-domain>,http://localhost:3000` |

`avatarServe`:

| Key | Value |
| --- | --- |
| `AVATAR_BUCKET` | `ipak-se-okrece-avatars` |
| `ALLOWED_ORIGIN` | `https://<your-vercel-domain>,http://localhost:3000` |

Do **not** add `AWS_REGION` — it is a reserved name that Lambda sets itself,
and the console will refuse to save. Every variable above has a working default
baked into the code, so a bare paste runs; setting them is still correct.

### IAM

Attach as an inline policy on each function's execution role, on top of the
`AWSLambdaBasicExecutionRole` the console creates for logs. Account
`637423486388`, region `eu-west-3`.

`avatarUpload`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::ipak-se-okrece-avatars/avatars/*" },
    { "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:UpdateItem"],
      "Resource": "arn:aws:dynamodb:eu-west-3:637423486388:table/Wallets" }
  ]
}
```

`avatarServe`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::ipak-se-okrece-avatars/avatars/*" }
  ]
}
```

`s3:ListBucket` is deliberately omitted — it is not needed, and without it a
`GetObject` on a key the role *can* read still returns a clean `NoSuchKey`
(→ 404) when the object is missing, which is what the handler expects. The
bucket stays private; no bucket policy change, no public access.

### The binary setting for the image endpoint

`avatarServe` returns the image base64-encoded with `isBase64Encoded: true`.
What happens next depends on the API type:

- **HTTP API** (what "Add trigger → API Gateway → HTTP API" creates) — decodes
  it to raw bytes automatically. Nothing to configure. Recommended.
- **REST API** — you must add a binary media type or the browser gets a base64
  *string* labelled `image/jpeg`: a broken image, 200 status, nothing in the
  logs. API settings → Binary media types → add `*/*`, then redeploy the stage.
  Use `*/*` and not `image/jpeg`: REST APIs only decode when the **client's**
  `Accept` header matches a configured type, and browsers send
  `image/avif,image/webp,*/*` for `<img>` tags.

### CORS

The handlers emit CORS headers themselves from `ALLOWED_ORIGIN` and answer the
`OPTIONS` preflight, so a bare paste works with no API Gateway CORS config.

⚠️ Do **not** also enable CORS in the API Gateway console — you would get
duplicate `Access-Control-Allow-Origin` headers, which browsers reject. Pick
one: leave API Gateway CORS off (easiest), or turn it on and set
`ALLOWED_ORIGIN` to an empty string in the Lambda.

### Point the frontend at it

The frontend builds every URL from one `getPort()` base
(`trivia-game-frontend/src/app/helpers/port.ts`), so these two routes moving to
API Gateway puts them on a different host:

```ts
apiFetch('/avatar', { body: { image: preview } })
`${getPort()}/avatar/img/${encodeURIComponent(username)}?v=${info.version}`
```

Three options:

- **(a) Do nothing.** Keep Express serving `/avatar*` on Render, treat these
  Lambdas as standby. Nothing breaks.
- **(b) One domain.** CloudFront (or any reverse proxy) with `/avatar*` → the
  API Gateway URL and everything else → Render. `getPort()` keeps returning one
  base; no frontend change.
- **(c) A second base URL.** Add `NEXT_PUBLIC_AVATAR_API` and use it at those
  two call sites only. Smallest change, but splits the base URL in two places.

(b) is the clean end state, (c) is the fastest. The request/response contract is
identical either way — only the host changes.

Both implementations write identical keys and identical pointers, so Express and
Lambda can run side by side indefinitely. Once the frontend is switched over,
delete the two Express routes in `src/server/apis/operations.ts:53-54` so there
is one implementation rather than two.

## Verify

```bash
API=https://<your-api-id>.execute-api.eu-west-3.amazonaws.com

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
file /tmp/a.jpg                                                   # expect JPEG image data
curl -s -o /dev/null -w '%{http_code}\n' "$API/avatar/img/nobody" # expect 404
```

If the upload returns 401 with a valid token, check CloudWatch: a JWKS fetch
failure logs there, and a `client_id` or `iss` mismatch means
`COGNITO_CLIENT_ID` / `COGNITO_USER_POOL_ID` disagree with the pool the
frontend authenticates against. If it returns 500, `AccessDenied` on
`s3:PutObject` means the bucket name and the policy resource disagree, and
`ResourceNotFoundException` means the `Wallets` table is in another region.

## If you later want this as infrastructure-as-code

An earlier revision of this branch carried an AWS SAM `template.yaml` plus a
TypeScript version of both handlers under `lambda/src/`. It was removed in
favour of these pasteable files, but it is intact in git history:

```bash
git show eda2006 --stat
git checkout eda2006 -- template.yaml lambda/src lambda/package.json lambda/tsconfig.json
```

The SAM version needed the `aws-jwt-verify` package and an esbuild bundling
step. These `.mjs` files need neither, so they can also be zipped and deployed
as-is by any tool without a build step.
