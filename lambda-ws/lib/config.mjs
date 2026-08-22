/**
 * ===========================================================================
 * lib/config.mjs — every tunable number, and the clocks the phases run on
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

// ─── config ────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || "eu-west-3";
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || "Connections";
const GAME_STATE_TABLE = process.env.GAME_STATE_TABLE || "GameState";
const QUESTIONS_TABLE = process.env.QUESTIONS_TABLE || "Questions";
const PHASE_TIMER_ARN =
  process.env.PHASE_TIMER_ARN ||
  "arn:aws:states:eu-west-3:637423486388:stateMachine:ipakSeOkrecePhaseTimer";
/**
 * Where postToConnection sends. A WebSocket invocation derives this from its
 * own event; a Step Functions invocation has no requestContext, so the timer
 * path needs it configured.
 */
const WS_ENDPOINT =
  process.env.WS_ENDPOINT ||
  "https://j803en0pf7.execute-api.eu-west-3.amazonaws.com/prod";
const LOBBY_INDEX = process.env.CONNECTIONS_LOBBY_INDEX || "lobby-index";
const LOBBIES_TABLE = process.env.LOBBIES_TABLE || "Lobbies";
const PLAYERS_TABLE = process.env.PLAYERS_TABLE || "Players";
const CONNECTION_TTL_SECONDS = Number(process.env.CONNECTION_TTL_SECONDS || 7200);
// ─── game constants (mirrors src/server/game/room.ts) ──────────────────────
const MIN_PLAYERS = 2;
/** fallback capacity for rooms written before `maxPlayers` was a stored field */
const MAX_PLAYERS = 6;

/**
 * A room's seat count. Every capacity decision goes through here so the number
 * the client is shown in lobby_state and the number the seat cap enforces on
 * join can never drift apart.
 */
function capacityOf(lobby) {
  const n = Math.floor(Number(lobby?.maxPlayers));
  return Number.isFinite(n) && n > 0 ? n : MAX_PLAYERS;
}
/**
 * Fallback stake for rooms created before `startingMoney` was a setting, and
 * the floor the REST side clamps to. The real number comes from the room:
 * createRoom stores `startingMoney` (500..2500) on the Lobbies item and
 * startingMoneyOf() below is the single place that reads it, so the lobby
 * preview and the seeded match can never disagree about what a seat is worth.
 */
const STARTING_MONEY = 500;
const MIN_STARTING_MONEY = 500;
const MAX_STARTING_MONEY = 2500;

/** the room's stake, clamped again here — a hand-edited item is still a room */
function startingMoneyOf(lobby) {
  const n = Math.floor(Number(lobby?.startingMoney));
  if (!Number.isFinite(n)) return STARTING_MONEY;
  return Math.min(MAX_STARTING_MONEY, Math.max(MIN_STARTING_MONEY, n));
}
const CHAT_MAX_LENGTH = 300;
const CHAT_MIN_INTERVAL_MS = 500;
const CHAT_HISTORY_LIMIT = 50;

// ─── phase clocks, ported verbatim from src/server/game/room.ts ─────────────
// Every one becomes an ABSOLUTE `phaseEndsAt` in the stored state rather than
// a setTimeout, because a Lambda that has returned cannot hold a timer. P2.1
// points a scheduler at that timestamp.
const COUNTDOWN_MS = 3000;      // room.ts ticks 3,2,1,0 then spins at t=3s
/**
 * The "Runda N" card, shown at the top of every wheel cycle. Long enough to
 * read and register a number, short enough that it never feels like waiting —
 * it is a beat between rounds, not a phase anything happens in. Tunable here:
 * nothing else hardcodes it, and the deadline it produces is absolute like
 * every other phase, so raising it cannot desynchronise a client.
 */
const ROUND_INTRO_MS = 2500;
const SPIN_TIME_MS = 5000;
const BASE_QUESTION_TIME_MS = 15000;
const MIN_QUESTION_TIME_MS = 8000;
const BETTING_TIME_MS = 4500;   // room.ts has NO endsAt for this one — we do
const REVEAL_MS = 5000;
const PICK_TIME_MS = 15000;
const DUEL_TIME_MS = 20000;
const CODE_DUEL_TIME_MS = 90000;

// ─── scoring constants, also from room.ts ──────────────────────────────────
/** share of questions that are generated arithmetic rather than deck draws */
const MATH_QUESTION_CHANCE = 0.3;

/* ── LANGUAGE ──────────────────────────────────────────────────────────────
 * Every question row carries a `language`. A match draws from ONE of them,
 * because everyone at the table is shown the same question — so the language
 * is a property of the match, not of the player reading it.
 */

/** what a match falls back to, and what an unknown client language becomes */
const DEFAULT_LANGUAGE = "en";

/** languages the question table is expected to hold */
const SUPPORTED_LANGUAGES = ["en", "sr"];

/**
 * Below this many questions, a language is not worth playing in — the deck
 * would loop back to repeats within a single long match. A language that
 * thin falls back to DEFAULT_LANGUAGE rather than serving the same twelve
 * questions over and over.
 *
 * 40 is roughly two long matches' worth at this chain depth.
 */
const MIN_LANGUAGE_POOL = 40;
/** what a wrong answer or a timeout costs the answerer */
const WRONG_ANSWER_COST = 100;
/** smallest stake, and the floor for being counted as an eligible bettor */
const MIN_BET = 10;

