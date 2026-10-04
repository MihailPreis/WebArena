from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from arena.db.database import Database
from arena.db.players import Player, get_player_by_token
from arena.game.rooms import RoomRegistry


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


Db = Annotated[Database, Depends(get_db)]
Rooms = Annotated[RoomRegistry, Depends(get_rooms)]
CurrentPlayer = Annotated[Player, Depends(get_current_player)]
