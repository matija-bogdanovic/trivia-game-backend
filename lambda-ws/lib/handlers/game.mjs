/**
 * ===========================================================================
 * lib/handlers/game.mjs — start_game, submit_answer, place_bet, pick_player
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { CHALLENGE_DIFFICULTY_BUMP, MIN_BET, MIN_PLAYERS, nowMs } from "../config.mjs";
import { broadcast, connectionsInLobby, postTo } from "../connections.mjs";
import { resolveLobby } from "../lobbies.mjs";
import { broadcastGameState, broadcastPhase, systemChat } from "../messages.mjs";
import {
  applyDuelAnswer,
  enterBetting,
  enterDuel,
  enterQuestion,
  enterReveal,
} from "../phases.mjs";
import { pendingBettors, quotasFor } from "../pot.mjs";
import { loadQuestionPool } from "../questions.mjs";
import { rearmPhaseTimer } from "../scheduler.mjs";
import {
  createGameState,
  initialGameState,
  mutateGameState,
  readGameState,
} from "../state.mjs";

/**
 * start_game — P2.0: build the state item, announce it, return.
 *
 * Host-gated upstream by requireHost(). No turn logic runs here: the match is
 * created in `countdown` with a real deadline and stops. What advances it is
 * the scheduler: rearmPhaseTimer() starts a Step Functions execution that
 * sleeps until `phaseEndsAt` and then drives the match forward.
 */
/*
 * ═══════════════════════════════════════════════════════════════════════════
 * SPECTATORS
 * ═══════════════════════════════════════════════════════════════════════════
 * A spectator is someone holding a socket on this lobby who is not in the
 * running match's `players`. The roster is fixed when the host starts —
 * initialGameState() takes the seats connected at that instant — so anyone
 * who arrived after that is watching.
 *
 * THE REFUSALS BELOW ARE BELT AND BRACES, and that is deliberate. Every
 * action is ALREADY closed to a spectator by the rules it enforces anyway:
 * submit_answer requires being `turn.answering`, pick_player requires being
 * `currentPick.picker`, and place_bet looks the caller up in `s.players` and
 * bails when they are absent. The wheel can only land on someone in that
 * array, so a spectator can never be any of those things.
 *
 * What was missing is that each of those paths refuses in SILENCE — the
 * mutation returns null and nothing is sent back. For a player that is right
 * (they pressed something stale), but for a spectator it looks like the app
 * ignored them. These guards answer instead, and answer before the state is
 * mutated, so the reason is the true one rather than whichever rule happened
 * to reject them first.
 */
function isSpectator(state, username) {
  if (!state || state.phase === "gameover") return false;
  return !(state.players ?? []).some((p) => p.username === username);
}

async function refuseSpectator(event, connectionId, action) {
  await postTo(event, connectionId, {
    type: "error",
    reason: "spectator",
    action,
    message: "You are watching this match, not playing in it.",
  });
}

async function onStartGame(event, connectionId, row) {
  const lobbyId = row.lobbyId;
  const lobby = await resolveLobby(lobbyId);
  if (!lobby) {
    await postTo(event, connectionId, {
      type: "error", reason: "room_not_found", action: "start_game",
      message: "That room no longer exists.",
    });
    return;
  }

  const conns = await connectionsInLobby(lobbyId);
  const draft = initialGameState(lobby, lobbyId, conns);
  if (draft.players.length < MIN_PLAYERS) {
    await postTo(event, connectionId, {
      type: "error", reason: "too_few_players", action: "start_game",
      message: `Need at least ${MIN_PLAYERS} connected players to start.`,
    });
    return;
  }

  const existing = await readGameState(lobbyId);
  if (existing && existing.phase !== "lobby" && existing.phase !== "gameover") {
    await postTo(event, connectionId, {
      type: "error", reason: "already_running", action: "start_game",
      message: "A match is already in progress in this room.",
    });
    return;
  }

  let state;
  if (existing) {
    // a finished match is replaced under the lock, so two hosts hitting start
    // at once cannot both seed a match
    const res = await mutateGameState(lobbyId, () => draft);
    if (!res.ok) {
      await postTo(event, connectionId, {
        type: "error", reason: res.reason, action: "start_game",
        message: "Could not start the match, please try again.",
      });
      return;
    }
    state = res.state;
  } else {
    try {
      state = await createGameState(draft);
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") {
        await postTo(event, connectionId, {
          type: "error", reason: "already_running", action: "start_game",
          message: "A match is already in progress in this room.",
        });
        return;
      }
      throw err;
    }
  }

  await broadcastGameState(event, lobbyId, state);
  await systemChat(event, lobbyId, "The match is starting…", "match_starting");
  // arm the countdown deadline; from here the scheduler drives the match
  await rearmPhaseTimer(state, existing?.executionArn);
}

