import secrets

from fastapi import APIRouter, HTTPException

from arena.api.deps import CurrentPlayer, Db
from arena.api.models import PlayerCreated, PlayerOut, PlayerStatsOut, PlayerUpdate
from arena.db import players, stats
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


@router.get("/{player_id}")
async def get_player(db: Db, player_id: str) -> PlayerStatsOut:
    """Public statistics of any player."""
    found = await stats.player_stats(db, player_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    return PlayerStatsOut(
        id=found.id,
        name=found.name,
        color=found.color,
        matches=found.matches,
        wins=found.wins,
        kills=found.kills,
        deaths=found.deaths,
        kd=round(found.kd, 2),
        headshots=found.headshots,
        shots=found.shots,
        hits=found.hits,
        accuracy=round(found.accuracy, 3),
        damage_dealt=found.damage_dealt,
        playtime_s=found.playtime_s,
    )
