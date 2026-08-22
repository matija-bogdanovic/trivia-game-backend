/**
 * ===========================================================================
 * lib/results.mjs — what a finished match leaves behind
 * ===========================================================================
 * Until now the live engine finished a match and forgot it. `Matches` held 0
 * rows, nobody's wins or points ever moved, and no achievement could unlock,
 * because the only code that wrote any of it was the legacy Express server
 * that no deployed client talks to. Everything downstream inherited that
 * silence: the leaderboard was frozen, /history was empty, and the unlock
 * toast had nothing to fire on.
 *
 * ── THE MODEL: ARCHIVE + WINDOW ────────────────────────────────────────────
 * Two writes, deliberately duplicating a little data, because the two reads
 * they serve want opposite things.
 *
 *   Matches   one write-once item per match, the SOURCE OF TRUTH. Full
 *             standings, duration, margin, participants. Never updated, never
 *             capped, read only when somebody opens a specific match.
 *
 *   Players   a CAPPED summary appended to the player's own item
 *             (`matchHistory`, newest first, MATCH_HISTORY_LIMIT entries).
 *
 * The window is what makes /profile and /history a SINGLE GetItem — the read
 * a player does constantly — instead of a query across an archive. The
 * archive is what stops that denormalisation being a lie: the item is capped
 * at 20 matches, and match 21 is not lost, it is in Matches. Without the
 * archive the cap would delete history; without the window every profile view
 * would be a Query. Neither alone is right.
 *
 * The 400KB item ceiling is the reason the cap is not optional. An unbounded
 * array on an item that other routes rewrite whole is a slow-motion outage.
 *
 * ── EXACTLY-ONCE ───────────────────────────────────────────────────────────
 * Several paths can land a match in `gameover` — a timer firing, the last
 * answer, a player leaving — and each broadcasts the phase. So this can be
 * called more than once for one match, and it must pay out once.
 *
 * The Matches write IS the lock: a conditional PutItem on
 * attribute_not_exists(match_id). Whoever wins it continues to the player
 * updates; everyone else sees ConditionalCheckFailed and returns. No separate
 * flag, no second round trip, and the lock lives in the same write that has to
 * happen anyway.
 *
 * ── PLAYER WRITES ──────────────────────────────────────────────────────────
 * Counters go up with ADD, which is atomic and needs no read — a concurrent
 * shop purchase cannot lose a win. The three things that genuinely depend on
 * the previous value (streak, the history window, the achievement list) are
 * read first and written under a ConditionExpression on what was read, and
 * retried if it moved. Nothing here PUTs the whole item; that is what made the
 * old friend-action code able to roll back a game reward.
 * ===========================================================================
 */

import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "./aws.mjs";
import { broadcast } from "./connections.mjs";
import {
  COINS_PER_GAME,
  COINS_PER_WIN,
  CREDIT_CAP,
  MATCHES_TABLE,
  MATCH_HISTORY_LIMIT,
  PLAYERS_TABLE,
  POINTS_PER_WIN,
  POINTS_STREAK_BONUS,
  POINTS_STREAK_BONUS_CAP,
} from "./config.mjs";

/** how many times a player update is retried after losing a race */
const MAX_ATTEMPTS = 3;

/**
 * A conditional write that lost.
 *
 * Matched on the error NAME, not on `instanceof`. ConditionalCheckFailedException
 * is exported by @aws-sdk/client-dynamodb but NOT by @aws-sdk/lib-dynamodb —
 * importing it from the latter is an ESM link error, which in this function
 * means the handler never loads and the socket simply goes silent. The name
 * check needs no import at all, and is what friendsAction.mjs already does.
 */
const isConditionalFailure = (err) =>
  err?.name === "ConditionalCheckFailedException";

/**
 * The catalog, ported verbatim from the legacy game/wallet.ts.
 *
 * ⚠ DUPLICATED with lambda/wallet.mjs, which serves the same list to the
 * client as `achievementCatalog`. The two functions are separately deployed
 * zips with no shared layer, so there is nowhere for one copy to live. If an
 * achievement is added, it must be added in BOTH — a badge unlocked here that
 * the catalog there does not know about renders as a blank tile.
 */
