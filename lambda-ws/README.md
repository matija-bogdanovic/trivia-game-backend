# WebSocket API — setup and deployment

One Lambda behind an API Gateway **WebSocket** API, attached to all three of
`$connect`, `$disconnect` and `$default`. Separate from the REST function in
`lambda/` — different event shape, different response contract, different IAM.

**Scope.** The plumbing (connect, authenticated `join`, live lobby presence,
`chat`, `leave`, `ping`, `kick_player`) *and* the turn engine: durable match
state on optimistic locks, a Step Functions phase scheduler, the central pot
with accuracy-derived quotas, and the CHALLENGE / DUEL picking phase.
`play_again`, `terminate_lobby` and the superseded guess/code duel
(`submit_guess`, `submit_code`) still answer `{ type: "not_implemented" }`.

Region `eu-west-3`, account `637423486388` throughout — the same as the REST
stack.

---

## ⚠ THIS IS NO LONGER A PASTEABLE SINGLE FILE

It was ~2,500 lines and 120 KB in one `index.mjs`. It is now a small entry
point plus a `lib/` tree, and **it ships as a multi-file zip from the CLI**.
The console's inline editor cannot paste a directory, so the paste workflow
described further down applies only to the *configuration* steps — never to the
code.

```
lambda-ws/
  index.mjs                 the router: event → handler. Lambda handler stays index.handler
  lib/
    config.mjs              every tunable number, every phase clock, the env vars
    aws.mjs                 the shared DynamoDB document client
    auth.mjs                Cognito access-token verification + scrypt room passwords
    connections.mjs         Connections table, postToConnection, lobby fan-out
    lobbies.mjs             Lobbies + Wallets reads
    state.mjs               match state: shape, serialisation, the version lock
    questions.mjs           the pool, the deck, generated arithmetic
    turn.mjs                the phase stamp, the living-player list, the weighted wheel
    pot.mjs                 who may bet, the accuracy-derived quotas, settlement
    phases.mjs              the phase machine: spin, question, betting, duel,
                            picking, reveal, gameover
    scheduler.mjs           the Step Functions phase timer + the deadline entry point
    messages.mjs            phase messages and the system chat line
    presence.mjs            lobby_state
    handlers/
      connect.mjs           $connect, $disconnect
      join.mjs              join
      chat.mjs              chat
      room.mjs              leave, close, the host gate, kick_player
      game.mjs              start_game, submit_answer, place_bet, pick_player
```

The dependency graph is acyclic and points one way — handlers → phases → pot →
turn → config, and handlers → state / messages / scheduler → connections →
config. Nothing in `lib/` imports a handler, and
nothing imports `index.mjs`. **Every import is relative** (`./lib/…`,
`../config.mjs`) so it resolves inside the zip exactly as it does on disk; the
same pattern the REST function's multi-file zip uses.

### Deploying a code change

```sh
cd lambda-ws
zip -qr /tmp/ws.zip index.mjs lib
aws lambda update-function-code \
  --region eu-west-3 --function-name ipakSeOkreceWS \
  --zip-file fileb:///tmp/ws.zip
```

Zip from **inside** `lambda-ws/` so the archive root holds `index.mjs` and
`lib/` with no wrapping folder — a wrapped path makes the runtime fail to find
`index.handler`. Verify a deploy landed:

```sh
aws lambda get-function-configuration --region eu-west-3 \
  --function-name ipakSeOkreceWS --query '{Handler:Handler,Sha:CodeSha256}'
```

A module-resolution mistake inside the zip does not surface as a nice error —
the socket opens and the handler never answers. So after any deploy, send a
`ping` and confirm the `pong` before assuming it worked.

---

## ⚠ Read this before clicking anything else

**The "Attach integrations" step needs the Lambda to already exist.** The
dropdown only lists functions that are there when the page loads.

So: leave the wizard tab open and untouched, do **Step 1** and **Step 2** in a
second tab, then come back to it for **Step 3**. Nothing in the wizard is lost
by waiting — and if the tab does time out, the same screens exist afterwards
under *Routes → Integrations* on the created API.

Sequence:

| # | Where | What |
|---|-------|------|
| 1 | DynamoDB | create the `Connections` table + `lobby-index` GSI + TTL |
| 2 | Lambda | create `ipakseokrece-ws`, upload the `index.mjs` + `lib/` zip |
| 3 | **the wizard tab** | attach that function to all three routes |
| 4 | the wizard tab | stage `prod` → Create and deploy → copy the `wss://` URL |
| 5 | IAM | attach `iam-policy.json` (needs the API id from step 4) |
| 6 | Lambda | confirm API Gateway's invoke permission |
| 7 | terminal | smoke test |
| 8 | frontend | the one required change |

---

## Step 1 — DynamoDB: the `Connections` table