// ─── P2.3: the picking-phase mode choice ───────────────────────────────────
/**
 * A picked question is HARDER than the chain's baseline, in both modes. The
 * chain already ramps difficulty every two links (1 + chainDepth/2); a pick is
 * an act of aggression, so it adds one tier on top, capped at 3 like every
 * other draw.
 */
const CHALLENGE_DIFFICULTY_BUMP = 1;

/**
 * DUEL ANTE — a FIXED stake, not a wager the picker sizes.
 *
 * A duel is symmetric: both racers put up the same amount and the winner takes
 * the pair. Letting the picker choose the size would let a rich player shove a
 * poor one all-in on a coin-flip they can afford to lose and their opponent
 * cannot, which is a different (and worse) game. So the ante is fixed, and then
 * capped by the POORER duelist's bankroll — `min(DUEL_ANTE, picker, target)` —
 * so neither side can be made to stake money it does not have and no balance
 * can go negative. All-in remains available, but only in CHALLENGE, where it is
 * the picker's own money at their own risk.
 */
const DUEL_ANTE = 100;

/** a question's clock shrinks as the chain deepens (room.ts askQuestion) */
function questionTimeFor(chainDepth) {
  return Math.max(MIN_QUESTION_TIME_MS, BASE_QUESTION_TIME_MS - chainDepth * 1000);
}

// ─── P2 design constants (state is seeded now, logic lands in later steps) ──
/**
 * SPIN WEIGHTS — the decaying model Matija locked in, replacing room.ts's
 * single `lastSpinTarget` flag (which only dampened the immediately previous
 * target, to a flat 0.4, with no memory).
 *
 * Every player carries `spinWeight`, persisted in the state. On each spin:
 *   picked player      weight = max(MIN, weight * PICKED_DECAY)
 *   everyone else      weight = min(MAX, weight * RECOVERY)
 * then a weighted draw over the living players. The clamp at MIN is what
 * keeps a re-pick possible rather than impossible; the clamp at MAX stops a
 * long-ignored player becoming a certainty. Seeded equal at start_game.
 */
const SPIN_WEIGHT_INITIAL = 1.0;
const SPIN_WEIGHT_MIN = 0.15;
const SPIN_WEIGHT_MAX = 2.5;
const SPIN_WEIGHT_PICKED_DECAY = 0.35;
const SPIN_WEIGHT_RECOVERY = 1.25;

/**
 * QUOTA — betting odds derived from the target's IN-MATCH accuracy, which is
 * why every player carries `stats.correct` / `stats.wrong`. room.ts counted
 * only wrong answers, so there was no denominator to compute this from.
 * Betting into a central `pot` and paying winners out of it is what conserves
 * money and makes elimination inevitable; there is no separate house edge.
 */
const QUOTA_MIN = 1.1;
const QUOTA_MAX = 2.0;
/**
 * Pseudo-observations of a 50% player mixed into every accuracy estimate, so a
 * player with no history quotes exactly even money and the odds firm up as
 * evidence arrives instead of swinging on a single answer. 4 means one correct
 * answer moves the estimate to 0.6, not to 1.0 — a min-sample fallback that
 * degrades smoothly rather than switching on at a threshold.
 */
const QUOTA_PRIOR_WEIGHT = 4;

/** a stale match should not outlive the day it was played */
const STATE_TTL_SECONDS = 24 * 60 * 60;
/** how many times a version-conflicted write is retried before giving up */
const STATE_MAX_ATTEMPTS = 5;
function nowMs() { return Date.now(); }
function ttlFrom(now) { return Math.floor(now / 1000) + STATE_TTL_SECONDS; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export {
  BASE_QUESTION_TIME_MS,
  BETTING_TIME_MS,
  CHALLENGE_DIFFICULTY_BUMP,
  CHAT_HISTORY_LIMIT,
  CHAT_MAX_LENGTH,
  CHAT_MIN_INTERVAL_MS,
  CODE_DUEL_TIME_MS,
  CONNECTIONS_TABLE,
  CONNECTION_TTL_SECONDS,
  COUNTDOWN_MS,
  DUEL_ANTE,
  DUEL_TIME_MS,
  GAME_STATE_TABLE,
  LOBBIES_TABLE,
  LOBBY_INDEX,
  DEFAULT_LANGUAGE,
  MATH_QUESTION_CHANCE,
  MIN_LANGUAGE_POOL,
  SUPPORTED_LANGUAGES,
  MAX_PLAYERS,
  MAX_STARTING_MONEY,
  MIN_BET,
  MIN_PLAYERS,
  MIN_QUESTION_TIME_MS,
  MIN_STARTING_MONEY,
  PHASE_TIMER_ARN,
  PICK_TIME_MS,
  QUESTIONS_TABLE,
  QUOTA_MAX,
  QUOTA_MIN,
  QUOTA_PRIOR_WEIGHT,
  REGION,
  REVEAL_MS,
  ROUND_INTRO_MS,
  SPIN_TIME_MS,
  SPIN_WEIGHT_INITIAL,
  SPIN_WEIGHT_MAX,
  SPIN_WEIGHT_MIN,
  SPIN_WEIGHT_PICKED_DECAY,
  SPIN_WEIGHT_RECOVERY,
  STARTING_MONEY,
  STATE_MAX_ATTEMPTS,
  STATE_TTL_SECONDS,
  PLAYERS_TABLE,
  WRONG_ANSWER_COST,
  WS_ENDPOINT,
  capacityOf,
  nowMs,
  questionTimeFor,
  sleep,
  startingMoneyOf,
  ttlFrom,
};
