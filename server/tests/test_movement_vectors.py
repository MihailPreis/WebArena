"""Replays shared/movement_vectors.json, which the client produced and also checks.

If this fails after a deliberate change to movement, update both implementations
and regenerate the file with `make vectors`.
"""

import json
import math
from typing import Any

import pytest

from arena.game.map import Spawn, load_map
from arena.game.movement import TICK_DT, InputCmd, create_player, step_player
from arena.shared import SHARED_DIR

TOLERANCE = 1e-9

VECTORS = json.loads((SHARED_DIR / "movement_vectors.json").read_text(encoding="utf-8"))


def radians(degrees: float) -> float:
    return degrees * math.pi / 180


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda case: case["name"])
def test_movement_matches_client(case: dict[str, Any]) -> None:
    game_map = load_map(VECTORS["map"])
    x, y, z = case["start"]["pos"]
    state = create_player(Spawn((x, y, z), radians(case["start"]["yawDeg"])))
    assert len(case["expect"]) == len(case["segments"])
    for i, (segment, want) in enumerate(zip(case["segments"], case["expect"], strict=True)):
        raw = segment["cmd"]
        cmd = InputCmd(
            forward=raw["forward"],
            right=raw["right"],
            jump=raw["jump"],
            crouch=raw["crouch"],
            sprint=raw["sprint"],
            yaw=radians(raw["yawDeg"]),
            pitch=raw["pitch"],
        )
        for _ in range(segment["ticks"]):
            state = step_player(state, cmd, game_map, TICK_DT)
        assert state.on_ground == want["onGround"], f"segment {i}"
        assert state.crouched == want["crouched"], f"segment {i}"
        assert state.pos == pytest.approx(want["pos"], abs=TOLERANCE), f"segment {i} pos"
        assert state.vel == pytest.approx(want["vel"], abs=TOLERANCE), f"segment {i} vel"
