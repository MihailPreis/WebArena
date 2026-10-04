from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from arena.config import Settings
from arena.main import create_app


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('arena')")
    (tmp_path / "index.html").write_text("<title>index</title>")
    (tmp_path / "game.html").write_text("<title>game</title>")
    return tmp_path


@pytest.fixture
def client(dist: Path, tmp_path: Path) -> TestClient:
    return TestClient(create_app(Settings(client_dist=dist, db_path=tmp_path / "arena.db")))


def test_healthz(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_index_page(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "index" in response.text


def test_game_page(client: TestClient) -> None:
    response = client.get("/game/AB12")
    assert response.status_code == 200
    assert "game" in response.text


@pytest.mark.parametrize("code", ["ab12", "ABC", "ABCDE", "AB-1"])
def test_game_page_rejects_invalid_code(client: TestClient, code: str) -> None:
    assert client.get(f"/game/{code}").status_code == 404


def test_assets_are_served(client: TestClient) -> None:
    response = client.get("/assets/app.js")
    assert response.status_code == 200
    assert "arena" in response.text


def test_pages_missing_without_build(tmp_path: Path) -> None:
    settings = Settings(client_dist=tmp_path / "missing", db_path=tmp_path / "arena.db")
    client = TestClient(create_app(settings))
    assert client.get("/").status_code == 404
    assert client.get("/healthz").status_code == 200


def test_settings_from_env() -> None:
    settings = Settings.from_env(
        {"ARENA_PORT": "9000", "ARENA_DB_PATH": "/data/arena.db", "ARENA_HOST": "0.0.0.0"}
    )
    assert settings.port == 9000
    assert settings.db_path == Path("/data/arena.db")
    assert settings.host == "0.0.0.0"
    assert settings.client_dist == Settings().client_dist