**DynamoDB → Tables → Create table**

- **Table name:** `Connections`
- **Partition key:** `connectionId` — type **String**
- **Sort key:** leave empty
- **Table settings:** *Customize settings*
- **Capacity mode:** **On-demand** (sockets are bursty; nothing to size)
- Everything else: defaults

Then, on the same Create-table screen, **Secondary indexes → Create global
index**:

- **Partition key:** `lobbyId` — type **String**
- **Sort key:** leave empty
- **Index name:** `lobby-index`
- **Attribute projections:** **All**
  (the broadcast reads `username`, `displayName`, `avatar`, `streak`,
  `joinedAt` straight off the index — *Keys only* would force a second read per
  connection on every single broadcast)

**Create table.** Wait for status **Active** (~30 s).

Finally, TTL — this is a separate screen, after the table exists:

**Tables → Connections → Additional settings → Time to Live → Turn on**

- **TTL attribute name:** `expiresAt` — exactly this, it is what the code writes
- Leave the preview/CloudWatch options off

TTL is only a backstop. `$disconnect` deletes the row promptly; TTL reaps the
rows from invocations that never happened at all (a Lambda throttle, an
API Gateway hiccup), and DynamoDB may take up to 48 h to act on it. That is
fine for *this* job — and is exactly why the doc rules TTL out for the 4.5 s
betting window.

## Step 2 — Lambda: the function

**Lambda → Create function → Author from scratch**

- **Function name:** `ipakseokrece-ws`
- **Runtime:** **Node.js 22.x** (20.x or 24.x also fine — needs ≥ 18 for the
  bundled AWS SDK v3, `fetch` and `base64url`)
- **Architecture:** `arm64` (cheaper; `x86_64` works too)
- **Permissions:** *Create a new role with basic Lambda permissions* — the real
  policy goes on in step 5
- **Create function**

Then:

1. **Code** — do NOT paste. Upload the multi-file zip built as shown at the top
   of this file (`zip -qr /tmp/ws.zip index.mjs lib` from inside `lambda-ws/`,
   then `aws lambda update-function-code`). Console → **Upload from → .zip
   file** works too. Handler stays `index.handler`. No dependencies to install
   — everything it imports ships in the runtime.
2. **Configuration → General configuration → Edit:**
   - **Memory:** `256 MB`
   - **Timeout:** `10 sec`
     (a broadcast is one GSI query plus N `postToConnection` calls, all
     parallel — 10 s is generous. Do **not** leave it at the 3 s default.)
3. **Configuration → Environment variables.** Every one of these has a working
   default baked in, so a function with *no* variables set still runs against
   `Connections` / `Lobbies` / `Wallets` in `eu-west-3`. Set them anyway if any
   name differs:

   | Key | Value |
   |-----|-------|
   | `CONNECTIONS_TABLE` | `Connections` |
   | `CONNECTIONS_LOBBY_INDEX` | `lobby-index` |
   | `LOBBIES_TABLE` | `Lobbies` |
   | `WALLETS_TABLE` | `Wallets` |
   | `COGNITO_USER_POOL_ID` | `eu-west-3_Uylh5ZFUK` |
   | `COGNITO_CLIENT_ID` | `3j69q67dfk60kl92gukqhdlr91` |
   | `CONNECTION_TTL_SECONDS` | `7200` |

   Do **not** set `AWS_REGION` — Lambda reserves it and the console will reject
   the save.

## Step 3 — the wizard: "Attach integrations"

Back in the open tab. The screen lists the three routes you added. For **each
one** — and it is the same function all three times:

| Route | Integration type | Lambda function |
|-------|------------------|-----------------|
| `$connect` | **Lambda** | `ipakseokrece-ws` |
| `$disconnect` | **Lambda** | `ipakseokrece-ws` |
| `$default` | **Lambda** | `ipakseokrece-ws` |

Per row: set **Integration type** to `Lambda`, then pick `ipakseokrece-ws` from
the **Lambda function** dropdown (region `eu-west-3`). If the function is not
listed, the page loaded before step 2 finished — reload the tab.

Notes on the three fields that trip people up here:

- **There is no "Use Lambda Proxy integration" checkbox.** WebSocket Lambda
  integrations are proxy by default. This is the opposite of the REST API,
  where that box being unticked was the whole bug (see `lambda/index.mjs`).
- **Leave "Use default timeout" ticked** (29 s).
- **Do not add a route response** on any route. Phase 0 pushes every reply
  through `postToConnection`, never through the integration's return value.
  Adding one changes nothing but adds a screen to maintain.
- Confirm the API's **route selection expression** is `$request.body.type` (set
  on the first wizard screen). All three routes are `$`-prefixed system routes,
  so nothing else can match — which is what lets one function cover everything.

## Step 4 — stage and deploy

