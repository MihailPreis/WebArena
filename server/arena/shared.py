"""Data shared with the client: the single source of physics, balance and limits."""

import json
import os
from pathlib import Path
from typing import Any

from arena.config import REPO_ROOT

SHARED_DIR = Path(os.environ.get("ARENA_SHARED_DIR", REPO_ROOT / "shared"))

CONSTANTS: dict[str, Any] = json.loads((SHARED_DIR / "constants.json").read_text(encoding="utf-8"))
PROFILE: dict[str, Any] = CONSTANTS["profile"]
ROOM: dict[str, Any] = CONSTANTS["room"]

MAPS: tuple[str, ...] = tuple(ROOM["maps"])
# Small maps for quick testing; offered only when the server runs with ARENA_DEV_MAPS=1.
DEV_MAPS: tuple[str, ...] = tuple(ROOM["devMaps"])
DEFAULT_MAP: str = MAPS[0]


def allowed_maps(dev: bool) -> tuple[str, ...]:
    """Maps a room may be played on."""
    return MAPS + DEV_MAPS if dev else MAPS
