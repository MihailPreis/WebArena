import asyncio
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from arena.config import Settings
from arena.db.players import Player
from arena.game.map import load_map
from arena.game.results import MatchResult
from arena.game.room import RESULTS, MatchSettings, Room
from arena.game.weapon import WEAPONS
from arena.main import create_app
from arena.net.protocol import PROTOCOL_VERSION
from tests.conftest import FakeConn, auth, wait_for
from tests.test_combat import Duel

ARENA = load_map("arena")
ALICE = Player("a1", "Alice", "#ff5555")
BOB = Player("b2", "Bob", "#54a0ff")
CAROL = Player("c3", "Carol", "#2ed573")


@pytest.fixture
def app_settings(db_path: Path, tmp_path: Path) -> Settings:
    return Settings(
        db_path=db_path,
        client_dist=tmp_path / "dist",
        leaderboard_min_kills=5,
        profiles_per_minute=0,
        rooms_per_minute=0,
    )


@pytest.fixture
def api(app_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(app_settings)) as client:
        yield client


def new_player(api: TestClient, name: str) -> dict[str, str]:
    player: dict[str, str] = api.post("/api/players").json()
    api.patch("/api/players/me", headers=auth(player["token"]), json={"name": name})
    return player


def insert_totals(db_path: Path, player_id: str, **totals: int) -> None:
    """Writes a player's totals directly, as if matches had been played."""
    columns = ", ".join(totals)
    marks = ", ".join("?" for _ in totals)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            f"INSERT INTO player_stats (player_id, {columns}) VALUES (?, {marks})",
            (player_id, *totals.values()),
        )


def make_room(kill_limit: int = 3) -> tuple[Room, list[MatchResult]]:
    results: list[MatchResult] = []
    settings = MatchSettings("deathmatch", kill_limit, 1, 8)
    room = Room("AB12", ALICE.id, settings, ARENA, float, on_match_end=results.append)
    return room, results


def test_room_reports_the_result_when_a_match_ends() -> None:
    room, results = make_room(kill_limit=3)
    alice, bob = room.join(ALICE, FakeConn()), room.join(BOB, FakeConn())
    carol_conn = FakeConn()
    carol = room.join(CAROL, carol_conn)
    room.tick()
    for _ in range(29):
        room.tick()
    room.mode.record_kill(carol, bob)
    carol.shots, carol.hits, carol.headshots, carol.damage_dealt = 9, 5, 1, 100
    room.leave(carol, carol_conn)
    for _ in range(3):
        room.mode.record_kill(alice, bob)
    room.tick()

    assert room.state == RESULTS
    (result,) = results
    assert (result.room_code, result.map, result.mode) == ("AB12", "arena", "deathmatch")
    assert (result.kill_limit, result.time_limit_s) == (3, 60)
    assert result.ended_at >= result.started_at > 0
    table = {p.player_id: p for p in result.players}
    assert [p.player_id for p in result.players] == ["a1", "c3", "b2"]
    assert [p.place for p in result.players] == [1, 2, 3]
    assert (table["a1"].kills, table["a1"].won) == (3, True)
    assert (table["b2"].deaths, table["b2"].won) == (4, False)
    # Carol left early but her part of the match is kept.
    assert (table["c3"].kills, table["c3"].shots, table["c3"].hits) == (1, 9, 5)
    assert table["c3"].playtime_s == 1
    assert table["a1"].playtime_s == 1


def test_a_level_match_has_no_winner() -> None:
    room, results = make_room(kill_limit=50)
    alice, bob = room.join(ALICE, FakeConn()), room.join(BOB, FakeConn())
    room.tick()
    room.mode.record_kill(alice, bob)
    room.mode.record_kill(bob, alice)
    room.finish_match()
    assert [p.won for p in results[0].players] == [False, False]

    # Finishing twice must not report the match twice.
    room.finish_match()
    assert len(results) == 1


