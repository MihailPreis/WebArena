from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from arena.db.database import Database
from arena.db.players import Player, get_player_by_token
from arena.game.rooms import RoomRegistry
from arena.ratelimit import RateLimiter


def get_db(request: Request) -> Database:
    db: Database = request.app.state.db
    return db


def get_rooms(request: Request) -> RoomRegistry:
    rooms: RoomRegistry = request.app.state.rooms
    return rooms


async def get_current_player(
    db: Annotated[Database, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> Player:
    scheme, _, token = (authorization or "").partition(" ")
    player = await get_player_by_token(db, token) if scheme.lower() == "bearer" and token else None
    if player is None:
        raise HTTPException(status_code=401, detail="Unknown player token.")
    return player


def rate_limited(name: str) -> Callable[[Request], None]:
    """Dependency that refuses a request when its address exceeds the named limit."""

    def check(request: Request) -> None:
        limiter: RateLimiter = request.app.state.limiters[name]
        address = request.client.host if request.client else "unknown"
        if not limiter.allow(address):
            raise HTTPException(
                status_code=429, detail="Too many requests.", headers={"Retry-After": "60"}
            )

    return check


Db = Annotated[Database, Depends(get_db)]
Rooms = Annotated[RoomRegistry, Depends(get_rooms)]
CurrentPlayer = Annotated[Player, Depends(get_current_player)]
