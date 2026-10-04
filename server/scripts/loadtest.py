"""Load test: fills rooms with bots that move and shoot like real clients.

Start a server with the per-address limits off, then point this script at it:

    ARENA_PROFILES_PER_MINUTE=0 ARENA_ROOMS_PER_MINUTE=0 ARENA_WS_MAX_PER_IP=0 \\
        uv run python -m arena
    uv run python scripts/loadtest.py --rooms 4 --players 8 --seconds 20

It reports how steadily snapshots arrive (the server aims at 30 a second) and
how long the server's ticks take, read from its /metrics endpoint.
"""

import argparse
import asyncio
import json
import math
import random
import statistics
import time
import urllib.request
from typing import Any

import websockets

from arena.shared import CONSTANTS

TICK_RATE: int = CONSTANTS["tickRate"]
SNAPSHOT_RATE: int = CONSTANTS["net"]["snapshotRate"]
PROTOCOL_VERSION: int = CONSTANTS["net"]["protocolVersion"]


def call(base: str, path: str, token: str | None = None, body: Any = None) -> Any:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    method = "POST" if data is not None or path in ("/api/players", "/api/rooms") else "GET"
    request = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request) as response:
        text = response.read().decode()
    return json.loads(text) if text.startswith(("{", "[")) else text


async def bot(ws_base: str, code: str, token: str, seconds: float, intervals: list[float]) -> int:
    """Plays for `seconds`; records gaps between snapshots and returns how many arrived."""
    rng = random.Random(token)
    snapshots = 0
    server_time = 0.0
    async with websockets.connect(f"{ws_base}/ws/{code}") as ws:
        await ws.send(json.dumps({"t": "hello", "v": PROTOCOL_VERSION, "token": token}))

        async def receive() -> None:
            nonlocal snapshots, server_time
            last = None
            async for raw in ws:
                message = json.loads(raw)
                if message["t"] != "snapshot":
                    continue
                now = time.perf_counter()
                if last is not None:
                    intervals.append(now - last)
                last = now
                snapshots += 1
                server_time = message["tick"] / SNAPSHOT_RATE

        receiver = asyncio.create_task(receive())
        started = time.perf_counter()
        seq = 0
        yaw = rng.uniform(-math.pi, math.pi)
        turn = rng.uniform(-0.05, 0.05)
        try:
            while (elapsed := time.perf_counter() - started) < seconds:
                # Catch up to real time, as a browser does after a slow frame.
                while seq < elapsed * TICK_RATE:
                    if seq % 90 == 0:
                        turn = rng.uniform(-0.05, 0.05)
                    yaw = (yaw + turn + math.pi) % (2 * math.pi) - math.pi
                    await ws.send(
                        json.dumps(
                            {
                                "t": "input",
                                "seq": seq,
                                "f": 1,
                                "r": rng.choice((-1, 0, 1)) if seq % 30 == 0 else 0,
                                "j": seq % 70 == 0,
                                "c": False,
                                "s": seq % 200 < 100,
                                "yaw": yaw,
                                "pitch": 0,
                                "fire": seq % 3 == 0,
                                "reload": False,
                                "rt": max(server_time - 0.1, 0),
                            }
                        )
                    )
                    seq += 1
                await asyncio.sleep(1 / TICK_RATE)
        finally:
            receiver.cancel()
    return snapshots


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--rooms", type=int, default=1)
    parser.add_argument("--players", type=int, default=8)
    parser.add_argument("--seconds", type=float, default=15)
    args = parser.parse_args()
    ws_base = args.url.replace("http", "ws", 1)

    intervals: list[float] = []
    bots = []
    for _ in range(args.rooms):
        tokens = [call(args.url, "/api/players")["token"] for _ in range(args.players)]
        code = call(args.url, "/api/rooms", tokens[0], {"maxPlayers": max(args.players, 2)})["code"]
        bots += [bot(ws_base, code, token, args.seconds, intervals) for token in tokens]

    counts = await asyncio.gather(*bots)
    metrics = dict(line.split() for line in call(args.url, "/metrics").splitlines())

    ideal = 1 / SNAPSHOT_RATE
    ordered = sorted(intervals)
    late = sum(1 for gap in intervals if gap > 2 * ideal) / len(intervals)
    print(f"rooms {args.rooms} x players {args.players} = {len(bots)} bots, {args.seconds:g} s")
    print(f"snapshots per second per bot: {statistics.mean(counts) / args.seconds:.1f}")
    print(
        "gap between snapshots, ms:"
        f" median {statistics.median(ordered) * 1000:.1f},"
        f" p99 {ordered[int(len(ordered) * 0.99)] * 1000:.1f},"
        f" max {ordered[-1] * 1000:.1f}"
    )
    print(f"gaps longer than two ticks: {late:.2%}")
    print(
        "server tick, ms:"
        f" avg {float(metrics['arena_tick_seconds_avg']) * 1000:.2f},"
        f" max {float(metrics['arena_tick_seconds_max']) * 1000:.2f}"
        f" (budget {ideal * 1000:.1f})"
    )


if __name__ == "__main__":
    asyncio.run(main())