def test_shots_and_damage_are_counted_only_during_a_match() -> None:
    duel = Duel()
    duel.shoot(pitch=-0.1)
    duel.shoot(pitch=0.02)
    duel.shoot(yaw=1.5)
    assert (duel.alice.shots, duel.alice.hits, duel.alice.headshots) == (3, 2, 1)
    assert duel.alice.damage_dealt == duel.bob.damage_taken == 3 * WEAPONS[0].damage


def test_match_is_saved_and_totals_accumulate(api: TestClient, db_path: Path) -> None:
    alice, bob = new_player(api, "Alice"), new_player(api, "Bob")
    code = api.post("/api/rooms", headers=auth(alice["token"]), json={"killLimit": 5}).json()[
        "code"
    ]
    room: Room = api.app.state.rooms.get(code)  # type: ignore[attr-defined]

    for expected_matches in (1, 2):
        # Let the results screen of the previous round end as soon as the players are back.
        if room.state == RESULTS:
            room.state_ends_at = room.time
        with api.websocket_connect(f"/ws/{code}") as a, api.websocket_connect(f"/ws/{code}") as b:
            a.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": alice["token"]})
            b.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": bob["token"]})
            wait_for(lambda: room.state == "match")
            for _ in range(5):
                room.mode.record_kill(room.members[alice["id"]], room.members[bob["id"]])
            room.members[alice["id"]].shots = 10
            room.members[alice["id"]].hits = 5
            wait_for(lambda m=expected_matches: stats_of(api, alice["id"])["matches"] == m)
            # Do not let the next match start while still connected.
            room.state_ends_at = room.time + 1000

    stats = stats_of(api, alice["id"])
    assert (stats["matches"], stats["wins"], stats["kills"], stats["deaths"]) == (2, 2, 10, 0)
    assert stats["kd"] == 10
    assert stats["accuracy"] == 0.5
    assert stats_of(api, bob["id"])["deaths"] == 10

    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM matches").fetchone() == (2,)
        assert conn.execute("SELECT COUNT(*) FROM match_players").fetchone() == (4,)
        assert conn.execute("SELECT room_code, mode, kill_limit FROM matches").fetchone() == (
            code,
            "deathmatch",
            5,
        )


def test_unfinished_match_is_saved_on_shutdown(app_settings: Settings, db_path: Path) -> None:
    with TestClient(create_app(app_settings)) as api:
        alice, bob = new_player(api, "Alice"), new_player(api, "Bob")
        code = api.post("/api/rooms", headers=auth(alice["token"])).json()["code"]
        room: Room = api.app.state.rooms.get(code)  # type: ignore[attr-defined]
        with api.websocket_connect(f"/ws/{code}") as a, api.websocket_connect(f"/ws/{code}") as b:
            a.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": alice["token"]})
            b.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": bob["token"]})
            wait_for(lambda: room.state == "match")
            room.mode.record_kill(room.members[alice["id"]], room.members[bob["id"]])

    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM matches").fetchone() == (1,)
        assert conn.execute(
            "SELECT kills, wins FROM player_stats WHERE player_id = ?", (alice["id"],)
        ).fetchone() == (1, 1)


