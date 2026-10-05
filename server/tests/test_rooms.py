import re

import pytest
from fastapi.testclient import TestClient

from arena.db.players import Player
from arena.game.room import MatchSettings
from arena.game.rooms import RoomRegistry
from arena.shared import DEFAULT_MAP, DEV_MAPS, MAPS, allowed_maps
from tests.conftest import FakeConn, auth

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
        "map": DEFAULT_MAP,
        "killLimit": 25,
        "timeLimitMin": 10,
        "maxPlayers": 8,
    }


def test_create_room_with_host_settings(api: TestClient, token: str) -> None:
    settings = {
        "mode": "deathmatch",
        "map": MAPS[-1],
        "killLimit": 50,
        "timeLimitMin": 5,
        "maxPlayers": 4,
    }
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
        {"mode": "capture-the-flag"},
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
    registry = RoomRegistry(MAPS, empty_ttl_s=60)
    codes = {registry.create("host", DEFAULT_MAP, SETTINGS).code for _ in range(500)}
    assert len(codes) == 500


def test_empty_room_expires_after_ttl() -> None:
    now = 0.0
    registry = RoomRegistry(MAPS, empty_ttl_s=60, clock=lambda: now)
    room = registry.create("host", DEFAULT_MAP, SETTINGS)
    now = 59.0
    assert registry.get(room.code) is room
    now = 60.0
    assert registry.get(room.code) is None


def test_occupied_room_does_not_expire() -> None:
    now = 0.0
    registry = RoomRegistry(MAPS, empty_ttl_s=60, clock=lambda: now)
    room = registry.create("host", DEFAULT_MAP, SETTINGS)
    conn = FakeConn()
    member = room.join(Player("host", "Host", "#ffffff"), conn)
    now = 10_000.0
    assert registry.get(room.code) is room

    # The countdown starts again only when the last player leaves.
    room.leave(member, conn)
    now = 10_059.0
    assert registry.get(room.code) is room
    now = 10_060.0
    assert registry.get(room.code) is None


def test_dev_maps_are_offered_only_in_development(api: TestClient, token: str) -> None:
    settings = {"map": DEV_MAPS[0]}
    assert api.post("/api/rooms", headers=auth(token), json=settings).status_code == 422
    assert api.post("/api/rooms", headers=auth(token), json={"map": "nowhere"}).status_code == 422


def test_dev_registry_offers_every_map() -> None:
    registry = RoomRegistry(allowed_maps(dev=True), empty_ttl_s=60)
    room = registry.create("host", DEV_MAPS[0], SETTINGS)
    assert room.map.name == DEV_MAPS[0]
    assert set(registry.maps) == {*MAPS, *DEV_MAPS}
    assert allowed_maps(dev=False) == MAPS
