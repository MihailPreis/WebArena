"""Builds the maps in shared/maps/ that are too big to write by hand.

    uv run python scripts/build_maps.py

Every map here is symmetric about its centre: whatever is listed for one half is
repeated on the other, turned half a circle. That keeps the two sides of a team
match equal. Things that belong to the centre itself are listed separately.

The format of the result is described in shared/README.md. `arena.json` is
written by hand and is not touched.
"""

import json
import math
from pathlib import Path
from typing import Any

from arena.shared import CONSTANTS, SHARED_DIR

GRAVITY: float = CONSTANTS["movement"]["gravity"]
STEP = 0.25
"""Rise of one stair; lower than the height a player steps up without jumping."""

Thing = dict[str, Any]


def block(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float, material: str) -> Thing:
    return {"min": [x0, y0, z0], "max": [x1, y1, z1], "material": material}


def stairs(
    axis: str, start: float, end: float, lo: float, hi: float, y0: float, y1: float, material: str
) -> list[Thing]:
    """Solid steps rising from `y0` at `start` to `y1` at `end` along `axis` ("x" or "z"),
    `lo` to `hi` wide on the other axis.
    """
    count = round((y1 - y0) / STEP)
    depth = (end - start) / count
    steps = []
    for i in range(count):
        a, b = sorted((start + i * depth, start + (i + 1) * depth))
        top = y0 + (i + 1) * STEP
        if axis == "x":
            steps.append(block(a, y0, lo, b, top, hi, material))
        else:
            steps.append(block(lo, y0, a, hi, top, b, material))
    return steps


def facing(x: float, z: float, tx: float = 0.0, tz: float = 0.0) -> float:
    """Yaw in degrees of someone at (x, z) looking at (tx, tz). Yaw 0 looks along -z."""
    return round(math.degrees(math.atan2(x - tx, z - tz)), 1)


def spawn(x: float, y: float, z: float, yaw: float | None = None) -> Thing:
    return {"position": [x, y, z], "yawDeg": facing(x, z) if yaw is None else yaw}


def item(kind: str, x: float, y: float, z: float) -> Thing:
    return {"type": kind, "position": [x, y, z]}


def prop(kind: str, x: float, y: float, z: float, yaw: float = 0) -> Thing:
    return {"type": kind, "position": [x, y, z], "yawDeg": yaw}


def pad(x: float, y: float, z: float, to: tuple[float, float, float], rise: float = 1.5) -> Thing:
    """A jump pad 1.5 m square at (x, y, z) that lands the player at `to`, peaking
    `rise` metres above the higher of the two ends.
    """
    apex = max(y, to[1]) + rise
    up = math.sqrt(2 * GRAVITY * (apex - y))
    time = up / GRAVITY + math.sqrt(2 * (apex - to[1]) / GRAVITY)
    velocity = [round((to[0] - x) / time, 3), round(up, 3), round((to[2] - z) / time, 3)]
    return {
        "min": [x - 0.75, y, z - 0.75],
        "max": [x + 0.75, y + 0.3, z + 0.75],
        "velocity": velocity,
    }


def teleporter(x: float, y: float, z: float, to: tuple[float, float, float], yaw: float) -> Thing:
    """A gate 1 m square and 2 m high at (x, y, z) that leads to `to`."""
    return {
        "min": [x - 0.5, y, z - 0.5],
        "max": [x + 0.5, y + 2, z + 0.5],
        "to": list(to),
        "yawDeg": yaw,
    }


def _turn(vector: list[float]) -> list[float]:
    # `+ 0.0` turns the -0.0 of a negated zero back into 0.0.
    return [-vector[0] + 0.0, vector[1], -vector[2] + 0.0]


def turned(thing: Thing) -> Thing:
    """The same thing on the other side of the map: turned half a circle about the centre."""
    twin = dict(thing)
    if "min" in thing:
        a, b = _turn(thing["min"]), _turn(thing["max"])
        twin["min"] = [b[0], thing["min"][1], b[2]]
        twin["max"] = [a[0], thing["max"][1], a[2]]
    for key in ("position", "to", "velocity"):
        if key in thing:
            twin[key] = _turn(thing[key])
    if "yawDeg" in thing:
        twin["yawDeg"] = round((thing["yawDeg"] + 180) % 360, 1)
    return twin


def both(things: list[Thing]) -> list[Thing]:
    return [*things, *(turned(thing) for thing in things)]


