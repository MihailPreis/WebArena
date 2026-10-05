import math

from arena.db.players import Player
from arena.game.map import load_map
from arena.game.modes import Deathmatch
from arena.game.movement import InputCmd
from arena.game.room import (
    MATCH,
    RESULTS,
    RESULTS_S,
    SNAPSHOT_INTERVAL,
    WAITING,
    MatchSettings,
    Member,
    Room,
)
from arena.game.weapon import WeaponState
from tests.conftest import FakeConn
from tests.test_combat import RANGE, cmd, standing

ARENA = load_map("arena")
ALICE = Player("a1", "Alice", "#ff5555")
BOB = Player("b2", "Bob", "#54a0ff")
CAROL = Player("c3", "Carol", "#2ed573")


def make_room(kill_limit: int = 5, time_limit_min: int = 1) -> Room:
    settings = MatchSettings("deathmatch", kill_limit, time_limit_min, 8)
    return Room("AB12", ALICE.id, settings, ARENA, float)


def wait(room: Room, seconds: float) -> None:
    for _ in range(math.ceil(seconds / SNAPSHOT_INTERVAL)):
        room.tick()


def score(room: Room, killer: Member, victim: Member, times: int = 1) -> None:
    for _ in range(times):
        room.mode.record_kill(killer, victim)


def test_match_starts_when_enough_players_are_present() -> None:
    room = make_room()
    alice_conn = FakeConn()
    alice = room.join(ALICE, alice_conn)
    alice.kills = 3  # Warm-up kills must not carry over.
    wait(room, 1)
    assert room.state == WAITING
    assert alice_conn.last("room")["timeLeft"] is None

    room.join(BOB, FakeConn())
    room.tick()
    assert room.state == MATCH
    assert alice.kills == 0
    state = alice_conn.last("room")
    assert state["state"] == "match"
    assert state["timeLeft"] == 60
    assert [e["id"] for e in alice_conn.sent if e.get("e") == "spawn"] == ["a1", "b2"]


def test_kill_limit_ends_the_match_and_freezes_players() -> None:
    room = make_room(kill_limit=5)
    alice_conn = FakeConn()
    alice, bob = room.join(ALICE, alice_conn), room.join(BOB, FakeConn())
    room.tick()
    score(room, bob, alice, 2)
    score(room, alice, bob, 5)
    room.tick()

    assert room.state == RESULTS
    state = alice_conn.last("room")
    assert state["state"] == "results"
    assert [(p["id"], p["kills"], p["deaths"]) for p in state["players"]] == [
        ("a1", 5, 2),
        ("b2", 2, 5),
    ]
    snapshot = alice_conn.last("snapshot")
    assert snapshot["status"]["frozen"] is True

    # Inputs are acknowledged but do nothing while the results are shown.
    before = alice.state
    room.receive_input(alice, 0, InputCmd(1.0, 0.0, False, False, False, 0.0, 0.0, True), 0.0)
    room.tick()
    assert alice.ack == 0
    assert alice.state == before
    assert alice.weapon == WeaponState()


def test_time_limit_ends_the_match() -> None:
    room = make_room(kill_limit=50, time_limit_min=1)
    room.join(ALICE, FakeConn())
    room.join(BOB, FakeConn())
    wait(room, 59)
    assert room.state == MATCH
    wait(room, 1.2)
    assert room.state == RESULTS


def test_next_match_starts_after_the_results_with_a_clean_table() -> None:
    room = make_room(kill_limit=1)
    alice_conn = FakeConn()
    alice, bob = room.join(ALICE, alice_conn), room.join(BOB, FakeConn())
    room.tick()
    score(room, alice, bob)
    room.tick()
    assert room.state == RESULTS

    wait(room, RESULTS_S - 0.5)
    assert room.state == RESULTS
    wait(room, 0.6)
    assert room.state == MATCH
    assert (alice.kills, bob.deaths) == (0, 0)
    assert alice_conn.last("snapshot")["status"]["frozen"] is False


def test_room_returns_to_waiting_when_players_are_gone_after_a_match() -> None:
    room = make_room(kill_limit=1)
    alice = room.join(ALICE, FakeConn())
    bob_conn = FakeConn()
    bob = room.join(BOB, bob_conn)
    room.tick()
    score(room, alice, bob)
    room.tick()
    room.leave(bob, bob_conn)
    wait(room, RESULTS_S + 0.1)
    assert room.state == WAITING
    assert list(room.members) == ["a1"]