/**
 * submit_answer — only the player the wheel landed on, only before the
 * deadline, only once. Everyone else's submission is silently ignored exactly
 * as room.ts ignores it.
 *
 * Answering early ends the question phase immediately, which is a
 * player-driven transition: the sleeping timer is stopped and re-armed on the
 * new reveal deadline.
 *
 * P2.3 routes DUEL submissions through this same message. One submit path for
 * the client, two rule sets on the server: in `duel` the sender must be one of
 * the two racers, and their answer may leave the phase running (a wrong buzz
 * does not end the race) instead of always ending it.
 */
async function onSubmitAnswer(event, connectionId, row, msg) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error", reason: "not_joined", action: "submit_answer",
      message: "Join the room before doing that.",
    });
    return;
  }
  const answer = String(msg.answer ?? "");
  const before = await readGameState(row.lobbyId);
  if (isSpectator(before, row.username)) {
    await refuseSpectator(event, connectionId, "submit_answer");
    return;
  }
  let phaseMoved = false;
  /** why an answer bounced, so the client can say something true */
  let answerRefusal = null;

  const res = await mutateGameState(row.lobbyId, (s) => {
    const seqBefore = Number(s.phaseSeq ?? 0);
    let next;

    answerRefusal = null;
    if (s.phase === "duel") {
      next = applyDuelAnswer(s, row.username, answer);
      // applyDuelAnswer records why it said no, since only it knows
      if (!next) answerRefusal = s.lastAnswerRefusal ?? "generic";
    } else {
      if (s.phase !== "question" || !s.turn) { answerRefusal = "not-open"; return null; }
      if (s.turn.answering !== row.username) { answerRefusal = "not-your-turn"; return null; }
      if (s.turn.answer !== null && s.turn.answer !== undefined) {
        answerRefusal = "already"; return null;
      }
      // too late — the timer owns it from here
      if (nowMs() > Number(s.phaseEndsAt ?? 0)) { answerRefusal = "too-late"; return null; }
      s.turn.answer = answer;
      s.turn.answeredInMs = nowMs() - Number(s.turn.askedAt ?? nowMs());
      // the answer stays hidden while the last bets come in — room.ts's "last
      // call" pause. If nobody is left to bet, resolve straight through. A
      // CHALLENGE has no open book, so it always takes the second branch.
      next = pendingBettors(s).length > 0 ? enterBetting(s) : enterReveal(s);
    }

    if (!next) return null;
    phaseMoved = Number(next.phaseSeq ?? 0) !== seqBefore;
    return next;
  });

  /*
   * A REFUSED ANSWER IS NOT SILENT ANY MORE.
   *
   * This was `if (!res.ok) return;`, and it is the same defect the betting
   * path had: the button appears dead. Tapping an option and watching nothing
   * happen is indistinguishable from a broken app, and in a duel — where the
   * whole game is how fast you press — it is the worst possible thing to
   * leave unexplained.
   */
  if (!res.ok) {
    await postTo(event, connectionId, {
      type: "answer_denied",
      reason: answerRefusal ?? "generic",
    });
    return;
  }
  await broadcastPhase(event, row.lobbyId, res.state);
  // a duel that is still running kept its deadline, and re-arming a timer that
  // is already asleep on the right instant would only churn executions
  if (phaseMoved) await rearmPhaseTimer(res.state, before?.executionArn);
}

/**
 * place_bet — stake on whether the answering player gets it right.
 *
 * Open from the moment the question appears until the betting pause closes.
 * ONE declaration per player per turn, no raising: the quota is locked when
 * the bet is placed, so allowing a raise would mean either re-pricing an
 * accepted bet or carrying two quotas for one player. Abstaining ("neutral")
 * counts as a declaration but stakes nothing — it is what lets the pause end
 * early once everyone has decided.
 *
 * The stake leaves the player and enters the pot here, not at settlement, so
 * the money is visibly committed and cannot be spent twice.
 */