def test_a_failed_save_leaves_nothing_behind(api: TestClient, db_path: Path) -> None:
    alice = new_player(api, "Alice")
    code = api.post("/api/rooms", headers=auth(alice["token"])).json()["code"]
    room: Room = api.app.state.rooms.get(code)  # type: ignore[attr-defined]
    # A player the database does not know breaks the second insert of the transaction.
    room.join(Player(alice["id"], "Alice", "#ffffff"), FakeConn())
    room.join(Player("ghost", "Ghost", "#ffffff"), FakeConn())
    room.tick()
    api.portal.call(finish_and_wait, api, room)  # type: ignore[union-attr]

    with sqlite3.connect(db_path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM matches").fetchone() == (0,)
        assert conn.execute("SELECT COUNT(*) FROM player_stats").fetchone() == (0,)
    # The server keeps working.
    assert api.get("/healthz").status_code == 200


async def finish_and_wait(api: TestClient, room: Room) -> None:
    room.finish_match()
    await asyncio.sleep(0.2)


def test_leaderboards(api: TestClient, db_path: Path) -> None:
    ace = new_player(api, "Ace")
    grinder = new_player(api, "Grinder")
    lucky = new_player(api, "Lucky")
    champion = new_player(api, "Champion")
    insert_totals(db_path, ace["id"], matches=3, wins=1, kills=30, deaths=5)
    insert_totals(db_path, grinder["id"], matches=40, wins=2, kills=200, deaths=180)
    insert_totals(db_path, lucky["id"], matches=1, wins=0, kills=4, deaths=0)
    insert_totals(db_path, champion["id"], matches=9, wins=8, kills=60, deaths=30)
    new_player(api, "Idle")

    def names(by: str | None) -> list[str]:
        params = {"by": by} if by else {}
        return [p["name"] for p in api.get("/api/leaderboard", params=params).json()["players"]]

    # Lucky has the best ratio but too few kills to be ranked by it.
    assert names(None) == ["Ace", "Champion", "Grinder"]
    assert names("kd") == names(None)
    assert names("kills") == ["Grinder", "Champion", "Ace", "Lucky"]
    assert names("wins") == ["Champion", "Grinder", "Ace", "Lucky"]

    board = api.get("/api/leaderboard").json()
    assert board["minKills"] == 5
    assert board["players"][0] == {
        "id": ace["id"],
        "name": "Ace",
        "color": board["players"][0]["color"],
        "matches": 3,
        "wins": 1,
        "kills": 30,
        "deaths": 5,
        "kd": 6.0,
    }
    assert api.get("/api/leaderboard", params={"by": "luck"}).status_code == 422
    assert "token" not in api.get("/api/leaderboard").text


def test_leaderboard_shows_ten_players_at_most(api: TestClient, db_path: Path) -> None:
    for i in range(12):
        insert_totals(db_path, new_player(api, f"P{i}")["id"], kills=10 + i, deaths=1)
    players = api.get("/api/leaderboard").json()["players"]
    assert len(players) == 10
    assert players[0]["name"] == "P11"


def test_leaderboard_is_cached_briefly(db_path: Path, tmp_path: Path) -> None:
    settings = Settings(
        db_path=db_path,
        client_dist=tmp_path / "dist",
        leaderboard_min_kills=1,
        leaderboard_cache_s=60,
    )
    with TestClient(create_app(settings)) as api:
        assert api.get("/api/leaderboard").json()["players"] == []
        insert_totals(db_path, new_player(api, "Late")["id"], kills=9, deaths=1)
        assert api.get("/api/leaderboard").json()["players"] == []
        # Each ranking is cached on its own.
        assert len(api.get("/api/leaderboard", params={"by": "kills"}).json()["players"]) == 1


def test_player_stats_endpoint(api: TestClient, db_path: Path) -> None:
    fresh = new_player(api, "Fresh")
    assert stats_of(api, fresh["id"]) == {
        "id": fresh["id"],
        "name": "Fresh",
        "color": stats_of(api, fresh["id"])["color"],
        "matches": 0,
        "wins": 0,
        "kills": 0,
        "deaths": 0,
        "kd": 0,
        "headshots": 0,
        "shots": 0,
        "hits": 0,
        "accuracy": 0,
        "damageDealt": 0,
        "playtimeS": 0,
    }
    assert api.get("/api/players/unknown").status_code == 404
    # The public page of a player must not accept or reveal a token.
    assert "token" not in api.get(f"/api/players/{fresh['id']}").text


def stats_of(api: TestClient, player_id: str) -> dict[str, Any]:
    stats: dict[str, Any] = api.get(f"/api/players/{player_id}").json()
    return stats