const ACHIEVEMENTS = [
  { id: "first_win", name: "First Blood — win your first game", check: (w) => w.wins >= 1 },
  { id: "streak_10", name: "On Fire — win 10 games in a row", check: (w) => w.currentStreak >= 10 },
  { id: "streak_50", name: "Unstoppable — win 50 games in a row", check: (w) => w.currentStreak >= 50 },
  { id: "streak_100", name: "Legend — win 100 games in a row", check: (w) => w.currentStreak >= 100 },
  { id: "first_bet_win", name: "Gambler — win money on a bet", check: (w) => w.betsWon >= 1 },
  { id: "bet_500", name: "High Roller — win $500+ on a single bet", check: (_w, g) => g.maxBetWin >= 500 },
  { id: "flawless_win", name: "Flawless — win without a single wrong answer", check: (_w, g) => g.wonGame && g.wrongAnswers === 0 },
  { id: "games_50", name: "Veteran — play 50 games", check: (w) => w.gamesPlayed >= 50 },
];

const num = (v, fallback = 0) => (typeof v === "number" && isFinite(v) ? v : fallback);

/**
 * The archive row. `standings` is already ranked by enterGameOver — survivors
 * first, then by money, then by who lasted longer — so placement is position.
 */
function buildMatchRecord(state) {
  const byUsername = new Map((state.players ?? []).map((p) => [p.username, p]));
  const ranked = (state.standings ?? []).filter((s) => !byUsername.get(s.username)?.isSpectator);

  const standings = ranked.map((s, i) => {
    const p = byUsername.get(s.username);
    return {
      username: s.username,
      displayName: s.displayName ?? p?.displayName ?? s.username,
      avatar: p?.avatar ?? null,
      placement: i + 1,
      money: num(s.money),
      survived: Boolean(s.alive),
      roundsPlayed: num(p?.stats?.roundsPlayed),
    };
  });

  const winner = state.winner ?? standings[0]?.username ?? null;
  return {
    match_id: String(state.matchId),
    lobbyId: state.lobbyId ?? null,
    roomName: state.roomName ?? "",
    code: num(state.code),
    playedAt: Date.now(),
    durationMs: state.startedAt ? Date.now() - num(state.startedAt) : 0,
    rounds: num(state.round),
    winner,
    winnerName: standings.find((s) => s.username === winner)?.displayName ?? winner,
    // how far ahead the winner finished; a solo survivor beats $0
    margin: num(standings[0]?.money) - num(standings[1]?.money),
    standings,
    participants: standings.map((s) => s.username),
  };
}

/** the per-player facts an achievement check needs, from the match state */
function gameStatsFor(state, winner) {
  return (state.players ?? [])
    .filter((p) => !p.isSpectator)
    .map((p) => ({
      username: p.username,
      wonGame: p.username === winner,
      betsWon: num(p.stats?.betsWon),
      maxBetWin: num(p.stats?.maxBetWin),
      wrongAnswers: num(p.stats?.wrong),
    }));
}

/** the player's own slice of the archive row */
function historyEntryFor(match, username) {
  const mine = match.standings.find((s) => s.username === username);
  if (!mine) return null;
  return {
    matchId: match.match_id,
    playedAt: match.playedAt,
    roomName: match.roomName,
    winner: match.winner,
    winnerName: match.winnerName,
    won: match.winner === username,
    placement: mine.placement,
    playerCount: match.standings.length,
    margin: match.margin,
    money: mine.money,
    roundsPlayed: mine.roundsPlayed,
  };
}

/**
 * Apply one match to one player. Returns the achievements this match unlocked.
 *
 * The projected wallet is what the achievement checks run against — "win your
 * first game" has to see the win that just happened, not the state before it.
 */