async function onPlaceBet(event, connectionId, row, msg) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error", reason: "not_joined", action: "place_bet",
      message: "Join the room before doing that.",
    });
    return;
  }
  const side = String(msg.side ?? msg.bet ?? "");
  const before = await readGameState(row.lobbyId);
  if (isSpectator(before, row.username)) {
    await refuseSpectator(event, connectionId, "place_bet");
    return;
  }
  let closedEarly = false;
  /*
   * WHY THE REFUSAL IS NAMED NOW.
   *
   * Every branch below used to `return null`, and the caller answered that
   * with `if (!res.ok) return;` — nothing at all went back to the sender. The
   * client, meanwhile, writes myBet optimistically the instant the button is
   * pressed. So a bet the server threw away still read as PLACED on the
   * screen of the person who made it: no money left their wallet, nothing
   * settled at reveal, and the panel sat there claiming a stake that did not
   * exist. Missing the deadline by a few hundred milliseconds is the ordinary
   * way to hit this, and the clock the client is watching is its own.
   */
  let refusal = null;
  /** what was actually accepted — the clamped figure, not the one requested */
  let placed = null;

  const res = await mutateGameState(row.lobbyId, (s) => {
    refusal = null;
    placed = null;

    if (s.phase !== "question" && s.phase !== "betting") { refusal = "not-open"; return null; }
    if (!s.turn) { refusal = "not-open"; return null; }
    // (a) a CHALLENGE's only bet is the picker's, and it was committed at pick
    // time — the book is closed to everyone, picker included. A DUEL takes no
    // side bets at all: its only stakes are the two antes.
    if (s.turn.mode === "challenge") { refusal = "challenge"; return null; }
    if (nowMs() > Number(s.phaseEndsAt ?? 0)) { refusal = "too-late"; return null; }
    if (!["correct", "wrong", "neutral"].includes(side)) { refusal = "bad-side"; return null; }
    if (s.turn.answering === row.username) { refusal = "self"; return null; }

    s.bets = s.bets ?? [];
    if (s.bets.some((b) => b.username === row.username)) { refusal = "already"; return null; }

    const player = (s.players ?? []).find((p) => p.username === row.username);
    if (!player) { refusal = "not-playing"; return null; }
    if (!player.alive) { refusal = "eliminated"; return null; }

    if (side === "neutral") {
      s.bets.push({ username: row.username, side: "neutral", amount: 0, quota: 0 });
      placed = { side: "neutral", amount: 0, quota: 0 };
    } else {
      if (player.money < MIN_BET) { refusal = "too-poor"; return null; }
      const allIn = msg.amount === "all" || msg.allIn === true;
      const raw = allIn ? player.money : Math.floor(Number(msg.amount) || 0);
      const amount = Math.min(player.money, Math.max(MIN_BET, raw));
      const quota = quotasFor(s)[side];
      player.money -= amount;                          // out of the pocket…
      s.pot = Number(s.pot ?? 0) + amount;             // …and into the pot
      s.bets.push({ username: row.username, side, amount, quota });
      /*
       * The CLAMPED amount, which is not always the requested one: a stake is
       * floored at MIN_BET and capped at the bettor's own bankroll. Asking for
       * more than you hold used to leave the panel showing the figure you
       * typed while the pot held what you actually had.
       */
      placed = { side, amount, quota };
    }

    // last one in during the pause? close it rather than burn the clock
    if (s.phase === "betting" && pendingBettors(s).length === 0) {
      closedEarly = true;
      return enterReveal(s);
    }
    return s;
  });

  if (!res.ok) {
    await postTo(event, connectionId, {
      type: "bet_denied",
      reason: refusal ?? res.reason ?? "generic",
    });
    return;
  }

  /*
   * Privately, to the bettor: what the book actually took. Sent before the
   * broadcast so the person who staked sees their own figure settle first,
   * and separate from `player_bet` because that one goes to the whole table —
   * a stake is nobody else's business until the reveal prices it.
   */
  await postTo(event, connectionId, { type: "bet_accepted", ...placed });
  await broadcast(event, row.lobbyId, {
    type: "player_bet",
    username: row.username,
    betCount: (res.state.bets ?? []).length,
    pot: res.state.pot,
  });
  await broadcastPhase(event, row.lobbyId, res.state);
  if (closedEarly) await rearmPhaseTimer(res.state, before?.executionArn);
}

/**
 * pick_player — the correct answerer chooses WHO faces the next question AND
 * HOW. This is P2.3's whole surface:
 *
 *   { type: "pick_player",
 *     target: "<username>",
 *     mode:   "challenge" | "duel",     // default "challenge"
 *     side:   "correct" | "wrong",      // CHALLENGE only, optional
 *     amount: <number> | "all" }        // CHALLENGE only, with `side`
 *
 * CHALLENGE — the target answers a harder question alone. The picker may back
 * that outcome with their own money, priced off the TARGET's accuracy. The
 * stake is committed HERE, blind: the question is drawn in the same mutation
 * and nobody, picker included, has seen it. Omitting `side` picks a target
 * without wagering, which is exactly P2.1's behaviour plus a difficulty bump.
 *
 * DUEL — picker and target race the same harder question, both anteing.
 * `side`/`amount` are meaningless and ignored: a duel's price is the fixed,
 * symmetric ante, not something the picker sizes.
 *
 * The whole pick — mode, target, question draw, stake, phase change — is ONE
 * mutateGameState, so it is one version bump. There is no instant where the
 * money has left the picker but the question does not exist, and two clicks
 * from a double-tapped button cannot both land: the second finds the phase no
 * longer `picking` and aborts without writing.
 */
