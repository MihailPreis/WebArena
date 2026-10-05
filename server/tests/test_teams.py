import math
import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from arena.db.players import Player
from arena.game.map import load_map
from arena.game.results import MatchResult
from arena.game.room import (
    MATCH,
    MAX_HEALTH,
    RESPAWN_DELAY_S,
    RESULTS,
    SNAPSHOT_INTERVAL,
    SPAWN_PROTECTION_S,
    WAITING,
    MatchSettings,
    Member,
    Room,
)
from arena.game.weapon import WEAPONS
from arena.net.protocol import PROTOCOL_VERSION
from tests.conftest import FakeConn, auth
from tests.test_combat import RANGE, cmd, standing

ARENA = load_map("arena")
PLAYERS = [Player(f"p{i}", f"Player {i}", "#ffffff") for i in range(6)]


def team_room(kill_limit: int = 5, results: list[MatchResult] | None = None) -> Room:
    settings = MatchSettings("team-deathmatch", kill_limit, 1, 8)
    on_end = results.append if results is not None else None
    return Room("AB12", "p0", settings, RANGE, float, on_match_end=on_end)


def join(room: Room, count: int) -> tuple[list[Member], list[FakeConn]]:
    conns = [FakeConn() for _ in range(count)]
    members = [room.join(PLAYERS[i], conns[i]) for i in range(count)]
    return members, conns


def wait(room: Room, seconds: float) -> None:
    for _ in range(math.ceil(seconds / SNAPSHOT_INTERVAL)):
        room.tick()


def test_players_are_dealt_into_even_teams() -> None:
    room = team_room()
    members, conns = join(room, 5)
    assert [m.team for m in members] == ["blue", "red", "blue", "red", "blue"]

    welcome = conns[2].last("welcome")
    assert [p["team"] for p in welcome["players"]] == ["blue", "red"]
    state = conns[0].last("room")
    assert state["teams"] == {"blue": 0, "red": 0}
    assert {p["id"]: p["team"] for p in state["players"]}["p1"] == "red"


def test_newcomer_fills_the_smaller_team_and_rejoining_keeps_the_side() -> None:
    room = team_room()
    members, conns = join(room, 3)  # blue, red, blue
    room.leave(members[1], conns[1])  # Red is empty now.
    newcomer = room.join(PLAYERS[3], FakeConn())
    assert newcomer.team == "red"
    back = room.join(PLAYERS[1], FakeConn())
    assert back.team == "red"


def test_teammates_cannot_hurt_each_other_but_enemies_can() -> None:
    room = team_room()
    (shooter, enemy, mate), _ = join(room, 3)
    room.tick()
    shooter.state = standing((0.0, 0.0, 0.0))
    mate.state = standing((0.0, 0.0, -3.0))  # A teammate stands in the line of fire.
    enemy.state = standing((0.0, 0.0, -6.0))
    for member in (shooter, enemy, mate):
        member.history.clear()
    wait(room, SPAWN_PROTECTION_S + 0.1)

    room.receive_input(shooter, 0, cmd(pitch=-0.1, fire=True), room.time)
    room.tick()
    assert mate.hp == MAX_HEALTH
    assert enemy.hp == MAX_HEALTH - WEAPONS[0].damage


def test_team_score_decides_the_match() -> None:
    results: list[MatchResult] = []
    room = team_room(kill_limit=5, results=results)
    (blue1, red1, blue2, red2), conns = join(room, 4)
    room.tick()
    assert room.state == MATCH

    for _ in range(3):
        room.mode.record_kill(blue1, red1)
    room.mode.record_kill(red2, blue2)
    room.mode.record_kill(blue2, red2)
    room.tick()
    assert room.state == MATCH  # Nobody has five kills alone...
    assert conns[0].last("room")["teams"] is not None
    room.mode.record_kill(blue2, red1)
    room.tick()
    assert room.state == RESULTS  # ...but the blue team has.

    state = conns[1].last("room")
    assert state["teams"] == {"blue": 5, "red": 1}
    # The winning team is listed first, best player first within a team.
    assert [p["id"] for p in state["players"]] == ["p0", "p2", "p3", "p1"]

    (result,) = results
    assert result.mode == "team-deathmatch"
    table = {p.player_id: p for p in result.players}
    assert [table[i].won for i in ("p0", "p2", "p1", "p3")] == [True, True, False, False]
    assert (table["p0"].team, table["p1"].team) == ("blue", "red")


def test_level_team_scores_are_a_draw() -> None:
    results: list[MatchResult] = []
    room = team_room(kill_limit=50, results=results)
    (blue, red), _ = join(room, 2)
    room.tick()
    room.mode.record_kill(blue, red)
    room.mode.record_kill(red, blue)
    room.finish_match()
    assert [p.won for p in results[0].players] == [False, False]