async function applyToPlayer(match, game) {
  const entry = historyEntryFor(match, game.username);
  if (!entry) return [];

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await ddb.send(
      new GetCommand({ TableName: PLAYERS_TABLE, Key: { username: game.username } })
    );
    const w = res.Item ?? {};
    const prevStreak = num(w.currentStreak);
    const prevHistory = Array.isArray(w.matchHistory) ? w.matchHistory : [];
    const prevAchievements = Array.isArray(w.achievements) ? w.achievements : [];

    const currentStreak = game.wonGame ? prevStreak + 1 : 0;
    const bestStreak = Math.max(num(w.bestStreak), currentStreak);
    const pointsGained = game.wonGame
      ? POINTS_PER_WIN +
        Math.min(POINTS_STREAK_BONUS_CAP, POINTS_STREAK_BONUS * (currentStreak - 1))
      : 0;
    const coinsGained = COINS_PER_GAME + (game.wonGame ? COINS_PER_WIN : 0);

    // newest first, and only ever the most recent slice. Guarded against the
    // same match being appended twice if a retry re-reads a written item.
    const history = [entry, ...prevHistory.filter((h) => h?.matchId !== entry.matchId)].slice(
      0,
      MATCH_HISTORY_LIMIT
    );

    const projected = {
      wins: num(w.wins) + (game.wonGame ? 1 : 0),
      gamesPlayed: num(w.gamesPlayed) + 1,
      betsWon: num(w.betsWon) + game.betsWon,
      currentStreak,
      bestStreak,
    };
    const fresh = ACHIEVEMENTS.filter(
      (a) => !prevAchievements.includes(a.id) && a.check(projected, game)
    );
    const achievements = [...prevAchievements, ...fresh.map((a) => a.id)];

    try {
      await ddb.send(
        new UpdateCommand({
          TableName: PLAYERS_TABLE,
          Key: { username: game.username },
          UpdateExpression:
            "SET #cs = :cs, #bs = :bs, #mh = :mh, #ach = :ach, " +
            "#credits = if_not_exists(#credits, :cap), " +
            "#refill = if_not_exists(#refill, :now) " +
            "ADD #wins :w, #games :one, #points :p, #coins :c, " +
            "#rounds :r, #bets :b",
          // only the three read-dependent fields are guarded; the counters are
          // ADD and cannot be lost whatever else happened to the item
          ConditionExpression:
            "(attribute_not_exists(#cs) OR #cs = :prevCs) AND " +
            "(attribute_not_exists(#ach) OR size(#ach) = :prevAchCount)",
          ExpressionAttributeNames: {
            "#cs": "currentStreak",
            "#bs": "bestStreak",
            "#mh": "matchHistory",
            "#ach": "achievements",
            "#credits": "credits",
            "#refill": "lastRefillAt",
            "#wins": "wins",
            "#games": "gamesPlayed",
            "#points": "points",
            "#coins": "coins",
            "#rounds": "roundsPlayed",
            "#bets": "betsWon",
          },
          ExpressionAttributeValues: {
            ":cs": currentStreak,
            ":bs": bestStreak,
            ":mh": history,
            ":ach": achievements,
            ":prevCs": prevStreak,
            ":prevAchCount": prevAchievements.length,
            ":cap": CREDIT_CAP,
            ":now": Date.now(),
            ":w": game.wonGame ? 1 : 0,
            ":one": 1,
            ":p": pointsGained,
            ":c": coinsGained,
            ":r": entry.roundsPlayed,
            ":b": game.betsWon,
          },
        })
      );
      return fresh;
    } catch (err) {
      if (!isConditionalFailure(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      // the item moved between the read and the write — rebuild from what is
      // true now rather than writing a decision made on stale numbers
    }
  }
  return [];
}

/**
 * Persist a finished match and announce what it unlocked.
 *
 * Safe to call more than once for the same match — the conditional write on
 * the archive row is what makes the second call a no-op. Never throws into the
 * caller: a match that has already been played out on screen must not be
 * failed by a bookkeeping error, so problems are logged and swallowed.
 */
async function persistMatchResults(event, state) {
  if (!state?.matchId) return;

  const match = buildMatchRecord(state);
  if (!match.participants.length) return;

  try {
    await ddb.send(
      new PutCommand({
        TableName: MATCHES_TABLE,
        Item: match,
        ConditionExpression: "attribute_not_exists(match_id)",
      })
    );
  } catch (err) {
    // somebody else already recorded this match — they own the payouts too
    if (isConditionalFailure(err)) return;
    console.error("match archive write failed", match.match_id, err);
    return; // no archive means no payout; a half-recorded match is worse
  }

  const stats = gameStatsFor(state, match.winner);
  const unlocked = [];
  await Promise.all(
    stats.map(async (game) => {
      try {
        const fresh = await applyToPlayer(match, game);
        if (fresh.length) unlocked.push([game.username, fresh]);
      } catch (err) {
        // one player's bookkeeping must not cost the others theirs
        console.error("failed to record result for", game.username, err);
      }
    })
  );

  for (const [username, achievements] of unlocked) {
    const names = achievements.map((a) => a.name);
    await broadcast(event, state.lobbyId, {
      type: "achievements_unlocked",
      username,
      achievements: achievements.map((a) => ({ id: a.id, name: a.name })),
    });
    const displayName =
      (state.players ?? []).find((p) => p.username === username)?.displayName ?? username;
    /*
     * The system chat line, inlined rather than imported. messages.mjs is what
     * CALLS this module (broadcastPhase is the one place every phase change
     * passes through), so importing systemChat back from it would make the
     * dependency graph cyclic — and this is four lines of it.
     */
    await broadcast(event, state.lobbyId, {
      type: "chat_message",
      username: null,
      text: `🏅 ${displayName} unlocked: ${names.join(", ")}`,
      at: Date.now(),
    });
  }
}

export { ACHIEVEMENTS, buildMatchRecord, gameStatsFor, historyEntryFor, persistMatchResults };
