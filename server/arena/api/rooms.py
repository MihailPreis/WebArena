from fastapi import APIRouter, Depends, HTTPException

from arena.api.deps import CurrentPlayer, Rooms, rate_limited
from arena.api.models import RoomOut, RoomSettings
from arena.game.room import MatchSettings, Room
from arena.game.rooms import RoomCodesExhausted

router = APIRouter(prefix="/api/rooms")


def _room_out(room: Room) -> RoomOut:
    return RoomOut(
        code=room.code,
        host_id=room.host_id,
        players=len(room.connected),
        settings=RoomSettings(
            mode=room.settings.mode,
            map=room.map.name,
            kill_limit=room.settings.kill_limit,
            time_limit_min=room.settings.time_limit_min,
            max_players=room.settings.max_players,
        ),
    )


@router.post("", status_code=201, dependencies=[Depends(rate_limited("rooms"))])
async def create_room(
    rooms: Rooms, player: CurrentPlayer, settings: RoomSettings | None = None
) -> RoomOut:
    settings = settings or RoomSettings()
    if settings.map not in rooms.maps:
        raise HTTPException(status_code=422, detail="This map is not available.")
    try:
        room = rooms.create(
            player.id,
            settings.map,
            MatchSettings(
                mode=settings.mode,
                kill_limit=settings.kill_limit,
                time_limit_min=settings.time_limit_min,
                max_players=settings.max_players,
            ),
        )
    except RoomCodesExhausted:
        raise HTTPException(status_code=503, detail="No free room codes.") from None
    return _room_out(room)


@router.get("/{code}")
async def get_room(rooms: Rooms, code: str) -> RoomOut:
    room = rooms.get(code)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found.")
    return _room_out(room)