def game_map(
    name: str, kill_y: float, half: dict[str, list[Thing]], centre: dict[str, list[Thing]]
):
    keys = ("blocks", "spawns", "items", "jumpPads", "teleporters", "props")
    return {
        "name": name,
        "killY": kill_y,
        **{key: [*centre.get(key, []), *both(half.get(key, []))] for key in keys},
    }


def yard() -> Thing:
    """Platforms hanging in the void, after The Longest Yard: long sight lines, jump
    pads to the rail platforms and to the booster, and a fall for the careless.
    """
    centre = {
        "blocks": [
            block(-13, -1, -9, 13, 0, 9, "metal"),
            # The slab over the middle: the booster is on top, shelter underneath.
            block(-2.5, 4.5, -2.5, 2.5, 5, 2.5, "stone"),
        ],
        "items": [item("quad", 0, 5, 0), item("health_large", 0, 0, 0)],
        "props": [prop("lamp", 2, 5, 2), prop("lamp", -2, 5, -2)],
    }
    half = {
        "blocks": [
            # Two bridges to the south deck.
            block(-7, -1, 9, -4.5, 0, 17, "metal"),
            block(4.5, -1, 9, 7, 0, 17, "metal"),
            # The south deck: a back wall, a screen in the middle and crates.
            block(-12, -1, 17, 12, 0, 31, "floor"),
            block(-12, 0, 30.5, 6, 3, 31, "stone"),
            block(-12, 0, 17, -11.5, 1.2, 23, "stone"),
            block(-3, 0, 23, 3, 2.5, 23.5, "stone"),
            block(-8, 0, 20, -7.5, 2.5, 25, "stone"),
            block(6, 0, 24, 7.5, 1.5, 25.5, "crate"),
            block(7.5, 0, 24, 8.5, 1, 25, "crate"),
            block(-5, 0, 27, -3.5, 1.5, 28.5, "crate"),
            # Cover on the main deck.
            block(5, 0, -7, 6.5, 1.5, -5.5, "crate"),
            block(6.5, 0, -7, 7.5, 1, -6, "crate"),
            block(-9, 0, 2, -8.5, 2, 6, "stone"),
            block(-4.5, 0, -6.5, -4, 2, -3.5, "stone"),
            block(8, 0, 4, 11, 1.2, 4.5, "stone"),
            block(9.5, 0, -3, 10.5, 2.5, -2, "metal"),
            # The east platform, where the railgun is, with parapets.
            block(20, 2.5, -5, 28, 3, 5, "metal"),
            block(27.5, 3, -5, 28, 4, 5, "stone"),
            block(20, 3, 4.5, 23, 4, 5, "stone"),
            block(24, 3, -2, 25, 4.2, -1, "crate"),
            # The south-east platform, off the deck's side, and the bridge to it.
            block(12, -1, 19, 16, 0, 21, "metal"),
            block(16, -1, 12, 24, 0, 22, "floor"),
            block(18, 0, 16, 19.5, 1.5, 17.5, "crate"),
            block(23.5, 0, 12, 24, 1.2, 18, "stone"),
        ],
        "spawns": [
            spawn(-10, 0, 19),
            spawn(8, 0, 29),
            spawn(-11.5, 0, 7),
            spawn(-11, 0, -7.5),
            spawn(21.5, 0, 20.5),
        ],
        "items": [
            item("rocketlauncher", 0, 0, 27),
            item("rockets", -9.5, 0, 28),
            item("railgun", 25.5, 3, 1.5),
            item("slugs", 26, 3, -2),
            item("armor", 21, 0, 18.5),
            item("shotgun", -6, 0, -3),
            item("shells", -10.5, 0, 0),
            item("bullets", 9, 0, 19),
            item("bullets", 2, 0, -7.5),
            item("health", -5.75, 0, 13),
            item("health", 0, 0, 21),
            item("health", 11, 0, 7),
            item("health", 17.5, 0, 13.5),
        ],
        "jumpPads": [
            pad(12, 0, 0, (22, 3, 0)),
            pad(0, 0, 5.5, (0, 5, 1.4)),
            # From the south-east platform up to the rail platform.
            pad(21, 0, 13.5, (24, 3, 3)),
        ],
        "teleporters": [
            # From the back of the south deck up to the west platform.
            teleporter(10.5, 0, 29.5, (-24, 3, 0), -90),
        ],
        "props": [
            prop("barrel", -11, 0, 29.6),
            prop("barrel", -10.2, 0, 29.7, 30),
            prop("barrel", 4.5, 0, 29.6),
            prop("boxes", 2, 0, 19, 20),
            prop("boxes", -6.5, 0, 22, 70),
            prop("cone", -6.6, 0, 16.2),
            prop("cone", -4.9, 0, 16.2),
            prop("cone", 4.9, 0, 16.2),
            prop("cone", 6.6, 0, 16.2),
            prop("monitor", 27, 3, -4, 90),
            prop("barrel", 21, 3, 3.8),
            prop("chair", -11, 0, -3, 140),
            prop("bottles", 5.75, 1.5, -6.25, 30),
            prop("plant", 9, 0, 8.3),
            prop("lamp", -12.3, 0, 8.3),
            prop("boxes", 22.7, 0, 15.5, 15),
            prop("barrel", 16.8, 0, 21.2),
        ],
    }
    return game_map("yard", -12, half, centre)


