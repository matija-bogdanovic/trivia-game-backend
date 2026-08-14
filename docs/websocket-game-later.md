# The real-time game on serverless — a note for later

**Status: deferred. No code written, nothing decided.** This is a one-page
record of what the problem actually is, so the decision can be made later
without re-reading `room.ts` from scratch.

The REST routes are ported and pasteable — see [`lambda/README.md`](../lambda/README.md).
The game is the part that does not translate, and this is why.

## What the game server holds that a Lambda cannot

`src/server/game/manager.ts` keeps a module-level `rooms` Map. Each
`GameRoom` (`src/server/game/room.ts`, ~1300 lines) holds, **in memory only**:

- the live player map, each with a `connected` flag and an open socket handle
- `phase` — one of `lobby`, `countdown`, `spin`, `question`, `betting`,
  `reveal`, `picking`, `duel`, `gameover`
- the current turn: who is answering, the question, `askedAt`, the per-player
  bet map, the hidden answer until reveal
- duel state (guess duels and the 4-symbol / 6-attempt code duels)
- the question deck, per-room chat history (last 50), money per player

None of this is in DynamoDB. The `Lobbies` table only holds the pre-game
roster; the moment a game starts, the truth lives in the process.

## The timers are the hard part

Phase changes are driven by in-process `setTimeout`s, not by client messages:
spin 5s → question 15s (shrinking to 8s as the chain deepens) → betting 4.5s →
reveal 5s → picking 15s; duels 20s, code duels 90s; plus a 60s empty-room grace
timer. A Lambda that returns has no way to fire "betting closes in 4.5 seconds".

There are also fan-out broadcasts: every phase change pushes state to all six
sockets at once.

## The shape a serverless version would take

1. **API Gateway WebSocket API** — `$connect`, `$disconnect`, `$default`, with
   the existing 11 socket actions (`start_game`, `submit_answer`, `place_bet`,
   `pick_player`, `submit_guess`, `submit_code`, `chat`, `play_again`,
   `kick_player`, `terminate_lobby`, `leave`) dispatched from `$default`.
2. **Room state in DynamoDB**, one item per room, written with a version
   attribute and a conditional update so two players acting in the same
   instant cannot both win. This is the part that turns a field mutation in
   `room.ts` into a read-modify-conditional-write.
3. **Outbound messages via `ApiGatewayManagementApi.postToConnection`**, with
   the connection IDs stored on the room item. Stale connections return 410 and
   must be reaped.
4. **The timed phases** — the piece that needs a real decision:
   - **EventBridge Scheduler**, one-shot schedule per deadline. Cleanest fit,
     ~1s granularity, but it means creating and deleting a schedule on every
     phase change.
   - **Step Functions** with `Wait` states — a state machine per match. Very
     good fit for a fixed phase cycle; costs a state transition per step.
   - **DynamoDB TTL + Streams** — cheapest, but TTL deletion runs *up to 48
     hours* late. **Not viable for a 4.5-second betting window.** Mentioned
     only to rule it out.

   Leaning: **Step Functions**, because the phase cycle is genuinely a state
   machine and the retry/timeout semantics come free.

## Rough effort

Not a port — a rewrite of the turn engine against a different consistency
model. Ballpark **3–6 focused days**, most of it in (2) and (4): turning ~1300
lines of "mutate an object in memory" into conditional writes, plus a test rig
that can drive six simulated clients through a full match. Racy by nature, so
budget real time for the edge cases (two players answering in the same
instant, a disconnect mid-duel, a reconnect during reveal).

## The pragmatic alternative

**Leave the game on the always-on host.** It is one small Render instance
serving WebSockets, and it is genuinely the right tool for stateful real-time
work. Moving the REST routes to Lambda already takes the bursty, scale-sensitive
traffic off it. The four degraded routes in `lambda/README.md`
(`lobbies`, `getActiveRooms`, `friends/list`, `myActiveRoom`) exist precisely
because they read this live state — if the game stays on Express, keeping those
four there too costs nothing and loses no functionality.

That split — Lambda for stateless REST, one small always-on process for the
game — is a normal architecture, not a compromise.