def test_switching_team_during_a_match_costs_a_life() -> None:
    room = team_room()
    (a, b, c), conns = join(room, 3)  # blue, red, blue
    room.tick()
    room.change_team(a, "red")

    assert a.team == "red"
    assert (a.alive, a.deaths, a.kills) == (False, 1, 0)
    assert conns[1].last("event") == {"t": "event", "e": "team", "id": "p0", "team": "red"}
    assert {p["id"]: p["team"] for p in conns[1].last("room")["players"]}["p0"] == "red"
    assert conns[0].last("snapshot") is not None
    wait(room, RESPAWN_DELAY_S + 0.1)
    assert a.alive is True
    # Former teammates are now opponents.
    assert room.mode.are_enemies(a, c) and not room.mode.are_enemies(a, b)


def test_switching_is_refused_when_it_would_unbalance_the_teams() -> None:
    room = team_room()
    (a, _), _ = join(room, 2)  # blue, red
    room.tick()
    room.change_team(a, "red")  # Would make it two against none.
    assert (a.team, a.alive) == ("blue", True)

    room.change_team(a, "blue")  # Already there.
    room.change_team(a, "green")  # Not a team.
    assert (a.team, a.deaths) == ("blue", 0)


def test_switching_before_the_match_is_free() -> None:
    room = team_room()
    (a,), conns = join(room, 1)
    room.tick()
    assert room.state == WAITING
    room.change_team(a, "red")
    assert (a.team, a.alive, a.deaths) == ("red", True, 0)
    assert conns[0].last("event")["e"] == "spawn"


def test_teams_do_not_exist_in_a_free_for_all() -> None:
    room = Room("AB12", "p0", MatchSettings("deathmatch", 5, 1, 8), ARENA, float)
    (a, b), conns = join(room, 2)
    assert (a.team, b.team) == (None, None)
    assert conns[0].last("room")["teams"] is None
    room.change_team(a, "red")
    assert a.team is None


def test_host_switches_the_mode_between_matches() -> None:
    room = Room("AB12", "p0", MatchSettings("deathmatch", 5, 1, 8), ARENA, float)
    members, conns = join(room, 4)
    room.tick()
    room.change_settings(members[0], "team-deathmatch", 5, 1)
    assert room.settings.mode == "deathmatch"  # Not during a match.

    room.finish_match()
    room.change_settings(members[0], "team-deathmatch", 10, 2)
    assert room.settings.mode == "team-deathmatch"
    assert [m.team for m in members] == ["blue", "red", "blue", "red"]
    state = conns[3].last("room")
    assert state["settings"]["mode"] == "team-deathmatch"
    assert state["teams"] == {"blue": 0, "red": 0}

    room.change_settings(members[0], "deathmatch", 10, 2)
    assert [m.team for m in members] == [None] * 4


def test_team_room_over_the_api_and_socket(api: TestClient, db_path: Path) -> None:
    host = api.post("/api/players").json()
    guest = api.post("/api/players").json()
    created = api.post(
        "/api/rooms", headers=auth(host["token"]), json={"mode": "team-deathmatch", "killLimit": 5}
    )
    assert created.status_code == 201
    code = created.json()["code"]
    assert api.get(f"/api/rooms/{code}").json()["settings"]["mode"] == "team-deathmatch"

    room: Room = api.app.state.rooms.get(code)  # type: ignore[attr-defined]
    path = f"/ws/{code}"
    with api.websocket_connect(path) as a, api.websocket_connect(path) as b:
        a.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": host["token"]})
        b.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": guest["token"]})
        for _ in range(200):
            message = b.receive_json()
            # Wait for the match itself: it starts on the tick after both are in.
            if message["t"] == "room" and message["state"] == "match":
                break
        assert {p["team"] for p in message["players"]} == {"blue", "red"}

        # One against one: switching would empty a team, so the server ignores it.
        b.send_json({"t": "team", "team": "blue"})
        b.send_json({"t": "ping", "id": 1})
        for _ in range(200):
            if b.receive_json()["t"] == "pong":
                break
        assert room.members[guest["id"]].team == "red"

        for _ in range(5):
            room.mode.record_kill(room.members[host["id"]], room.members[guest["id"]])
        for _ in range(400):
            message = a.receive_json()
            if message["t"] == "room" and message["state"] == "results":
                break
        assert message["teams"] == {"blue": 5, "red": 0}

    with sqlite3.connect(db_path) as conn:
        rows = conn.execute("SELECT player_id, team, won FROM match_players").fetchall()
    assert sorted(rows) == sorted([(host["id"], "blue", 1), (guest["id"], "red", 0)])