def grounds() -> Thing:
    """A hall on two levels, after The Camping Grounds: galleries along the long walls,
    a bridge between them over the middle, and a floor cut into lanes and rooms.
    """
    centre = {
        "blocks": [
            block(-37, -1, -27, 37, 0, 27, "floor"),
            # The bridge between the galleries; the booster lies in the middle of it.
            block(-2, 2.75, -20, 2, 3, 20, "metal"),
            block(-2, 0, -1, -1.5, 2.75, 1, "stone"),
            block(1.5, 0, -1, 2, 2.75, 1, "stone"),
        ],
        "items": [item("quad", 0, 3, 0), item("armor_heavy", 0, 0, 0)],
    }
    half = {
        "blocks": [
            # Outer walls: the south one and the west one.
            block(-37, 0, 26, 37, 8, 27, "wall"),
            block(-37, 0, -26, -36, 8, 26, "wall"),
            # The south gallery on its pillars, and the stairs up to its west end.
            block(-36, 2.75, 20, 30, 3, 26, "stone"),
            block(-25, 0, 20, -24, 2.75, 21, "stone"),
            block(-13, 0, 20, -12, 2.75, 21, "stone"),
            block(-1, 0, 20, 1, 2.75, 21, "stone"),
            block(12, 0, 20, 13, 2.75, 21, "stone"),
            block(29, 0, 20, 30, 2.75, 21, "stone"),
            *stairs("z", 14, 20, -36, -33, 0, 3, "stone"),
            # Parapets and crates on the gallery.
            block(-28, 3, 20, -16, 3.9, 20.4, "stone"),
            block(-10, 3, 20, -4, 3.9, 20.4, "stone"),
            block(6, 3, 20, 18, 3.9, 20.4, "stone"),
            block(-22, 3, 23.5, -20.5, 4.5, 25, "crate"),
            block(20, 3, 22, 21.5, 4.5, 23.5, "crate"),
            # The wall that makes a lane of the space under the gallery, with three doorways.
            block(-30, 0, 13, -22, 3.5, 14, "wall"),
            block(-17, 0, 13, -6, 3.5, 14, "wall"),
            block(6, 0, 13, 16, 3.5, 14, "wall"),
            block(21, 0, 13, 27, 3.5, 14, "wall"),
            # The west room.
            block(-27, 0, -9, -26, 3.5, 3, "wall"),
            block(-27, 0, 7, -26, 3.5, 13, "wall"),
            block(-26, 0, -9, -17, 3.5, -8, "wall"),
            block(-31, 0, 2, -29.5, 1.5, 3.5, "crate"),
            # Walls and pillars that break up the hall.
            block(-14, 0, -3, -13, 3.5, 7, "wall"),
            block(8, 0, -6, 13, 3.5, -5, "wall"),
            block(20, 0, -7, 21.5, 3.5, -5.5, "stone"),
            # Low cover: crates and walls to crouch behind.
            block(8, 0, -3, 10, 2, -1, "crate"),
            block(10, 0, -3, 11.5, 1, -1.5, "crate"),
            block(4, 0, 7, 9, 1.2, 7.5, "stone"),
            block(-24, 0, 4, -22, 1, 6, "crate"),
            block(-24, 0, 6, -23, 2, 7, "crate"),
            block(-9, 0, -1, -7, 1.5, 1, "crate"),
            block(30, 0, 9, 32, 1.5, 11, "crate"),
            block(-4, 0, 16.5, -2.5, 1.5, 18, "crate"),
            block(17, 0, 16, 18.5, 1.5, 17.5, "crate"),
        ],
        "spawns": [
            spawn(-31, 0, -18),
            spawn(-32, 0, 5),
            spawn(-9, 0, 17),
            spawn(15, 0, 23),
            spawn(11, 0, -10),
        ],
        "items": [
            item("railgun", -14, 3, 23),
            item("slugs", -27, 3, 23.5),
            item("rocketlauncher", 9, 0, 17),
            item("rockets", 24, 0, 17),
            item("shotgun", -31, 0, -3),
            item("shells", -23, 0, -5),
            item("armor", -10.5, 0, 4.5),
            item("bullets", -20, 0, 10.5),
            item("bullets", 17.5, 0, -2),
            item("health", 0, 0, 10),
            item("health", -31, 0, -12),
            item("health", 23, 0, -10),
            item("health", -18.5, 0, 17),
            item("health_large", 9, 2, -2),
        ],
        "jumpPads": [pad(27, 0, 16.75, (26, 3, 23))],
        "teleporters": [
            # From the corner beyond the gallery's end to the far end of the other gallery.
            teleporter(33.5, 0, 23.5, (-24, 3, -23), -90),
        ],
        "props": [
            prop("barrel", 34.5, 0, 16),
            prop("barrel", 33.7, 0, 15.3, 40),
            prop("barrel", -18, 0, -6.8),
            prop("boxes", -29, 0, 24, 10),
            prop("boxes", 4.5, 0, 24.5, -15),
            prop("boxes", 16.5, 0, -8, 30),
            prop("monitor", -35.2, 0, -3, 90),
            prop("monitor", 4.5, 0, 25.2, 180),
            prop("monitor", -25.3, 0, -4, -90),
            prop("plant", -35, 0, 9),
            prop("plant", 3, 0, 3, 30),
            prop("plant", 28.5, 0, 12),
            prop("lamp", -3.2, 0, 14.6),
            prop("lamp", 12, 3, 25.3),
            prop("lamp", -15.2, 0, -4),
            prop("chair", -30, 0, -6, 70),
            prop("chair", -32.5, 0, -7, 200),
            prop("chair", 12, 0, 4, 200),
            prop("cone", 25.3, 0, 15.6),
            prop("cone", 28.7, 0, 15.6),
            prop("bottles", 10.7, 1, -2.2, 45),
            prop("bottles", -23, 1, 5, 0),
            prop("bottles", -8, 1.5, 0, 20),
        ],
    }
    return game_map("grounds", -20, half, centre)


