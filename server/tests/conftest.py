import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from arena.config import Settings
from arena.main import create_app


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "data" / "arena.db"


@pytest.fixture
def api(db_path: Path, tmp_path: Path) -> Iterator[TestClient]:
    """Client with a running app lifespan, i.e. with a connected database."""
    settings = Settings(
        db_path=db_path, client_dist=tmp_path / "dist", profiles_per_minute=0, rooms_per_minute=0
    )
    with TestClient(create_app(settings)) as client:
        yield client


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class FakeConn:
    """Stands in for a client connection and records what the room sends."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed: int | None = None

    def send(self, text: str) -> None:
        self.sent.append(json.loads(text))

    def close(self, code: int) -> None:
        self.closed = code

    def last(self, kind: str) -> dict[str, Any]:
        return next(m for m in reversed(self.sent) if m["t"] == kind)


def wait_for(condition: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condition was not met in time")
        time.sleep(0.02)