Next wizard screen, **Add stage**:

- **Stage name:** `prod`
- **Auto-deploy:** on

**Next → Create and deploy.**

On the API's **Stages → prod** page, copy the **WebSocket URL**:

```
wss://<api-id>.execute-api.eu-west-3.amazonaws.com/prod
```

That whole string — including `/prod` and no trailing slash — is what the
frontend needs. Note the `<api-id>` too; step 5 needs it.

## Step 5 — IAM

The auto-created role only has CloudWatch Logs. It needs three more things,
and one of them (`execute-api:ManageConnections`) could not be written until
the API existed — which is why this step is here and not earlier.

**Lambda → ipakseokrece-ws → Configuration → Permissions → Role name** (opens
IAM) **→ Add permissions → Create inline policy → JSON**

Paste [`iam-policy.json`](./iam-policy.json), then **replace
`REPLACE_WS_API_ID`** with the `<api-id>` from step 4. Name it
`ipakseokrece-ws-policy` and create it.

What it grants, and why each line is load-bearing:

| Sid | Why |
|-----|-----|
| `PostToConnection` | `execute-api:ManageConnections` on `<api-id>/*/POST/@connections/*` — **every outbound message**. Without it, the socket connects and then goes silent: the client sees nothing at all, and the only evidence is `AccessDeniedException` in CloudWatch. |
| `ConnectionsTable` | Get/Put/Update/Delete on `Connections` |
| `ConnectionsLobbyIndex` | `Query` on `Connections/index/lobby-index` — a GSI is a **separate resource ARN**; table permissions do not cover it. This is the #2 silent-broadcast cause. |
| `LobbiesTableRead` | `GetItem` on `Lobbies` — `join` resolves the room. The REST role deliberately lacks `GetItem` here; this role needs it. |
| `LobbiesCodeIndex` | `Query` on `Lobbies/index/code-index` — only when a client joins by numeric code instead of lobby id |
| `WalletsProfileRead` | `GetItem` on `Wallets` — streak badge and avatar. Cosmetic and non-fatal; drop it if you would rather not widen the role. |

The `*` in the middle of the `execute-api` ARN is the stage, so `prod` and any
later stage are both covered.

## Step 6 — confirm API Gateway may invoke the function

The wizard normally adds this for you, per route. Confirm rather than assume:

**Lambda → ipakseokrece-ws → Configuration → Permissions →
Resource-based policy statements**

You should see statements with **Principal** `apigateway.amazonaws.com` and a
**Source ARN** of `arn:aws:execute-api:eu-west-3:637423486388:<api-id>/*/...`.

If they are missing, the socket fails to connect outright (HTTP 500 on the
handshake, `Internal server error` in the API Gateway logs). Fastest fix: go to
**API Gateway → Routes**, click the route, open its **Integration**, and re-pick
the same Lambda function — the console re-adds the permission on save. The CLI
equivalent, if you prefer:

```bash
aws lambda add-permission \
  --function-name ipakseokrece-ws \
  --statement-id apigw-ws-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:eu-west-3:637423486388:<api-id>/*/*" \
  --region eu-west-3
```

## Step 7 — smoke test

```bash
npx wscat -c wss://<api-id>.execute-api.eu-west-3.amazonaws.com/prod
```

Then paste messages in, one per line:

```json
{"type":"ping","echo":"hello"}
```
→ `{"type":"pong","at":...,"connectionId":"...","echo":"hello","joined":false,"lobbyId":null}`

This one line proves the whole chain: the handshake, `$connect` writing to
DynamoDB, `$default` routing on `$request.body.type`, and — the part that
usually breaks — `postToConnection` writing back out.

```json
{"type":"start_game"}
```
→ `{"type":"not_implemented","action":"start_game",...}` — routing works, the
turn engine is genuinely absent.

```json
{"type":"join","token":"<a real Cognito ACCESS token>","lobbyId":"<a lobby_id>"}
```
→ `chat_history`, then `lobby_state`, then a `chat_message` join line.
An expired or absent token gives `{"type":"join_denied","reason":"unauthenticated"}`
— which is correct, and is the check that stops a client claiming another
player's identity.

Open a second `wscat` against the same `lobbyId` and both should see each
other's `lobby_state` and `chat`. Close one and the other should get an updated
`lobby_state` — that is `$disconnect` and the presence rebuild working.

If the socket connects but nothing ever comes back, it is step 5 nine times out
of ten. CloudWatch → `/aws/lambda/ipakseokrece-ws` will say which of the two
ARNs it was.

---

## Step 8 — the one required frontend change

**Not done yet — this is the handoff.** Two edits, both small, and the socket
will not connect usefully until the second one lands.

