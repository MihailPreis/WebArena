import re

import pytest
from fastapi.testclient import TestClient

from arena.game.rooms import MatchSettings, RoomRegistry
from tests.conftest import auth

SETTINGS = MatchSettings(mode="deathmatch", kill_limit=25, time_limit_min=10, max_players=8)


@pytest.fixture
def token(api: TestClient) -> str:
    token: str = api.post("/api/players").json()["token"]
    return token


def test_create_room_with_defaults(api: TestClient, token: str) -> None:
    me = api.get("/api/players/me", headers=auth(token)).json()
    response = api.post("/api/rooms", headers=auth(token))
    assert response.status_code == 201
    room = response.json()
    assert re.fullmatch(r"[A-Z0-9]{4}", room["code"])
    assert room["hostId"] == me["id"]
    assert room["players"] == 0
    assert room["settings"] == {
        "mode": "deathmatch",
        "killLimit": 25,
        "timeLimitMin": 10,
        "maxPlayers": 8,
    }


def test_create_room_with_host_settings(api: TestClient, token: str) -> None:
    settings = {"mode": "deathmatch", "killLimit": 50, "timeLimitMin": 5, "maxPlayers": 4}
    room = api.post("/api/rooms", headers=auth(token), json=settings).json()
    assert room["settings"] == settings
    assert api.get(f"/api/rooms/{room['code']}").json() == room


def test_create_room_requires_a_player(api: TestClient) -> None:
    assert api.post("/api/rooms").status_code == 401


@pytest.mark.parametrize(
    "settings",
    [
        {"killLimit": 4},
        {"killLimit": 101},
        {"timeLimitMin": 0},
        {"timeLimitMin": 31},
        {"maxPlayers": 1},
        {"maxPlayers": 9},
        {"mode": "team-deathmatch"},
        {"killLimit": "many"},
    ],
)
def test_create_room_rejects_out_of_range_settings(
    api: TestClient, token: str, settings: dict[str, object]
) -> None:
    assert api.post("/api/rooms", headers=auth(token), json=settings).status_code == 422


def test_unknown_room_is_not_found(api: TestClient) -> None:
    assert api.get("/api/rooms/ZZZZ").status_code == 404


def test_room_does_not_leak_tokens(api: TestClient, token: str) -> None:
    room = api.post("/api/rooms", headers=auth(token))
    assert token not in room.text


def test_registry_gives_unique_codes() -> None:
    registry = RoomRegistry(empty_ttl_s=60)
    codes = {registry.create("host", SETTINGS).code for _ in range(500)}
    assert len(codes) == 500


def test_empty_room_expires_after_ttl() -> None:
    now = 0.0
    registry = RoomRegistry(empty_ttl_s=60, clock=lambda: now)
    room = registry.create("host", SETTINGS)
    now = 59.0
    assert registry.get(room.code) is room
    now = 60.0
    assert registry.get(room.code) is None


def test_occupied_room_does_not_expire() -> None:
    now = 0.0
    registry = RoomRegistry(empty_ttl_s=60, clock=lambda: now)
    room = registry.create("host", SETTINGS)
    room.player_ids.add("host")
    room.empty_since = None
    now = 10_000.0
    assert registry.get(room.code) is room
