# Content attribution — obligations at launch

## Open Trivia Database — the English question pool

**5,289 of the 5,303 questions** in the `Questions` table come from the
[Open Trivia Database](https://opentdb.com), imported 2026-08-23 via
`scripts/otdb_fetch.mjs`. They carry `source: "opentdb"` and `language: "en"`.

OpenTDB content is licensed **[CC BY-SA 4.0][cc]**. It is usable commercially —
that is why it was chosen — but on two conditions, and both are conditions of
the licence rather than courtesies:

**1. Attribution (BY).** The app must credit the source visibly to players.
Not buried in a repo file: somewhere a user can find it. A line in the
in-app about/settings screen and in any store listing is the minimum:

> Questions from the Open Trivia Database (opentdb.com), licensed CC BY-SA 4.0.

**2. ShareAlike (SA).** Anything *derived* from these questions must be
released under the same licence. This is the one with teeth, and it is worth
being precise about what it does and does not reach:

- Translating a question into Serbian creates a derivative — a translated
  pool is CC BY-SA and cannot be kept proprietary.
- Editing, re-tagging or re-categorising a question is likewise derivative.
- The game engine, the UI and the player data are **not** derivatives. The
  licence follows the questions, not the software that serves them.

The 14 hand-written Serbian questions (`source: "handwritten"`,
`language: "sr"`) are the project's own work and carry no such obligation.
They are preserved in `questions-serbian-preserved.json` precisely because
they are the only content the project owns outright.

**Before launch:** put the attribution line in the app, and decide whether
the Serbian pool will be original writing (unencumbered) or translated from
OpenTDB (CC BY-SA, and must be published as such). That decision is cheaper
to make now than after a translation pass.

[cc]: https://creativecommons.org/licenses/by-sa/4.0/