**a) Point the socket at API Gateway.** `NEXT_PUBLIC_WS_URL` already exists and
is already the only thing that decides the socket host
(`src/app/helpers/port.ts`). Set it in the frontend's env / Amplify build
settings:

```
NEXT_PUBLIC_WS_URL=wss://<api-id>.execute-api.eu-west-3.amazonaws.com/prod
```

It is a `NEXT_PUBLIC_*` var, so it is inlined at build time — **the frontend
must be rebuilt**, not just restarted.

**b) Move the lobby id off the socket path and into the `join` message.**
This is the required one.

Today the lobby id rides on the URL path:

```ts
// game_context.tsx:58
const socketUrl = useMemo(() => getWebSocketUrl(pathname), [pathname]);
// → wss://host/game/<lobbyId>
```

and `handleGameConnection()` parses it back out of `/game/([A-Za-z0-9-]+)`.

**API Gateway WebSocket APIs have no path routing.** A socket opened at
`wss://<api-id>...execute-api.../prod/game/abc` does not reach a "game/abc"
route — it connects to the same single API, and the path is simply dropped. So
the id has to travel in the message body instead:

```ts
// socketUrl becomes the bare host — no pathname
const socketUrl = useMemo(() => getWebSocketUrl(''), []);

// and the join carries the lobby id
sendJsonMessage({
  type: 'join',
  token,
  lobbyId,                 // ← new: from usePathname(), /game/<lobbyId>
  displayName,
  password: password ?? passwordRef.current ?? undefined,
});
```

`lobbyId` is the same value `pathname` already holds — pull it out of the route
segment and pass it through. Nothing else in `game_context.tsx` changes:
`sendJoin` already re-fires on every reconnect, which is exactly what a
serverless socket needs, since there is no per-connection server memory to
survive one.

The handler accepts either a `lobby_id` UUID or a numeric room code, and falls
back to a `?lobbyId=` query-string parameter captured at `$connect` if the
message omits one — so a transitional build that cannot drop the path yet can
append the query string instead.

Both backends keep working during the switch: the Express server ignores an
extra `lobbyId` field in the join message, so (b) can ship before (a) does.

---

## Message contract (Phase 0)

Names and shapes are taken from the running game, not invented —
`game_context.tsx` sends these and `game_slice.ts` reads them.

**Client → server** (`$default`, dispatched on `type`)

| `type` | Payload | Phase 0 |
|--------|---------|---------|
| `join` | `token`, `lobbyId`, `displayName?`, `password?`, `avatar?` | ✅ authenticates, seats, broadcasts presence |
| `chat` | `text` | ✅ 300-char cap, 500 ms flood control |
| `leave` | — | ✅ presence only |
| `ping` | `echo?` | ✅ plumbing check, works before `join` |
| `start_game` `submit_answer` `place_bet` `pick_player` `submit_guess` `submit_code` `play_again` `kick_player` `terminate_lobby` | — | ⛔ `not_implemented` |

**Server → client**

| `type` | When |
|--------|------|
| `lobby_state` | any presence change — join, disconnect, leave |
| `chat_message` | a chat line; `username: null` means the system voice |
| `chat_history` | once, right after a successful `join` (empty in Phase 0 — no history is persisted) |
| `join_denied` | `unauthenticated` · `room_full` · `password_required` · `wrong_password` · `legacy_password_hash` |
| `pong` | reply to `ping` |
| `not_implemented` | a turn-engine action |
| `error` | bad JSON, unknown type, no lobbyId, room not found |

`lobby_state.players[]` carries the full shape `game_slice.ts` expects —
`username`, `displayName`, `avatar`, `money`, `alive`, `connected`, `isHost`,
`streak`, `isSpectator` — merged from the `Lobbies` roster (seats, who is
Admin) and the `Connections` GSI (who is actually holding a socket).

## What Phase 1 still owes

Phase 0 stops exactly where the doc says it gets hard, and none of the below is
started:

- **Room state in DynamoDB**, one item per room with a version attribute and
  conditional updates, so two players acting in the same instant cannot both
  win. `phase` here is hardcoded `"lobby"` and `round` is `0` precisely because
  that item does not exist yet.
- **The timed phases** — spin 5 s → question 15 s → betting 4.5 s → reveal 5 s →
  picking 15 s, duels 20 s / 90 s. A returned Lambda cannot fire these. The
  doc leans **Step Functions**; EventBridge Scheduler is the alternative; TTL is
  ruled out.
- **Chat history** — the Express room keeps the last 50 in memory. Persisting it
  is easy (an item per room, or a `Chat` table) and is not blocked on any of the
  above.
- **Spectators** — `isSpectator` is always `false` here, because it depends on
  the phase, which depends on the room item.

Phase 0 does not touch the Express server. It stays up and stays authoritative
until the turn engine actually exists somewhere else — and per the doc's
closing argument, keeping it may well be the right end state.
