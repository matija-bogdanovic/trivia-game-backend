/**
 * ===========================================================================
 * lib/succession.mjs — who gets the room when the host walks out
 * ===========================================================================
 * A room used to die with its host. That was a deliberate choice and it is
 * documented as one, but it costs everyone else their game: four people in a
 * lobby lose it because the fifth closed a tab.
 *
 * So the room is inherited instead — by the LONGEST-PRESENT remaining player,
 * from the `joinedAt` stamped on each roster seat. That is the fairest answer
 * available and the only one that needs no vote, no ping and no round trip.
 *
 * ── WHY THIS IS SAFE WHERE THE OLD reassignHost WAS NOT ────────────────────
 * presence.mjs used to carry a fallback that handed the host flag to the
 * longest-connected player whenever the Admin was away, and it was removed for
 * good reasons: it was computed AT RENDER TIME from live sockets, so the flag
 * moved as tabs opened and closed, two players could hold it at once, and it
 * disagreed with requireHost() — which reads the roster — so the client drew a
 * start button the server then refused.
 *
 * This is the opposite shape. It is a DURABLE WRITE to the roster, made once,
 * at the moment of departure. Afterwards `isHost` and `requireHost` are both
 * reading the same promoted seat, so they cannot disagree, and nothing moves
 * again until somebody else leaves.
 *
 * ── ORDERING, INCLUDING FOR ROOMS THAT PREDATE joinedAt ────────────────────
 * Seats written before the field existed have none. Those fall back to their
 * POSITION in the roster, which is join order anyway: createRoom writes the
 * host first and joinRoom list_appends every arrival. So an old room still
 * inherits sensibly rather than picking arbitrarily.
 * ===========================================================================
 */

/**
 * The seat that should hold the room once `leaving` is gone.
 *
 * Returns null when nobody is left — the caller closes the room instead.
 */
function heirOf(players, leaving) {
  const remaining = (Array.isArray(players) ? players : [])
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => String(seat?.player) !== String(leaving));

  if (remaining.length === 0) return null;

  remaining.sort((a, b) => {
    const at = Number(a.seat?.joinedAt);
    const bt = Number(b.seat?.joinedAt);
    const aHas = Number.isFinite(at);
    const bHas = Number.isFinite(bt);
    // a seat with a timestamp always outranks one without: the missing ones
    // are older rows, and guessing their position against a real clock would
    // be comparing two different things
    if (aHas && bHas) return at - bt || a.index - b.index;
    if (aHas) return -1;
    if (bHas) return 1;
    return a.index - b.index;
  });

  return remaining[0].seat;
}

/**
 * The roster as it should be after `leaving` goes: their seat removed, and the
 * heir promoted to Admin.
 *
 * Returns null when the room should be closed instead. Every other seat is
 * copied through untouched — points, id and joinedAt all survive, because a
 * change of host is not a change of anybody's standing.
 */
function rosterAfterLeaving(players, leaving) {
  const heir = heirOf(players, leaving);
  if (!heir) return null;

  return (Array.isArray(players) ? players : [])
    .filter((seat) => String(seat?.player) !== String(leaving))
    .map((seat) =>
      String(seat?.player) === String(heir.player)
        ? { ...seat, role: "Admin" }
        : // anyone who was Admin and is not the heir is demoted. That can only
          // happen to a roster that already held two, which nothing writes —
          // but a succession function that can produce two hosts is worse than
          // one line guarding against it
          seat?.role === "Admin"
          ? { ...seat, role: "Member" }
          : seat
    );
}

export { heirOf, rosterAfterLeaving };
