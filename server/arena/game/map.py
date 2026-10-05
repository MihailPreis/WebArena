import json
import math
from dataclasses import dataclass
from functools import cache
from typing import Any

from arena.game.items import ITEM_TYPES
from arena.shared import SHARED_DIR

Vec3 = tuple[float, float, float]


@dataclass(frozen=True)
class Block:
    min: Vec3
    max: Vec3
    material: str


@dataclass(frozen=True)
class Spawn:
    position: Vec3
    yaw: float
    """Radians; 0 looks along -z."""


@dataclass(frozen=True)
class Item:
    type: str
    """A key of `items.types` in shared/constants.json."""
    position: Vec3
    """The point on the floor the item hovers over."""


# Clients are told which items are present as bits of one number.
MAX_ITEMS = 30


@dataclass(frozen=True)
class GameMap:
    name: str
    kill_y: float
    blocks: tuple[Block, ...]
    spawns: tuple[Spawn, ...]
    items: tuple[Item, ...] = ()


def _vec3(value: Any, where: str) -> Vec3:
    if (
        not isinstance(value, list)
        or len(value) != 3
        or not all(isinstance(n, int | float) and math.isfinite(n) for n in value)
    ):
        raise ValueError(f"{where}: expected [x, y, z]")
    return (float(value[0]), float(value[1]), float(value[2]))


def parse_map(raw: Any) -> GameMap:
    """Validates raw map JSON (see shared/README.md). Mirrors `parseMap` on the client."""
    blocks = []
    for i, block in enumerate(raw["blocks"]):
        lo = _vec3(block["min"], f"map.blocks[{i}].min")
        hi = _vec3(block["max"], f"map.blocks[{i}].max")
        if any(a >= b for a, b in zip(lo, hi, strict=True)):
            raise ValueError(f"map.blocks[{i}]: min must be below max on every axis")
        blocks.append(Block(lo, hi, str(block["material"])))
    spawns = [
        Spawn(
            _vec3(spawn["position"], f"map.spawns[{i}].position"),
            spawn["yawDeg"] * math.pi / 180,
        )
        for i, spawn in enumerate(raw["spawns"])
    ]
    if not spawns:
        raise ValueError("map.spawns: expected a non-empty array")
    items = []
    for i, item in enumerate(raw.get("items", [])):
        if item["type"] not in ITEM_TYPES:
            raise ValueError(f"map.items[{i}].type: unknown item {item['type']!r}")
        items.append(Item(item["type"], _vec3(item["position"], f"map.items[{i}].position")))
    if len(items) > MAX_ITEMS:
        raise ValueError(f"map.items: at most {MAX_ITEMS} items")
    return GameMap(
        str(raw["name"]), float(raw["killY"]), tuple(blocks), tuple(spawns), tuple(items)
    )


@cache
def load_map(name: str) -> GameMap:
    path = SHARED_DIR / "maps" / f"{name}.json"
    return parse_map(json.loads(path.read_text(encoding="utf-8")))
