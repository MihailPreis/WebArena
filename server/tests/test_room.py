import json

import pytest

from arena.db.players import Player
from arena.game.map import load_map
from arena.game.movement import InputCmd
from arena.game.room import INPUTS_PER_TICK, MAX_INPUT_BURST, MatchSettings, Room, RoomFull
from arena.net.protocol import CloseCode
from tests.conftest import FakeConn

ARENA = load_map("arena")
ALICE = Player("a1", "Alice", "#ff5555")
BOB = Player("b2", "Bob", "#54a0ff")
FORWARD = InputCmd(1.0, 0.0, False, False, False, 0.0, 0.0)
IDLE = InputCmd(0.0, 0.0, False, False, False, 0.0, 0.0)


def make_room(max_players: int = 8) -> Room:
    settings = MatchSettings("deathmatch", 25, 10, max_players)
    return Room("AB12", ALICE.id, settings, ARENA, clock=lambda: 0.0)


def test_welcome_describes_the_room_to_the_newcomer() -> None:
    room = make_room()
    alice, bob = FakeConn(), FakeConn()
    room.join(ALICE, alice)
    room.join(BOB, bob)

    welcome = bob.last("welcome")
    assert welcome["id"] == BOB.id
    assert welcome["map"] == "arena"
    alice_public = {"id": "a1", "name": "Alice", "color": "#ff5555", "team": None}
    assert welcome["players"] == [alice_public]
    assert welcome["you"]["pos"] in [list(spawn.position) for spawn in ARENA.spawns]
    assert alice.last("event") == {
        "t": "event",
        "e": "join",
        "player": {"id": "b2", "name": "Bob", "color": "#54a0ff", "team": None},
    }


def test_room_rejects_players_over_the_limit() -> None:
    room = make_room(max_players=2)
    room.join(ALICE, FakeConn())
    room.join(BOB, FakeConn())
    with pytest.raises(RoomFull):
        room.join(Player("c3", "Carol", "#ffffff"), FakeConn())


def test_leave_frees_the_seat_and_notifies_others() -> None:
    room = make_room(max_players=2)
    alice, bob = FakeConn(), FakeConn()
    room.join(ALICE, alice)
    member = room.join(BOB, bob)
    room.leave(member, bob)

    assert [m.player.id for m in room.connected] == ["a1"]
    assert alice.last("event") == {"t": "event", "e": "leave", "id": "b2"}
    room.join(Player("c3", "Carol", "#ffffff"), FakeConn())


def test_reconnect_keeps_the_score() -> None:
    room = make_room()
    first = FakeConn()
    member = room.join(ALICE, first)
    member.kills = 7
    room.leave(member, first)
    assert room.empty_since is not None

    again = room.join(ALICE, FakeConn())
    assert again is member
    assert again.kills == 7
    assert room.empty_since is None


def test_second_connection_replaces_the_first() -> None:
    room = make_room()
    old, new, bob = FakeConn(), FakeConn(), FakeConn()
    member = room.join(ALICE, old)
    room.join(BOB, bob)
    room.join(ALICE, new)

    assert old.closed == CloseCode.REPLACED
    assert member.conn is new
    # The stale connection going away must not remove the player.
    room.leave(member, old)
    assert len(room.connected) == 2
    assert [m for m in bob.sent if m.get("e") == "join"] == []


def test_tick_simulates_inputs_and_acknowledges_them() -> None:
    room = make_room()
    conn = FakeConn()
    member = room.join(ALICE, conn)
    start = member.state.pos
    for seq in range(60):
        room.receive_input(member, seq, IDLE if seq < 30 else FORWARD, 0.0)
        if seq % 2:
            room.tick()

    snapshot = conn.last("snapshot")
    assert snapshot["ack"] == 59
    assert snapshot["tick"] == room.tick_no == 30
    assert snapshot["players"] == []
    assert snapshot["you"]["onGround"] is True
    # The client predicts from this state, so it needs every field of the simulation.
    assert {"dash", "dashHeld", "crouchHeld"} <= set(snapshot["you"])
    assert snapshot["you"]["pos"][2] < start[2] - 0.5


def test_snapshot_shows_other_players_without_secrets() -> None:
    room = make_room()
    alice, bob = FakeConn(), FakeConn()
    room.join(ALICE, alice)
    other = room.join(BOB, bob)
    room.tick()

    (seen,) = alice.last("snapshot")["players"]
    assert seen["id"] == "b2"
    assert seen["pos"] == list(other.state.pos)
    assert set(seen) == {"id", "pos", "yaw", "crouched", "dashing"}
    assert "token" not in json.dumps(alice.sent)


def test_stale_and_duplicate_inputs_are_ignored() -> None:
    room = make_room()
    member = room.join(ALICE, FakeConn())
    room.receive_input(member, 5, FORWARD, 0.0)
    room.receive_input(member, 5, FORWARD, 0.0)
    room.receive_input(member, 3, FORWARD, 0.0)
    assert [queued.seq for queued in member.inputs] == [5]


def test_inputs_cannot_be_simulated_faster_than_real_time() -> None:
    room = make_room()
    member = room.join(ALICE, FakeConn())
    for seq in range(100):
        room.receive_input(member, seq, FORWARD, 0.0)
    room.tick()
    assert member.ack == INPUTS_PER_TICK - 1

    # Saved-up credit after a pause is capped too.
    member.inputs.clear()
    for _ in range(1000):
        room.tick()
    for seq in range(100, 200):
        room.receive_input(member, seq, FORWARD, 0.0)
    room.tick()
    assert member.ack == 100 + MAX_INPUT_BURST - 1


def test_falling_out_of_the_world_respawns() -> None:
    room = make_room()
    member = room.join(ALICE, FakeConn())
    state = member.state
    member.state = type(state)(
        (0.0, ARENA.kill_y - 1, 100.0), (0.0, 0.0, 0.0), 0.0, 0.0, False, False, False
    )
    room.receive_input(member, 0, IDLE, 0.0)
    room.tick()
    assert member.state.pos in [spawn.position for spawn in ARENA.spawns]
