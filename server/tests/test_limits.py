import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from arena.config import Settings
from arena.logs import Formatter
from arena.main import create_app
from arena.net.protocol import PROTOCOL_VERSION, CloseCode
from arena.net.ws import MESSAGE_BURST
from arena.ratelimit import RateLimiter
from tests.conftest import auth


@pytest.fixture
def limited(db_path: Path, tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        db_path=db_path,
        client_dist=tmp_path / "dist",
        profiles_per_minute=3,
        rooms_per_minute=2,
        ws_max_per_ip=2,
    )
    with TestClient(create_app(settings)) as client:
        yield client


def test_rate_limiter_allows_a_burst_then_refills() -> None:
    now = 0.0
    limiter = RateLimiter(rate=1, burst=3, clock=lambda: now)
    assert [limiter.allow("a") for _ in range(4)] == [True, True, True, False]
    assert limiter.allow("b") is True  # Keys are independent.
    now = 1.0
    assert [limiter.allow("a"), limiter.allow("a")] == [True, False]
    now = 100.0
    assert [limiter.allow("a") for _ in range(4)] == [True, True, True, False]


def test_rate_limiter_can_be_disabled() -> None:
    limiter = RateLimiter(rate=0, burst=0)
    assert all(limiter.allow("a") for _ in range(1000))


def test_profile_creation_is_limited_per_address(limited: TestClient) -> None:
    assert [limited.post("/api/players").status_code for _ in range(4)] == [201, 201, 201, 429]
    refused = limited.post("/api/players")
    assert refused.headers["retry-after"] == "60"
    # Reading is not limited.
    assert limited.get("/api/leaderboard").status_code == 200


def test_room_creation_is_limited_per_address(limited: TestClient) -> None:
    token = limited.post("/api/players").json()["token"]
    codes = [limited.post("/api/rooms", headers=auth(token)).status_code for _ in range(3)]
    assert codes == [201, 201, 429]


def test_connections_per_address_are_limited(limited: TestClient) -> None:
    tokens = [limited.post("/api/players").json()["token"] for _ in range(3)]
    code = limited.post("/api/rooms", headers=auth(tokens[0])).json()["code"]

    def hello(ws: Any, token: str) -> None:
        ws.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": token})

    path = f"/ws/{code}"
    with limited.websocket_connect(path) as a, limited.websocket_connect(path) as b:
        hello(a, tokens[0])
        hello(b, tokens[1])
        a.receive_json()
        b.receive_json()
        with pytest.raises(WebSocketDisconnect) as closed, limited.websocket_connect(path) as c:
            c.receive_json()
        assert closed.value.code == CloseCode.TOO_MANY_CONNECTIONS
    # Closed connections free their place.
    with limited.websocket_connect(path) as again:
        hello(again, tokens[2])
        assert again.receive_json()["t"] == "welcome"


def test_message_flood_closes_the_connection(limited: TestClient) -> None:
    token = limited.post("/api/players").json()["token"]
    code = limited.post("/api/rooms", headers=auth(token)).json()["code"]
    with (
        pytest.raises(WebSocketDisconnect) as closed,
        limited.websocket_connect(f"/ws/{code}") as ws,
    ):
        ws.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": token})
        for i in range(MESSAGE_BURST + 300):
            ws.send_json({"t": "ping", "id": i})
        for _ in range(MESSAGE_BURST + 2000):
            ws.receive_json()
    assert closed.value.code == CloseCode.TOO_FAST


def test_metrics_report_rooms_and_players(limited: TestClient) -> None:
    token = limited.post("/api/players").json()["token"]
    code = limited.post("/api/rooms", headers=auth(token)).json()["code"]

    def metrics() -> dict[str, float]:
        lines = limited.get("/metrics").text.splitlines()
        return {name: float(value) for name, value in (line.split() for line in lines)}

    assert metrics()["arena_rooms"] == 1
    assert metrics()["arena_players"] == 0
    with limited.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": token})
        for _ in range(10):
            ws.receive_json()
        current = metrics()
        assert current["arena_players"] == 1
        assert current["arena_rooms_active"] == 1
        assert 0 < current["arena_tick_seconds_max"] < 0.5
        assert current["arena_matches_saved_total"] == 0


def test_other_players_are_sent_with_reduced_precision(limited: TestClient) -> None:
    tokens = [limited.post("/api/players").json()["token"] for _ in range(2)]
    code = limited.post("/api/rooms", headers=auth(tokens[0])).json()["code"]
    path = f"/ws/{code}"
    with limited.websocket_connect(path) as a, limited.websocket_connect(path) as b:
        a.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": tokens[0]})
        b.send_json({"t": "hello", "v": PROTOCOL_VERSION, "token": tokens[1]})
        for _ in range(200):
            message = a.receive_json()
            if message["t"] == "snapshot" and message["players"]:
                break
        other = message["players"][0]
        assert all(round(axis, 3) == axis for axis in other["pos"])
        assert round(other["yaw"], 3) == other["yaw"]


def record(message: str, **extra: Any) -> logging.LogRecord:
    return logging.makeLogRecord(
        {"name": "arena.room", "levelname": "INFO", "msg": message, **extra}
    )


def test_json_log_lines_carry_fields() -> None:
    line = Formatter(as_json=True).format(record("match_started", room="AB12", players=2))
    entry = json.loads(line)
    assert entry["msg"] == "match_started"
    assert (entry["room"], entry["players"], entry["level"]) == ("AB12", 2, "info")
    assert entry["ts"].endswith("Z")


def test_text_log_lines_are_readable() -> None:
    line = Formatter().format(record("player_joined", room="AB12", players=3))
    assert line.endswith("arena.room: player_joined room=AB12 players=3")
