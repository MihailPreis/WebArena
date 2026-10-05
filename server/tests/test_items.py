import math

import pytest

from arena.db.players import Player
from arena.game.collision import overlaps_any
from arena.game.items import ITEM_TYPES
from arena.game.map import Block, GameMap, Item, Spawn, load_map, parse_map
from arena.game.movement import HALF_WIDTH, InputCmd
from arena.game.room import (
    MAX_ARMOR,
    MAX_HEALTH,
    QUAD_S,
    SNAPSHOT_INTERVAL,
    MatchSettings,
    Member,
    Room,
)
from arena.game.weapon import WEAPONS, WeaponState
from tests.conftest import FakeConn
from tests.test_combat import standing

ALICE = Player("a1", "Alice", "#ff5555")
BOB = Player("b2", "Bob", "#54a0ff")
IDLE = InputCmd(0.0, 0.0, False, False, False, 0.0, 0.0)

# One item of every kind in a row along x, ten metres apart, on an open floor.
KINDS = ["shotgun", "shells", "bullets", "health", "armor", "armor_heavy", "quad", "health_large"]
FIELD = GameMap(
    "field",
    -20.0,
    (Block((-50.0, -1.0, -50.0), (150.0, 0.0, 50.0), "floor"),),
    (Spawn((0.0, 0.0, 30.0), 0.0),),
    tuple(Item(kind, (10.0 * i, 0.0, 0.0)) for i, kind in enumerate(KINDS)),
)


class Field:
    def __init__(self) -> None:
        self.room = Room("AB12", ALICE.id, MatchSettings("deathmatch", 25, 10, 8), FIELD, float)
        self.conn = FakeConn()
        self.alice = self.room.join(ALICE, self.conn)
        self.seq = 0

    def stand_on(self, kind: str, member: Member | None = None) -> None:
        member = member or self.alice
        member.state = standing((10.0 * KINDS.index(kind), 0.0, 0.0))
        self.seq += 1
        self.room.receive_input(member, self.seq, IDLE, 0.0)
        self.room.tick()

    def wait(self, seconds: float) -> None:
        for _ in range(math.ceil(seconds / SNAPSHOT_INTERVAL)):
            self.room.tick()

    def present(self, kind: str) -> bool:
        return bool(self.conn.last("snapshot")["items"] >> KINDS.index(kind) & 1)

    def pickups(self) -> list[int]:
        return [m["item"] for m in self.conn.sent if m.get("e") == "pickup"]


def test_arena_items_are_known_and_have_room_and_floor() -> None:
    arena = load_map("arena")
    assert arena.items
    for item in arena.items:
        assert item.type in ITEM_TYPES
        x, y, z = item.position
        lo = (x - HALF_WIDTH, y + 0.01, z - HALF_WIDTH)
        hi = (x + HALF_WIDTH, y + 1.0, z + HALF_WIDTH)
        assert not overlaps_any(arena.blocks, lo, hi), item
        under = ((x - 0.01, y - 0.1, z - 0.01), (x + 0.01, y - 0.01, z + 0.01))
        assert overlaps_any(arena.blocks, *under), item


def test_unknown_item_type_is_rejected() -> None:
    raw = {
        "name": "x",
        "killY": 0,
        "blocks": [],
        "spawns": [{"position": [0, 0, 0], "yawDeg": 0}],
        "items": [{"type": "bfg", "position": [0, 0, 0]}],
    }
    with pytest.raises(ValueError, match="unknown item"):
        parse_map(raw)


def test_weapon_pickup_gives_the_weapon_and_comes_back() -> None:
    field = Field()
    field.wait(0.1)
    assert field.present("shotgun")

    field.stand_on("shotgun")
    assert field.alice.weapon.owned == 0b11
    assert field.alice.weapon.ammo[1] == WEAPONS[1].pickup_ammo
    assert field.pickups() == [KINDS.index("shotgun")]
    assert not field.present("shotgun")
    status = field.conn.last("snapshot")["status"]
    assert (status["owned"], status["ammo"][1]) == (0b11, WEAPONS[1].pickup_ammo)

    # It comes back, and the player still standing there takes it again for the ammunition.
    field.wait(ITEM_TYPES["shotgun"].respawn_s)
    field.stand_on("shotgun")
    assert field.alice.weapon.ammo[1] == 2 * WEAPONS[1].pickup_ammo


def test_ammunition_feeds_weapons_not_yet_owned() -> None:
    field = Field()
    field.stand_on("shells")
    assert field.alice.weapon.owned == 0b1
    assert field.alice.weapon.ammo[1] == WEAPONS[1].pickup_ammo


def test_items_of_no_use_are_left_lying() -> None:
    field = Field()
    field.stand_on("bullets")
    field.stand_on("health")
    assert field.alice.weapon.ammo[0] == WEAPONS[0].start_ammo + WEAPONS[0].pickup_ammo
    assert field.pickups() == [KINDS.index("bullets")]
    assert field.present("health")

    field.alice.hp = 90
    field.stand_on("health")
    assert field.alice.hp == MAX_HEALTH
    assert not field.present("health")


def test_armor_and_quad() -> None:
    field = Field()
    field.stand_on("armor")
    assert field.alice.armor == ITEM_TYPES["armor"].amount
    field.stand_on("armor_heavy")
    assert field.alice.armor == MAX_ARMOR
    field.stand_on("quad")
    assert field.alice.quad_until == pytest.approx(field.room.time + QUAD_S)
    assert field.conn.last("snapshot")["status"]["quad"] == pytest.approx(QUAD_S, abs=0.1)


def test_items_are_out_of_reach_from_another_floor_and_for_the_dead() -> None:
    field = Field()
    field.alice.hp = 50
    field.alice.state = standing((10.0 * KINDS.index("health"), 2.5, 0.0))
    field.room._collect(field.alice)
    assert field.alice.hp == 50

    field.alice.alive = False
    field.alice.respawn_at = field.room.time + 10
    field.stand_on("health")
    assert field.alice.hp == 50


def test_a_new_match_puts_every_item_back() -> None:
    field = Field()
    field.stand_on("quad")
    field.stand_on("shotgun")
    assert not field.present("quad")

    field.room.join(BOB, FakeConn())
    field.room.tick()  # The second player starts the match.
    assert field.present("quad")
    assert field.alice.weapon == WeaponState()
    assert field.alice.quad_until == 0
