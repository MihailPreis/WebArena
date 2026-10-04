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