async function onPickPlayer(event, connectionId, row, msg) {
  if (!row?.username || !row?.lobbyId) {
    await postTo(event, connectionId, {
      type: "error", reason: "not_joined", action: "pick_player",
      message: "Join the room before doing that.",
    });
    return;
  }
  const target = String(msg.target ?? "");
  // an absent mode is a CHALLENGE with no wager — the P2.1 pick, unchanged for
  // any client that has not learned about modes yet
  const mode = String(msg.mode ?? "challenge").toLowerCase();
  const side = msg.side === undefined || msg.side === null ? null : String(msg.side);
  const pool = await loadQuestionPool();
  const before = await readGameState(row.lobbyId);
  if (isSpectator(before, row.username)) {
    await refuseSpectator(event, connectionId, "pick_player");
    return;
  }

  // set fresh on every attempt — mutateGameState replays the closure on a
  // version conflict, and a stale flag from the losing attempt must not survive
  let denied = null;
  let accepted = null;

  const res = await mutateGameState(row.lobbyId, (s) => {
    denied = null;
    accepted = null;

    if (s.phase !== "picking" || !s.currentPick) { denied = "not_picking"; return null; }
    if (s.currentPick.picker !== row.username) { denied = "not_picker"; return null; }
    if (!(s.currentPick.choices ?? []).includes(target)) { denied = "bad_target"; return null; }
    if (mode !== "challenge" && mode !== "duel") { denied = "bad_mode"; return null; }

    const picker = (s.players ?? []).find((p) => p.username === row.username);
    const victim = (s.players ?? []).find((p) => p.username === target);
    if (!picker?.alive || !victim?.alive) { denied = "bad_target"; return null; }

    // the chain deepens on a pick either way: harder questions, shorter clock
    s.chainDepth = Number(s.chainDepth ?? 0) + 1;

    if (mode === "duel") {
      const next = enterDuel(s, row.username, target, pool);
      accepted = {
        mode: "duel",
        target,
        ante: Number(next.duel?.ante ?? 0),
        bet: null,
        betSkipped:
          next.duel && Number(next.duel.ante) === 0 ? "no_funds_either_side" : null,
      };
      return next;
    }

    enterQuestion(s, target, pool, {
      mode: "challenge",
      picker: row.username,
      difficultyBump: CHALLENGE_DIFFICULTY_BUMP,
    });
    // enterQuestion falls back to the wheel if the target turned out unfit to
    // answer; there is nothing to bet on in that case
    if (s.phase !== "question") {
      accepted = { mode: "challenge", target, bet: null, betSkipped: "target_unavailable" };
      return s;
    }

    accepted = { mode: "challenge", target, bet: null, betSkipped: null };
    if (side === "correct" || side === "wrong") {
      if (picker.money < MIN_BET) {
        // the pick still stands, the wager does not
        accepted.betSkipped = "insufficient_funds";
      } else {
        const allIn = msg.amount === "all" || msg.allIn === true;
        const raw = allIn ? picker.money : Math.floor(Number(msg.amount) || 0);
        const amount = Math.min(picker.money, Math.max(MIN_BET, raw));
        // priced off the TARGET, who is `turn.answering` now that
        // enterQuestion has run, and LOCKED — settlement never re-prices
        const quota = quotasFor(s)[side];
        picker.money -= amount;                      // out of the pocket…
        s.pot = Number(s.pot ?? 0) + amount;         // …and into the pot
        s.bets = s.bets ?? [];
        s.bets.push({ username: row.username, side, amount, quota });
        accepted.bet = { amount, quota };
      }
    } else if (side !== null) {
      accepted.betSkipped = "bad_side";
    }
    return s;
  });

  if (!res.ok) {
    await postTo(event, connectionId, {
      type: "error",
      reason: denied ?? res.reason,
      action: "pick_player",
      message:
        denied === "not_picker" ? "It is not your pick."
        : denied === "bad_target" ? "That player cannot be picked right now."
        : denied === "bad_mode" ? 'Mode must be "challenge" or "duel".'
        : denied === "not_picking" ? "The picking phase is over."
        : "Could not register that pick, please try again.",
    });
    return;
  }

  // the picker gets a private receipt — what was staked, at what price, and
  // whether any part of the request was dropped
  await postTo(event, connectionId, { type: "pick_accepted", ...accepted });
  await broadcastPhase(event, row.lobbyId, res.state);
  await rearmPhaseTimer(res.state, before?.executionArn);
}

export {
  onPickPlayer,
  onPlaceBet,
  onStartGame,
  onSubmitAnswer,
};
