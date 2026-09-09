# infra — the account, written down

`template.yaml` describes every AWS resource this backend needs: nine DynamoDB
tables, an S3 bucket, two Lambda functions, their two IAM roles, a Step
Functions phase clock, a REST API and a WebSocket API.

Every value in it was read off the live account rather than remembered.

## Why

All of it was made by hand — nine tables from nine one-off scripts, two roles
edited in the console, two APIs clicked together, and every deploy a zip built
at a terminal. That worked, and it cost real outages:

- three separate IAM gaps (`Notifications`, `ChatMessages`, `PushSubscriptions`),
  each found only when something broke or when somebody thought to check;
- a hand-edited `ALLOWED_ORIGIN` that blocked every request from a new origin;
- a hand-edited Cognito callback list that broke sign-in from that same origin.

Each of those is a one-line diff in a template and an invisible omission in a
console. And underneath all of them was a worse problem: **none of it could be
rebuilt.** Losing the account meant losing the system, because nothing anywhere
said what the source code needed in order to run.

## The safety property that matters

Every table and the avatar bucket carry `DeletionPolicy: Retain` **and**
`UpdateReplacePolicy: Retain`. Deleting the stack, or making a change
CloudFormation decides needs a replacement, orphans them rather than destroying
them.

That is deliberate and it is the reason the rest of this is safe to attempt:
the worst mistake available here is a mess to clean up, not the loss of every
player's account.

## Standing up a second environment

Do this first. It is how you find out the template is right without finding out
on production.

```sh
export VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=…
./infra/deploy.sh staging
```

That packages both functions, uploads them under a content-hashed key, and
deploys the stack. It prints the REST and WebSocket URLs; put those in the
frontend's `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` to point a local app
at it.

The staging stack gets its own tables (`staging-Players`, and so on) and its own
bucket. It shares the Cognito pool by default — change `CognitoUserPoolId` if
you want it isolated, and remember the callback URLs.

Redeploying is the same command. The code key changes with the content, which
is what makes a code change actually deploy: CloudFormation only updates a
function when its `S3Key` moves, so a fixed key would upload new bytes and
leave the old ones running.

## Adopting production

Production's resources exist and are **not** in any stack. CloudFormation can
adopt them with a resource import, and the retention policies above mean a
failed import leaves them untouched.

Do this only after a staging stack has been created, torn down and recreated at
least once.

1. Take a backup that does not depend on this working:
   ```sh
   for t in Players Lobbies Connections GameState Questions Matches \
            ChatMessages Notifications PushSubscriptions; do
     aws dynamodb create-backup --region eu-west-3 \
       --table-name "$t" --backup-name "pre-import-$t"
   done
   ```
2. Import in **stages**, not all at once. Tables first, then the bucket, then
   the roles, and leave the functions and APIs for last — those are the ones
   whose identifiers (`in0nom6ecd`, `j803en0pf7`) are baked into the deployed
   frontend, so an import that replaces them is an outage.
3. For each batch, write a `resources-to-import.json` naming the physical ids,
   and:
   ```sh
   aws cloudformation create-change-set --region eu-west-3 \
     --stack-name ipakseokrece-prod --change-set-type IMPORT \
     --resources-to-import file://resources-to-import.json \
     --template-body file://template.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --change-set-name import-tables
   ```
   Read the change set before executing it. An import that reports anything
   other than `Import` for an existing resource is a signal to stop.

**The parameters must match reality exactly for an import.** Production's
tables are unprefixed, so `TablePrefix` stays empty; its stage is `prod`; its
bucket is `ipak-se-okrece-avatars`. A mismatch is what turns an import into a
replacement.

## Two things left deliberately as they are

The template reproduces the live IAM rather than improving it, because an
adoption that also changes behaviour breaks something and cannot tell you which
half did it. Two oddities are marked in place:

- the REST role grants `Query` on a Lobbies `admin-index` that does not exist —
  dropped here, since a grant on a phantom resource is litter, not behaviour;
- the WS role grants `states:StartExecution` on `*` as well as on the phase
  timer — scoped here to the one machine actually started. If phase timers stop
  firing after an import, that is the first line to look at.

## The frontend is Amplify Hosting, and it is not in here

`template.yaml` describes the BACKEND — the Lambda, DynamoDB and API Gateway
the app talks to. The app itself is hosted by AWS Amplify (app
`d14ht0mjyjtjv9`, branch `main`, auto-building from GitHub), and that is
deliberately outside this template: the app is bound to GitHub through an
OAuth grant that cannot be expressed in CloudFormation without handing it a
token.

What it does mean is that Amplify's **environment variables are hand-set and
version-controlled nowhere**, which is exactly the failure mode this directory
exists to end. They are, at app level, today:

```
NEXT_PUBLIC_API_URL   https://in0nom6ecd.execute-api.eu-west-3.amazonaws.com/prod
NEXT_PUBLIC_WS_URL    wss://j803en0pf7.execute-api.eu-west-3.amazonaws.com/prod
NEXT_PUBLIC_APP_URL   https://main.d14ht0mjyjtjv9.amplifyapp.com/
NEXT_PUBLIC_GOOGLE_AUTH  1
```

Four more that the app reads are NOT set and resolve through hardcoded
fallbacks in `src/app/lib/amplify_configure.ts` and `helpers/push.ts`: the
Cognito pool id, the app client id, the identity pool id, the Cognito domain
and the VAPID public key. That works and is fragile — the fallback is the only
thing keeping sign-in alive if someone edits this list.

`NEXT_PUBLIC_APP_URL` must match a Cognito callback URL character for
character, trailing slash included. That pair has broken sign-in once already.

### The amplify/ directory is NOT this

The repository contains an `amplify/` folder holding a `defineAuth` and a
`Todo` model. It is the untouched output of `npm create amplify` and nothing
uses it: `@aws-amplify/backend` is not installed, no source file imports it,
the build spec has no backend phase, and the app configures Cognito by hand
against a pool that folder did not create.

It is worth deleting. Left in place it is a loaded gun: installing
`@aws-amplify/backend`, or Amplify deciding to pick it up on a future build,
would deploy a Todo table and a SECOND Cognito user pool — and an auth
configuration that competes with the real one.

## Still not covered

- **Cognito.** The user pool, its app client and the Google identity provider
  are not in this template. They hold live user accounts and a client secret,
  and adopting them is a larger and more dangerous job than the rest put
  together. The callback-URL list living outside version control is a known
  hole — it has caused one outage already.
- **The secrets.** `VapidPrivateKey` is a `NoEcho` parameter, which keeps it out
  of console output but is not a secret store. Moving it to Secrets Manager is
  the next step, and parameterising it is what makes that a one-line change.
