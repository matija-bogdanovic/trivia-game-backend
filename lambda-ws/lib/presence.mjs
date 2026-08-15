/**
 * ===========================================================================
 * lib/presence.mjs — lobby_state — who is seated and who is connected
 * ===========================================================================
 * Part of the ipakseokrece WebSocket Lambda. Split out of the single-file
 * index.mjs with NO behaviour change: every line below is the original line.
 * Deployed as a multi-file zip — see lambda-ws/README.md.
 */

import { MIN_PLAYERS, capacityOf, startingMoneyOf } from "./config.mjs";
import { broadcast, connectionsInLobby } from "./connections.mjs";
import { resolveLobby } from "./lobbies.mjs";

// ─── presence ──────────────────────────────────────────────────────────────
/**
 * The `lobby_state` the frontend renders, rebuilt from durable state on every
 * change. Two sources, merged the way GameRoom merges them in memory:
 *
 *   Lobbies.players  — the seat roster and who is Admin (host)
 *   Connections      — who is actually holding a socket right now
 *
 * A connected player who is not on the roster is still shown: in `lobby` phase
 * GameRoom.addPlayer() seats them rather than making them a spectator, and
 * Phase 0 is always in `lobby` phase because there is no turn engine yet.
 */
async function lobbyStateMessage(lobby, lobbyId) {
  const startingMoney = startingMoneyOf(lobby);
  const live = await connectionsInLobby(lobbyId);
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
    players.push({
      username,
      displayName: conn?.displayName || username,
      avatar: conn?.avatar ?? null,
      money: Number(seat.points ?? startingMoney),
      alive: true, // phase is always "lobby" in Phase 0
      connected: Boolean(conn),
      isHost: seat.role === "Admin",
      streak: Number(conn?.streak ?? 0),
      isSpectator: false,
    });
  }

  // connected but not on the roster (joined the socket without the REST join)
  for (const [username, conn] of byUsername) {
    if (seen.has(username)) continue;
    players.push({
      username,
      displayName: conn.displayName || username,
      avatar: conn.avatar ?? null,
      money: startingMoney,
      alive: true,
      connected: true,
      isHost: false,
      streak: Number(conn.streak ?? 0),
      isSpectator: false,
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

/** rebuild presence and push it to everyone still in the lobby */
async function broadcastLobbyState(event, lobbyId) {
  const lobby = await resolveLobby(lobbyId);
  const message = await lobbyStateMessage(lobby, lobbyId);
  await broadcast(event, lobbyId, message);
}

export {
  broadcastLobbyState,
  lobbyStateMessage,
};
