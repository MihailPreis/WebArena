"""Mirror of client/src/game/sim/collision.ts. Change both together."""

from collections.abc import Sequence

from arena.game.map import Block

EPSILON = 1e-4


def sweep_axis(
    blocks: Sequence[Block],
    lo: Sequence[float],
    hi: Sequence[float],
    axis: int,
    delta: float,
) -> float:
    """Sweeps the box [lo, hi] along one axis and returns how far it can travel
    before touching a block (same sign as `delta`, never larger in magnitude).
    Blocks the box already penetrates along that axis are ignored, so a box that
    ends up a rounding error inside a wall can still slide along it.
    """
    if delta == 0:
        return 0.0
    a1 = (axis + 1) % 3
    a2 = (axis + 2) % 3
    lo1, hi1, lo2, hi2 = lo[a1], hi[a1], lo[a2], hi[a2]
    allowed = delta
    for block in blocks:
        bmin, bmax = block.min, block.max
        if bmax[a1] <= lo1 or bmin[a1] >= hi1 or bmax[a2] <= lo2 or bmin[a2] >= hi2:
            continue
        if delta > 0:
            gap = bmin[axis] - hi[axis]
            if gap >= -EPSILON and gap < allowed:
                allowed = max(gap, 0.0)
        else:
            gap = bmax[axis] - lo[axis]
            if gap <= EPSILON and gap > allowed:
                allowed = min(gap, 0.0)
    return allowed


def overlaps_any(blocks: Sequence[Block], lo: Sequence[float], hi: Sequence[float]) -> bool:
    """True if the box [lo, hi] overlaps any block by more than a rounding error."""
    return any(
        block.max[0] > lo[0] + EPSILON
        and block.min[0] < hi[0] - EPSILON
        and block.max[1] > lo[1] + EPSILON
        and block.min[1] < hi[1] - EPSILON
        and block.max[2] > lo[2] + EPSILON
        and block.min[2] < hi[2] - EPSILON
        for block in blocks
    )