def test_player_who_left_stays_in_the_table_until_the_match_is_over() -> None:
    room = make_room(kill_limit=2)
    alice_conn, bob_conn = FakeConn(), FakeConn()
    alice, bob = room.join(ALICE, alice_conn), room.join(BOB, bob_conn)
    room.join(CAROL, FakeConn())
    room.tick()
    score(room, bob, alice)
    room.leave(bob, bob_conn)

    table = {p["id"]: p for p in alice_conn.last("room")["players"]}
    assert table["b2"]["kills"] == 1
    assert table["b2"]["online"] is False
    assert table["a1"]["online"] is True

    score(room, alice, room.members["c3"], 2)
    wait(room, RESULTS_S + 0.2)
    assert room.state == MATCH
    assert "b2" not in room.members


def test_player_joining_mid_match_starts_from_zero() -> None:
    room = make_room()
    alice = room.join(ALICE, FakeConn())
    bob = room.join(BOB, FakeConn())
    room.tick()
    score(room, alice, bob, 3)
    carol_conn = FakeConn()
    carol = room.join(CAROL, carol_conn)
    room.tick()

    assert room.state == MATCH
    assert (carol.kills, carol.deaths) == (0, 0)
    assert alice.kills == 3
    assert [p["id"] for p in carol_conn.last("room")["players"]] == ["a1", "c3", "b2"]


def test_host_role_passes_to_the_longest_present_player() -> None:
    room = make_room()
    alice_conn, bob_conn = FakeConn(), FakeConn()
    alice = room.join(ALICE, alice_conn)
    bob = room.join(BOB, bob_conn)
    room.join(CAROL, FakeConn())
    assert room.host_id == "a1"

    room.leave(alice, alice_conn)
    assert room.host_id == "b2"
    assert bob_conn.last("room")["hostId"] == "b2"
    # Coming back does not take the role away from the new host.
    room.join(ALICE, FakeConn())
    assert room.host_id == "b2"
    room.leave(bob, bob_conn)
    assert room.host_id == "c3"


def test_empty_room_gives_the_host_role_to_the_next_arrival() -> None:
    room = make_room()
    conn = FakeConn()
    alice = room.join(ALICE, conn)
    room.leave(alice, conn)
    room.join(BOB, FakeConn())
    assert room.host_id == "b2"


def test_only_the_host_changes_settings_and_only_between_matches() -> None:
    room = make_room(kill_limit=1, time_limit_min=1)
    alice_conn = FakeConn()
    alice = room.join(ALICE, alice_conn)

    room.change_settings(alice, "deathmatch", 30, 5)
    assert (room.settings.kill_limit, room.settings.time_limit_min) == (30, 5)
    assert alice_conn.last("room")["settings"]["killLimit"] == 30

    bob = room.join(BOB, FakeConn())
    room.change_settings(bob, "deathmatch", 99, 9)
    assert room.settings.kill_limit == 30

    room.tick()
    assert room.state == MATCH
    assert alice_conn.last("room")["timeLeft"] == 300
    room.change_settings(alice, "deathmatch", 10, 2)
    assert room.settings.kill_limit == 30

    score(room, alice, bob, 30)
    room.tick()
    assert room.state == RESULTS
    room.change_settings(alice, "deathmatch", 10, 2)
    assert (room.settings.kill_limit, room.settings.time_limit_min) == (10, 2)


def test_warm_up_kills_do_not_count() -> None:
    room = Room("AB12", ALICE.id, MatchSettings("deathmatch", 5, 1, 8), RANGE, float)
    alice = room.join(ALICE, FakeConn())
    room.tick()
    assert room.state == WAITING
    # A second slot that is present in the world but not connected keeps the room waiting.
    bob = Member(player=BOB, state=standing((0.0, 0.0, -5.0)), conn=None)
    room.members["b2"] = bob
    alice.state = standing((0.0, 0.0, 0.0))
    assert Deathmatch().is_won([alice, bob], room.settings) is False
    room.receive_input(alice, 0, cmd(pitch=-0.1, fire=True), 0.0)
    room.tick()
    assert alice.kills == 0


def test_room_state_is_refreshed_periodically_with_pings() -> None:
    room = make_room()
    conn = FakeConn()
    alice = room.join(ALICE, conn)
    alice.ping = 42
    before = len([m for m in conn.sent if m["t"] == "room"])
    wait(room, 2.1)
    states = [m for m in conn.sent if m["t"] == "room"]
    assert len(states) == before + 1
    assert states[-1]["players"][0]["ping"] == 42
