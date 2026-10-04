from collections.abc import Iterator
from pathlib import Path

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
    settings = Settings(db_path=db_path, client_dist=tmp_path / "dist")
    with TestClient(create_app(settings)) as client:
        yield client


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
