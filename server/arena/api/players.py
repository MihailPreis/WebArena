import secrets

from fastapi import APIRouter

from arena.api.deps import CurrentPlayer, Db
from arena.api.models import PlayerCreated, PlayerOut, PlayerUpdate
from arena.db import players
from arena.shared import PROFILE

router = APIRouter(prefix="/api/players")


@router.post("", status_code=201)
async def create_player(db: Db) -> PlayerCreated:
    player, token = await players.create_player(
        db, PROFILE["defaultName"], secrets.choice(PROFILE["colors"])
    )
    # The only response that ever carries the token.
    return PlayerCreated(id=player.id, name=player.name, color=player.color, token=token)


@router.get("/me")
async def get_me(db: Db, player: CurrentPlayer) -> PlayerOut:
    await players.touch_player(db, player.id)
    return PlayerOut(id=player.id, name=player.name, color=player.color)


@router.patch("/me")
async def update_me(db: Db, player: CurrentPlayer, update: PlayerUpdate) -> PlayerOut:
    updated = await players.update_player(db, player, update.name, update.color)
    return PlayerOut(id=updated.id, name=updated.name, color=updated.color)
