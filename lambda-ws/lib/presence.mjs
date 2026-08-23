/**
 * ===========================================================================
 * lib/presence.mjs — lobby_state — who is seated and who is connected
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { MIN_PLAYERS, capacityOf, startingMoneyOf } from "./config.mjs";
import { postTo, broadcast, connectionsInLobby } from "./connections.mjs";
import { resolveLobby } from "./lobbies.mjs";
import { readGameState } from "./state.mjs";

// ─── presence ──────────────────────────────────────────────────────────────
/**
 * The `lobby_state` the frontend renders, rebuilt from durable state on every
 * change. Two sources, merged the way GameRoom merges them in memory:
 *
 *   Lobbies.players  — the seat roster and who is Admin (host)
 *   Connections      — who is actually holding a socket right now
 *
 * A connected player who is not on the roster is still shown.
 *
 * ── SPECTATORS ─────────────────────────────────────────────────────────────
 * `isSpectator` was hardcoded false here, with a note saying the phase was
 * always "lobby" because there was no turn engine. There is one now, so the
 * flag can be what it always meant: a match is running and this person is not
 * in it.
 *
 * That is the whole definition, and it needs no stored field. The match
 * roster is fixed when the host starts — initialGameState() takes the seats
 * that were connected at that moment — so anyone holding a socket on this
 * lobby who is NOT in `state.players` arrived too late to play. They are
 * watching, and every action path already refuses them for the same reason
 * (see the note in handlers/game.mjs).
 *
 * `alive` follows the match too. It used to be hardcoded true on the same
 * stale reasoning, which meant a player who had been knocked out still read
 * as alive in lobby_state.
 */
/**
 * @param justJoined a connection row that MUST be treated as present even if
 *   the lobby-index has not caught up with it yet — see the note on
 *   broadcastLobbyState.
 */
async function lobbyStateMessage(lobby, lobbyId, justJoined = null) {
  const startingMoney = startingMoneyOf(lobby);
  const indexed = await connectionsInLobby(lobbyId);

  /*
   * ── WHY A ROW IS HANDED IN RATHER THAN LOOKED UP ─────────────────────────
   * connectionsInLobby reads the lobby-index GSI, and a GSI is EVENTUALLY
   * CONSISTENT — DynamoDB does not offer ConsistentRead on one. `join` writes
   * the connection row and queries that index microseconds later, which is
   * exactly the window where the write has not propagated.
   *
   * So the joiner was routinely absent from their own join: missing from
   * `live`, which made their seat render connected:false to everybody else,
   * and missing from the fan-out list, so they received nothing at all. Both
   * halves of "the seats do not update when somebody joins".
   *
   * The caller already HAS the row it just wrote. Merging it in is the fix,
   * and it costs nothing when the index is current — the dedup below keeps
   * the newest of the two copies.
   */
  const live = justJoined
    ? [...indexed.filter((r) => r.connectionId !== justJoined.connectionId), justJoined]
    : indexed;

  /*
   * A finished match leaves its state behind so the results screen survives a
   * reload, but it is not a match in progress — nobody is spectating a game
   * that is over, and the next start_game reseats everyone from the roster.
   */
  const running = await readGameState(lobbyId);
  const inPlay = running && running.phase !== "gameover" ? running : null;
  const seatedInMatch = new Map(
    (inPlay?.players ?? []).map((p) => [p.username, p])
  );
  /** a match is running and this person is not in it */
  const spectates = (username) => Boolean(inPlay) && !seatedInMatch.has(username);
  const byUsername = new Map();
  for (const row of live) {
    if (!row.username) continue; // connected but not yet joined
    const existing = byUsername.get(row.username);
    // a reconnect can briefly leave two rows; the newest wins
    if (!existing || (row.joinedAt ?? 0) > (existing.joinedAt ?? 0)) {
      byUsername.set(row.username, row);
    }
  }

  const roster = Array.isArray(lobby?.players) ? lobby.players : [];
  const seen = new Set();
  const players = [];

  for (const seat of roster) {
    const username = String(seat.player);
    if (seen.has(username)) continue;
    seen.add(username);
    const conn = byUsername.get(username);
    const inMatch = seatedInMatch.get(username);
    players.push({
      username,
      displayName: conn?.displayName || username,
      avatar: conn?.avatar ?? null,
      money: inMatch ? Number(inMatch.money ?? 0) : Number(seat.points ?? startingMoney),
      // the match is the authority while one is running; the roster seat is
      // only what to show before it starts
      alive: inMatch ? Boolean(inMatch.alive) : true,
      connected: Boolean(conn),
      isHost: seat.role === "Admin",
      streak: Number(conn?.streak ?? 0),
      isSpectator: spectates(username),
    });
  }

  // connected but not on the roster (joined the socket without the REST join)
  for (const [username, conn] of byUsername) {
    if (seen.has(username)) continue;
    const inMatch = seatedInMatch.get(username);
    players.push({
      username,
      displayName: conn.displayName || username,
      avatar: conn.avatar ?? null,
      money: inMatch ? Number(inMatch.money ?? 0) : startingMoney,
      alive: inMatch ? Boolean(inMatch.alive) : true,
      connected: true,
      isHost: false,
      streak: Number(conn.streak ?? 0),
      isSpectator: spectates(username),
    });
  }

  // NO STAND-IN HOST. `isHost` above comes from the Lobbies roster and
  // nothing promotes a connected player on top of it, so this flag and
  // requireHost() read the same source and cannot disagree.
  //
  // There used to be a reassignHost fallback here that handed the flag to the
  // longest-present connected player whenever the Admin was away, so a lobby
  // was never left without a start button. Harmless while nothing enforced
  // host-ness — but once start_game became host-only it started rendering a
  // start button for someone the server then refused with not_host. It was
  // also volatile (the flag moved as sockets opened and closed) and could
  // report two isHost players at once. Showing no start button while the host
  // is away is the honest state: that is exactly who is allowed to press it.

  return {
    type: "lobby_state",
    phase: "lobby",
    roomName: lobby?.roomName ?? `Room ${lobby?.code ?? ""}`.trim(),
    code: Number(lobby?.code ?? 0),
    isPrivate: Boolean(lobby?.isPrivate),
    minPlayers: MIN_PLAYERS,
    // the room's own capacity, not the global cap. Rooms written before
    // maxPlayers existed fall back to 6, which is what they were created under.
    maxPlayers: capacityOf(lobby),
    // what a seat is worth when this room starts — same source the match is
    // seeded from, so the lobby preview cannot promise a different number
    startingMoney,
    round: 0,
    players,
  };
}

/**
 * Rebuild presence and push it to everyone still in the lobby.
 *
 * `justJoined` is the connection row the caller has just written. It is used
 * twice: once so the message DESCRIBES that player as present, and once so the
 * message REACHES them — broadcast() fans out over the same eventually
 * consistent index, so a socket the GSI has not seen yet would otherwise be
 * skipped by its own join.
 *
 * postTo is called separately for it, and broadcast is told to skip it, so
 * nobody receives the state twice.
 */
async function broadcastLobbyState(event, lobbyId, justJoined = null) {
  const lobby = await resolveLobby(lobbyId);
  const message = await lobbyStateMessage(lobby, lobbyId, justJoined);
  if (justJoined?.connectionId) {
    await postTo(event, justJoined.connectionId, message);
    await broadcast(event, lobbyId, message, justJoined.connectionId);
    return;
  }
  await broadcast(event, lobbyId, message);
}

export {
  broadcastLobbyState,
  lobbyStateMessage,
};
