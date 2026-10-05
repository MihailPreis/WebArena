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


@dataclass(frozen=True)
class JumpPad:
    """A volume that throws whoever touches it."""

    min: Vec3
    max: Vec3
    velocity: Vec3
    """The velocity the player leaves with, in metres per second."""


@dataclass(frozen=True)
class Teleporter:
    """A volume that moves whoever touches it somewhere else."""

    min: Vec3
    max: Vec3
    to: Vec3
    """Where the player's feet end up."""
    yaw: float
    """Radians; the way the player faces and keeps moving on arrival."""
    direction: Vec3
    """Unit vector of `yaw`."""


# Clients are told which items are present as bits of one number.
MAX_ITEMS = 30


@dataclass(frozen=True)
class GameMap:
    name: str
    kill_y: float
    blocks: tuple[Block, ...]
    spawns: tuple[Spawn, ...]
    items: tuple[Item, ...] = ()
    pads: tuple[JumpPad, ...] = ()
    teleporters: tuple[Teleporter, ...] = ()


def _vec3(value: Any, where: str) -> Vec3:
    if (
        not isinstance(value, list)
        or len(value) != 3
        or not all(isinstance(n, int | float) and math.isfinite(n) for n in value)
    ):
        raise ValueError(f"{where}: expected [x, y, z]")
    return (float(value[0]), float(value[1]), float(value[2]))


def _box(raw: Any, where: str) -> tuple[Vec3, Vec3]:
    lo = _vec3(raw["min"], f"{where}.min")
    hi = _vec3(raw["max"], f"{where}.max")
    if any(a >= b for a, b in zip(lo, hi, strict=True)):
        raise ValueError(f"{where}: min must be below max on every axis")
    return lo, hi


def parse_map(raw: Any) -> GameMap:
    """Validates raw map JSON (see shared/README.md). Mirrors `parseMap` on the client."""
    blocks = []
    for i, block in enumerate(raw["blocks"]):
        lo, hi = _box(block, f"map.blocks[{i}]")
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
    pads = []
    for i, pad in enumerate(raw.get("jumpPads", [])):
        where = f"map.jumpPads[{i}]"
        lo, hi = _box(pad, where)
        pads.append(JumpPad(lo, hi, _vec3(pad["velocity"], f"{where}.velocity")))
    teleporters = []
    for i, gate in enumerate(raw.get("teleporters", [])):
        where = f"map.teleporters[{i}]"
        lo, hi = _box(gate, where)
        yaw = gate["yawDeg"] * math.pi / 180
        teleporters.append(
            Teleporter(
                lo, hi, _vec3(gate["to"], f"{where}.to"), yaw, (-math.sin(yaw), 0.0, -math.cos(yaw))
            )
        )
    return GameMap(
        str(raw["name"]),
        float(raw["killY"]),
        tuple(blocks),
        tuple(spawns),
        tuple(items),
        tuple(pads),
        tuple(teleporters),
    )


@cache
def load_map(name: str) -> GameMap:
    path = SHARED_DIR / "maps" / f"{name}.json"
    return parse_map(json.loads(path.read_text(encoding="utf-8")))
