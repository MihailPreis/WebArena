"""Wire protocol. Mirrors client/src/game/net/protocol.ts — change both together."""

import json
from enum import IntEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from arena.game.movement import InputCmd, PlayerState
from arena.shared import CONSTANTS, ROOM

PROTOCOL_VERSION: int = CONSTANTS["net"]["protocolVersion"]


class CloseCode(IntEnum):
    """WebSocket close codes in the application range."""

    BAD_MESSAGE = 4000
    BAD_TOKEN = 4001
    ROOM_FULL = 4002
    ROOM_NOT_FOUND = 4003
    VERSION_MISMATCH = 4004
    REPLACED = 4005
    TOO_SLOW = 4006
    TOO_FAST = 4007
    TOO_MANY_CONNECTIONS = 4008


class _ClientModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Hello(_ClientModel):
    t: Literal["hello"]
    v: int
    token: str = Field(max_length=200)


class InputMsg(_ClientModel):
    t: Literal["input"]
    seq: int = Field(ge=0)
    # JSON has one number type, so whole numbers such as 0 and 1 must pass as floats.
    f: Annotated[float, Field(ge=-1, le=1, strict=False)]
    r: Annotated[float, Field(ge=-1, le=1, strict=False)]
    j: bool
    c: bool
    s: bool
    yaw: Annotated[float, Field(ge=-7, le=7, strict=False)]
    pitch: Annotated[float, Field(ge=-1.6, le=1.6, strict=False)]
    fire: bool
    reload: bool
    # Server time the client was drawing other players at; used for lag compensation.
    rt: Annotated[float, Field(ge=0, le=1e9, strict=False)]

    def to_cmd(self) -> InputCmd:
        return InputCmd(
            forward=self.f,
            right=self.r,
            jump=self.j,
            crouch=self.c,
            sprint=self.s,
            yaw=self.yaw,
            pitch=self.pitch,
            fire=self.fire,
            reload=self.reload,
        )


class PingMsg(_ClientModel):
    t: Literal["ping"]
    id: int
    # The client's latest measured round trip, shown to others in the score table.
    rtt: int = Field(0, ge=0, le=9999)


class SettingsMsg(_ClientModel):
    """The host changes the rules for the next match."""

    t: Literal["settings"]
    mode: Literal["deathmatch", "team-deathmatch"]
    killLimit: int = Field(ge=ROOM["killLimit"]["min"], le=ROOM["killLimit"]["max"])
    timeLimitMin: int = Field(ge=ROOM["timeLimitMin"]["min"], le=ROOM["timeLimitMin"]["max"])


class TeamMsg(_ClientModel):
    """The player asks to switch sides."""

    t: Literal["team"]
    team: Literal["blue", "red"]


ClientMessage = Annotated[InputMsg | PingMsg | SettingsMsg | TeamMsg, Field(discriminator="t")]
CLIENT_MESSAGE: TypeAdapter[InputMsg | PingMsg | SettingsMsg | TeamMsg] = TypeAdapter(ClientMessage)


def encode(message: dict[str, Any]) -> str:
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False)


def state_json(state: PlayerState) -> dict[str, Any]:
    """Full state of a player, in the shape of the client's `PlayerState`."""
    return {
        "pos": state.pos,
        "vel": state.vel,
        "yaw": state.yaw,
        "pitch": state.pitch,
        "onGround": state.on_ground,
        "crouched": state.crouched,
        "jumpHeld": state.jump_held,
    }
