import time
from typing import Annotated

from fastapi import APIRouter, Query, Request

from arena.api.deps import Db
from arena.api.models import LeaderboardOut, LeaderboardRow
from arena.config import Settings
from arena.db import stats
from arena.db.stats import LeaderboardKind

router = APIRouter(prefix="/api/leaderboard")


@router.get("")
async def get_leaderboard(
    request: Request, db: Db, by: Annotated[LeaderboardKind, Query()] = "kd"
) -> LeaderboardOut:
    settings: Settings = request.app.state.settings
    # The home page asks for this on every visit; the answer changes only when a match ends.
    cache: dict[str, tuple[float, LeaderboardOut]] = request.app.state.leaderboard_cache
    cached = cache.get(by)
    if cached and time.monotonic() - cached[0] < settings.leaderboard_cache_s:
        return cached[1]

    rows = await stats.leaderboard(db, by, settings.leaderboard_min_kills)
    result = LeaderboardOut(
        by=by,
        min_kills=settings.leaderboard_min_kills,
        players=[
            LeaderboardRow(
                id=row.id,
                name=row.name,
                color=row.color,
                matches=row.matches,
                wins=row.wins,
                kills=row.kills,
                deaths=row.deaths,
                kd=round(row.kd, 2),
            )
            for row in rows
        ],
    )
    cache[by] = (time.monotonic(), result)
    return result
