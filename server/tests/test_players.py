import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from arena.api.models import relative_luminance
from arena.config import Settings
from arena.main import create_app
from arena.shared import PROFILE
from tests.conftest import auth


def test_create_player_returns_token_and_defaults(api: TestClient) -> None:
    response = api.post("/api/players")
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Player"
    assert body["color"] in PROFILE["colors"]
    assert body["id"] != body["token"]
    assert len(body["token"]) >= 32


def test_token_is_stored_only_as_hash(api: TestClient, db_path: Path) -> None:
    token = api.post("/api/players").json()["token"]
    rows = sqlite3.connect(db_path).execute("SELECT * FROM players").fetchall()
    assert len(rows) == 1
    assert token not in rows[0]


def test_me_requires_a_valid_token(api: TestClient) -> None:
    assert api.get("/api/players/me").status_code == 401
    assert api.get("/api/players/me", headers=auth("nope")).status_code == 401
    assert api.get("/api/players/me", headers={"Authorization": "nope"}).status_code == 401


def test_me_never_returns_the_token(api: TestClient) -> None:
    created = api.post("/api/players").json()
    response = api.get("/api/players/me", headers=auth(created["token"]))
    assert response.status_code == 200
    assert response.json() == {k: created[k] for k in ("id", "name", "color")}


def test_update_name_and_color(api: TestClient) -> None:
    token = api.post("/api/players").json()["token"]
    response = api.patch("/api/players/me", headers=auth(token), json={"name": "  Миша  "})
    assert response.json()["name"] == "Миша"
    response = api.patch("/api/players/me", headers=auth(token), json={"color": "#FFAA00"})
    assert response.json() == {**response.json(), "name": "Миша", "color": "#ffaa00"}
    assert api.get("/api/players/me", headers=auth(token)).json()["name"] == "Миша"


@pytest.mark.parametrize(
    "update",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 17},
        {"name": "bad\nname"},
        {"name": "zero​width"},
        {"color": "red"},
        {"color": "#12345"},
        {"color": "#000000"},
        {"color": "#101020"},
        {"id": "other"},
    ],
)
def test_update_rejects_invalid_values(api: TestClient, update: dict[str, str]) -> None:
    token = api.post("/api/players").json()["token"]
    assert api.patch("/api/players/me", headers=auth(token), json=update).status_code == 422


def test_palette_colors_pass_validation() -> None:
    for color in PROFILE["colors"]:
        assert relative_luminance(color) >= PROFILE["minColorLuminance"]


def test_profile_survives_restart(db_path: Path, tmp_path: Path) -> None:
    settings = Settings(db_path=db_path, client_dist=tmp_path / "dist")
    with TestClient(create_app(settings)) as first:
        token = first.post("/api/players").json()["token"]
        first.patch("/api/players/me", headers=auth(token), json={"name": "Keeper"})
    with TestClient(create_app(settings)) as second:
        assert second.get("/api/players/me", headers=auth(token)).json()["name"] == "Keeper"