def gate() -> Thing:
    """A walled courtyard inside two rings of corridors, after Arena Gate: four gates,
    two corner platforms for the rails, and a tight fight over the booster in the middle.
    """
    centre = {
        "blocks": [
            block(-31, -1, -31, 31, 0, 31, "floor"),
            # The dais in the middle of the courtyard.
            block(-2, 0, -2, 2, 1, 2, "stone"),
        ],
        "items": [item("quad", 0, 1, 0)],
    }
    half = {
        "blocks": [
            # Outer walls: north and west.
            block(-31, 0, -31, 31, 6, -30, "wall"),
            block(-31, 0, -30, -30, 6, 30, "wall"),
            # The courtyard's north wall with its gate, and the west one.
            block(-13, 0, -13, -2, 4, -12, "wall"),
            block(2, 0, -13, 13, 4, -12, "wall"),
            block(-2, 2.5, -13, 2, 4, -12, "wall"),
            block(-13, 0, -12, -12, 4, -2, "wall"),
            block(-13, 0, 2, -12, 4, 12, "wall"),
            block(-13, 2.5, -2, -12, 4, 2, "wall"),
            # The walls that split the ring into an inner and an outer corridor.
            block(-19, 0, -22, -6, 4, -21, "wall"),
            block(6, 0, -22, 19, 4, -21, "wall"),
            block(-22, 0, -19, -21, 4, -6, "wall"),
            block(-22, 0, 6, -21, 4, 19, "wall"),
            # Stubs across the corridors: nobody sees a whole side at once.
            block(-9, 0, -21, -8, 4, -17, "wall"),
            block(8, 0, -17, 9, 4, -13, "wall"),
            block(-21, 0, 8, -17, 4, 9, "wall"),
            block(-17, 0, -9, -13, 4, -8, "wall"),
            block(-3, 0, -30, -2, 4, -26, "wall"),
            block(-30, 0, 2, -26, 4, 3, "wall"),
            # Pillars and low walls in the courtyard.
            block(5.5, 0, 5.5, 7, 3, 7, "stone"),
            block(5.5, 0, -7, 7, 3, -5.5, "stone"),
            block(-9, 0, -0.25, -5, 1.2, 0.25, "stone"),
            block(-0.25, 0, -9, 0.25, 1.2, -5, "stone"),
            block(-10.5, 0, -10.5, -9, 1.5, -9, "crate"),
            # The north-east platform and the stairs up to it from the outer corridor.
            block(20, 0, -30, 30, 2, -20, "metal"),
            *stairs("x", 16, 20, -30, -27, 0, 2, "stone"),
            block(27.5, 2, -24, 29, 3.5, -22.5, "crate"),
            # Cover in the corridors.
            block(-26.5, 0, -1, -24.5, 1, 1, "crate"),
            block(-1, 0, -26, 1, 1.5, -24.5, "crate"),
            block(-17.5, 0, 14, -16, 3, 15.5, "stone"),
            block(13, 0, -18, 14.5, 1.5, -16.5, "crate"),
            block(-27, 0, -16, -25.5, 3, -14.5, "stone"),
            block(-16, 0, -27.5, -14, 1.2, -27, "stone"),
            block(-18, 0, -3, -16.5, 1.5, -1.5, "crate"),
            block(10, 0, -27, 11.5, 3, -25.5, "stone"),
        ],
        "spawns": [
            spawn(16.5, 0, -16.5),
            spawn(-4, 0, -17),
            spawn(-17, 0, -5.5),
            spawn(4, 0, -9),
            spawn(-26, 0, -10),
        ],
        "items": [
            item("railgun", 26, 2, -26),
            item("slugs", 22, 2, -28.5),
            item("rocketlauncher", 3, 0, -26),
            item("rockets", -26, 0, 8),
            item("armor", -26, 0, -4),
            item("shotgun", -7, 0, 3),
            item("shells", -9, 0, -5),
            item("bullets", -16, 0, 26),
            item("bullets", -15, 0, -15),
            item("health", -25.5, 0, -25.5),
            item("health", 7, 0, -19),
            item("health", -19, 0, 3),
            item("health", -12, 0, -25),
            item("health_large", 3, 0, -5),
        ],
        "jumpPads": [
            # From the courtyard over the walls onto the platform.
            pad(8, 0, -8, (22.5, 2, -22.5), rise=5),
        ],
        "teleporters": [
            # Between the two corners that have no platform.
            teleporter(-28.5, 0, -28.5, (25, 0, 25), 45),
        ],
        "props": [
            prop("barrel", -29, 0, -22),
            prop("barrel", -28.2, 0, -21.3, 25),
            prop("barrel", 5, 0, -29),
            prop("boxes", 29, 2, -21, 15),
            prop("boxes", -24, 0, 12, 40),
            prop("boxes", 12.5, 0, -24, -10),
            prop("monitor", 29.3, 2, -28, -90),
            prop("monitor", -29.3, 0, -8, 90),
            prop("lamp", -11, 0, -11.4),
            prop("lamp", 11, 0, -11.4),
            prop("lamp", -20.3, 0, -20.3),
            prop("plant", -2.8, 0, -2.8, 20),
            prop("plant", 14, 0, -10),
            prop("plant", -29, 0, 14),
            prop("chair", -20, 0, -27, 100),
            prop("chair", 4, 0, -15, 30),
            prop("chair", -15, 0, 10, 250),
            prop("cone", -2.6, 0, -14),
            prop("cone", 2.6, 0, -14),
            prop("cone", -2.6, 0, -23),
            prop("cone", 2.6, 0, -23),
            prop("bottles", -25.5, 1, 0, 60),
            prop("bottles", 0, 1.5, -25.2),
            prop("bottles", -9.75, 1.5, -9.75),
        ],
    }
    return game_map("gate", -20, half, centre)


def _line(thing: Thing) -> str:
    return json.dumps(thing, separators=(", ", ": "))


def write(data: Thing) -> None:
    """One thing per line, like the map that is written by hand."""
    parts = [f'  "name": {json.dumps(data["name"])}', f'  "killY": {data["killY"]}']
    for key, things in data.items():
        if isinstance(things, list):
            rows = ",\n".join(f"    {_line(thing)}" for thing in things)
            parts.append(f'  "{key}": [\n{rows}\n  ]')
    path = Path(SHARED_DIR) / "maps" / f"{data['name']}.json"
    path.write_text("{\n" + ",\n".join(parts) + "\n}\n", encoding="utf-8")
    print(f"{path.name}: {len(data['blocks'])} blocks, {len(data['items'])} items")


if __name__ == "__main__":
    for build in (yard, grounds, gate):
        write(build())
