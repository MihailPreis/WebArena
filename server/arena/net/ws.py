import asyncio
import contextlib
import logging
from collections import Counter

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from arena.config import Settings
from arena.db.database import Database
from arena.db.players import get_player_by_token
from arena.game.room import Member, Room, RoomFull
from arena.game.rooms import RoomRegistry
from arena.net.protocol import (
    CLIENT_MESSAGE,
    PROTOCOL_VERSION,
    CloseCode,
    Hello,
    InputMsg,
    PingMsg,
    SettingsMsg,
    encode,
)
from arena.ratelimit import RateLimiter

log = logging.getLogger("arena.net")

router = APIRouter()

HELLO_TIMEOUT_S = 5
# About two seconds of snapshots; a client further behind than that is dropped.
OUTBOX_SIZE = 64
# A client sends 60 inputs a second and may briefly catch up after a stall.
MESSAGES_PER_SECOND = 240
MESSAGE_BURST = 480


class WsConnection:
    """Queues outgoing messages so the game loop never waits on a slow socket."""

    def __init__(self, websocket: WebSocket) -> None:
        self._websocket = websocket
        self._queue: asyncio.Queue[str | int] = asyncio.Queue(maxsize=OUTBOX_SIZE)
        self._closing = False

    def send(self, text: str) -> None:
        if self._closing:
            return
        try:
            self._queue.put_nowait(text)
        except asyncio.QueueFull:
            self.close(CloseCode.TOO_SLOW)

    def close(self, code: int) -> None:
        if self._closing:
            return
        self._closing = True
        # Whatever is still queued no longer matters; make room for the close itself.
        while not self._queue.empty():
            self._queue.get_nowait()
        self._queue.put_nowait(int(code))

    async def write(self) -> None:
        """Sends queued messages until told to close."""
        # The socket may already be gone when we get to it; that just ends the session.
        with contextlib.suppress(WebSocketDisconnect, RuntimeError):
            while True:
                item = await self._queue.get()
                if isinstance(item, int):
                    await self._websocket.close(code=item)
                    return
                await self._websocket.send_text(item)


async def _read(websocket: WebSocket, room: Room, member: Member, conn: WsConnection) -> None:
    flood = RateLimiter(MESSAGES_PER_SECOND, MESSAGE_BURST)
    while True:
        refusal: CloseCode | None = None
        try:
            text = await websocket.receive_text()
            if flood.allow(""):
                message = CLIENT_MESSAGE.validate_json(text)
            else:
                refusal = CloseCode.TOO_FAST
        except WebSocketDisconnect:
            return
        except (ValidationError, KeyError):  # KeyError: a binary frame instead of text.
            refusal = CloseCode.BAD_MESSAGE
        if refusal is not None:
            log.warning(
                "client_dropped",
                extra={"room": room.code, "player": member.player.id, "reason": refusal.name},
            )
            conn.close(refusal)
            await asyncio.Event().wait()  # The writer closes the socket and ends the session.
            return
        if isinstance(message, InputMsg):
            room.receive_input(member, message.seq, message.to_cmd(), message.rt)
        elif isinstance(message, PingMsg):
            member.ping = message.rtt
            conn.send(encode({"t": "pong", "id": message.id}))
        elif isinstance(message, SettingsMsg):
            room.change_settings(member, message.mode, message.killLimit, message.timeLimitMin)
        else:
            room.change_team(member, message.team)


@router.websocket("/ws/{code}")
async def game_socket(websocket: WebSocket, code: str) -> None:
    await websocket.accept()
    rooms: RoomRegistry = websocket.app.state.rooms
    db: Database = websocket.app.state.db

    settings: Settings = websocket.app.state.settings
    connections: Counter[str] = websocket.app.state.ws_connections
    address = websocket.client.host if websocket.client else "unknown"
    if 0 < settings.ws_max_per_ip <= connections[address]:
        await websocket.close(code=CloseCode.TOO_MANY_CONNECTIONS)
        return
    connections[address] += 1
    try:
        await _session(websocket, rooms, db, code)
    finally:
        connections[address] -= 1
        if connections[address] <= 0:
            del connections[address]


async def _session(websocket: WebSocket, rooms: RoomRegistry, db: Database, code: str) -> None:
    room = rooms.get(code)
    if room is None:
        await websocket.close(code=CloseCode.ROOM_NOT_FOUND)
        return
    try:
        async with asyncio.timeout(HELLO_TIMEOUT_S):
            hello = Hello.model_validate_json(await websocket.receive_text())
    except WebSocketDisconnect:
        return
    except (ValidationError, TimeoutError, KeyError):
        await websocket.close(code=CloseCode.BAD_MESSAGE)
        return
    if hello.v != PROTOCOL_VERSION:
        await websocket.close(code=CloseCode.VERSION_MISMATCH)
        return
    player = await get_player_by_token(db, hello.token)
    if player is None:
        await websocket.close(code=CloseCode.BAD_TOKEN)
        return

    conn = WsConnection(websocket)
    try:
        member = room.join(player, conn)
    except RoomFull:
        await websocket.close(code=CloseCode.ROOM_FULL)
        return
    room.ensure_running()

    tasks = {
        asyncio.create_task(conn.write()),
        asyncio.create_task(_read(websocket, room, member, conn)),
    }
    try:
        # The session ends when the client disconnects or the server closes the socket.
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        # No awaits here: this must also run to the end when the session itself is cancelled.
        room.leave(member, conn)
        for task in tasks:
            task.cancel()
