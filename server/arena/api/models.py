import re
import unicodedata
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from arena.shared import PROFILE, ROOM

_COLOR_RE = re.compile(r"#[0-9a-f]{6}")


class ApiModel(BaseModel):
    """JSON uses camelCase, matching the client and shared constants."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def _clean_name(value: str) -> str:
    value = value.strip()
    if not 1 <= len(value) <= PROFILE["nameMaxLength"]:
        raise ValueError(f"name must be 1 to {PROFILE['nameMaxLength']} characters long")
    # Category C covers control, format and other invisible characters.
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("name must not contain control characters")
    return value


def relative_luminance(color: str) -> float:
    """WCAG relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white)."""

    def linear(channel: int) -> float:
        value = channel / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    r, g, b = (int(color[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)


def _clean_color(value: str) -> str:
    value = value.lower()
    if not _COLOR_RE.fullmatch(value):
        raise ValueError("color must look like #rrggbb")
    # Names and players are shown on dark backgrounds; a near-black colour would be invisible.
    if relative_luminance(value) < PROFILE["minColorLuminance"]:
        raise ValueError("color is too dark")
    return value


Name = Annotated[str, AfterValidator(_clean_name)]
PlayerColor = Annotated[str, AfterValidator(_clean_color)]


class PlayerOut(ApiModel):
    id: str
    name: str
    color: str


class PlayerCreated(PlayerOut):
    token: str


class PlayerUpdate(ApiModel):
    name: Name | None = None
    color: PlayerColor | None = None


def _limit(key: str) -> tuple[int, int, int]:
    limit = ROOM[key]
    return limit["min"], limit["max"], limit["default"]


_KILL_MIN, _KILL_MAX, _KILL_DEFAULT = _limit("killLimit")
_TIME_MIN, _TIME_MAX, _TIME_DEFAULT = _limit("timeLimitMin")
_PLAYERS_MIN, _PLAYERS_MAX, _PLAYERS_DEFAULT = _limit("maxPlayers")


class RoomSettings(ApiModel):
    # Team deathmatch will be added here later.
    mode: Literal["deathmatch"] = "deathmatch"
    kill_limit: int = Field(_KILL_DEFAULT, ge=_KILL_MIN, le=_KILL_MAX)
    time_limit_min: int = Field(_TIME_DEFAULT, ge=_TIME_MIN, le=_TIME_MAX)
    max_players: int = Field(_PLAYERS_DEFAULT, ge=_PLAYERS_MIN, le=_PLAYERS_MAX)


class RoomOut(ApiModel):
    code: str
    host_id: str
    players: int
    settings: RoomSettings
