from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from arena.net.protocol import PROTOCOL_VERSION, CloseCode
from tests.conftest import auth


def new_player(api: TestClient) -> dict[str, str]:
    player: dict[str, str] = api.post("/api/players").json()
    return player


def new_room(api: TestClient, token: str, **settings: int) -> str:
    code: str = api.post("/api/rooms", headers=auth(token), json=settings).json()["code"]
    return code


def hello(token: str, version: int = PROTOCOL_VERSION) -> dict[str, Any]:
    return {"t": "hello", "v": version, "token": token}


def receive(ws: Any, kind: str, limit: int = 200) -> dict[str, Any]:
    """Next message of the given type, skipping the snapshots that arrive in between."""
    for _ in range(limit):
        message: dict[str, Any] = ws.receive_json()
        if message["t"] == kind:
            return message
    raise AssertionError(f"no {kind} message arrived")


def receive_event(ws: Any, name: str) -> dict[str, Any]:
    for _ in range(50):
        event = receive(ws, "event")
        if event["e"] == name:
            return event
    raise AssertionError(f"no {name} event arrived")


def close_code(api: TestClient, path: str, first_message: dict[str, Any] | None) -> int:
    with pytest.raises(WebSocketDisconnect) as closed, api.websocket_connect(path) as ws:
        if first_message is not None:
            ws.send_json(first_message)
        ws.receive_json()
    return closed.value.code


def test_handshake_and_presence(api: TestClient) -> None:
    host = new_player(api)
    code = new_room(api, host["token"])
    with api.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json(hello(host["token"]))
        welcome = receive(ws, "welcome")
        assert welcome["id"] == host["id"]
        assert welcome["v"] == PROTOCOL_VERSION
        assert api.get(f"/api/rooms/{code}").json()["players"] == 1
    assert api.get(f"/api/rooms/{code}").json()["players"] == 0


def test_inputs_are_acknowledged_in_snapshots(api: TestClient) -> None:
    host = new_player(api)
    code = new_room(api, host["token"])
    with api.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json(hello(host["token"]))
        receive(ws, "welcome")
        for seq in range(4):
            ws.send_json(
                {"t": "input", "seq": seq, "f": 1, "r": 0, "j": False, "c": False, "s": False,
                 "yaw": 0.5, "pitch": 0, "fire": False, "reload": False, "rt": 0}
            )  # fmt: skip
        for _ in range(200):
            snapshot = receive(ws, "snapshot")
            if snapshot["ack"] == 3:
                break
        assert snapshot["ack"] == 3
        assert snapshot["you"]["yaw"] == 0.5

        ws.send_json({"t": "ping", "id": 42})
        assert receive(ws, "pong") == {"t": "pong", "id": 42}


def test_players_see_each_other(api: TestClient) -> None:
    host, guest = new_player(api), new_player(api)
    code = new_room(api, host["token"])
    with api.websocket_connect(f"/ws/{code}") as first:
        first.send_json(hello(host["token"]))
        receive(first, "welcome")
        with api.websocket_connect(f"/ws/{code}") as second:
            second.send_json(hello(guest["token"]))
            assert [p["id"] for p in receive(second, "welcome")["players"]] == [host["id"]]
            joined = receive_event(first, "join")
            assert joined["player"] == {k: guest[k] for k in ("id", "name", "color")}
            assert [p["id"] for p in receive(second, "snapshot")["players"]] == [host["id"]]
        left = receive_event(first, "leave")
        assert left == {"t": "event", "e": "leave", "id": guest["id"]}


def test_connection_is_refused_with_a_reason(api: TestClient) -> None:
    host, guest, third = new_player(api), new_player(api), new_player(api)
    code = new_room(api, host["token"], maxPlayers=2)

    assert close_code(api, "/ws/ZZZZ", None) == CloseCode.ROOM_NOT_FOUND
    assert close_code(api, f"/ws/{code}", hello("wrong")) == CloseCode.BAD_TOKEN
    assert close_code(api, f"/ws/{code}", hello(host["token"], 999)) == CloseCode.VERSION_MISMATCH
    assert close_code(api, f"/ws/{code}", {"t": "input"}) == CloseCode.BAD_MESSAGE

    with api.websocket_connect(f"/ws/{code}") as a, api.websocket_connect(f"/ws/{code}") as b:
        a.send_json(hello(host["token"]))
        b.send_json(hello(guest["token"]))
        receive(a, "welcome")
        receive(b, "welcome")
        assert close_code(api, f"/ws/{code}", hello(third["token"])) == CloseCode.ROOM_FULL


@pytest.mark.parametrize(
    "message",
    [
        {"t": "input", "seq": 0, "f": 5, "r": 0, "j": False, "c": False, "s": False,
         "yaw": 0, "pitch": 0, "fire": False, "reload": False, "rt": 0},
        {"t": "input", "seq": -1, "f": 0, "r": 0, "j": False, "c": False, "s": False,
         "yaw": 0, "pitch": 0, "fire": False, "reload": False, "rt": 0},
        {"t": "input", "seq": 0, "f": 0, "r": 0, "j": "yes", "c": False, "s": False,
         "yaw": 0, "pitch": 0, "fire": False, "reload": False, "rt": 0},
        {"t": "teleport", "pos": [0, 0, 0]},
        {"t": "ping"},
    ],
)  # fmt: skip
def test_malformed_message_closes_only_that_connection(
    api: TestClient, message: dict[str, Any]
) -> None:
    host, guest = new_player(api), new_player(api)
    code = new_room(api, host["token"])
    with api.websocket_connect(f"/ws/{code}") as good:
        good.send_json(hello(host["token"]))
        receive(good, "welcome")
        with (
            pytest.raises(WebSocketDisconnect) as closed,
            api.websocket_connect(f"/ws/{code}") as bad,
        ):
            bad.send_json(hello(guest["token"]))
            receive(bad, "welcome")
            bad.send_json(message)
            receive(bad, "never")
        assert closed.value.code == CloseCode.BAD_MESSAGE
        # The room keeps running for everyone else.
        receive_event(good, "join")
        receive_event(good, "leave")
        receive(good, "snapshot")


def test_ping_report_and_host_settings(api: TestClient) -> None:
    host = new_player(api)
    code = new_room(api, host["token"])
    with api.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json(hello(host["token"]))
        receive(ws, "welcome")
        assert receive(ws, "room")["hostId"] == host["id"]

        ws.send_json({"t": "ping", "id": 1, "rtt": 57})
        receive(ws, "pong")
        ws.send_json({"t": "settings", "killLimit": 40, "timeLimitMin": 3})
        state = receive(ws, "room")
        assert state["settings"]["killLimit"] == 40
        assert state["players"][0]["ping"] == 57
        assert api.get(f"/api/rooms/{code}").json()["settings"]["timeLimitMin"] == 3


def test_out_of_range_settings_are_a_protocol_error(api: TestClient) -> None:
    host = new_player(api)
    code = new_room(api, host["token"])
    with pytest.raises(WebSocketDisconnect) as closed, api.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json(hello(host["token"]))
        receive(ws, "welcome")
        ws.send_json({"t": "settings", "killLimit": 100000, "timeLimitMin": 3})
        receive(ws, "never")
    assert closed.value.code == CloseCode.BAD_MESSAGE


def test_binary_frames_are_a_protocol_error(api: TestClient) -> None:
    host = new_player(api)
    code = new_room(api, host["token"])
    with pytest.raises(WebSocketDisconnect) as closed, api.websocket_connect(f"/ws/{code}") as ws:
        ws.send_bytes(b"\x00\x01garbage")
        ws.receive_json()
    assert closed.value.code == CloseCode.BAD_MESSAGE

    with pytest.raises(WebSocketDisconnect) as closed, api.websocket_connect(f"/ws/{code}") as ws:
        ws.send_json(hello(host["token"]))
        receive(ws, "welcome")
        ws.send_bytes(b"\xff" * 64)
        receive(ws, "never")
    assert closed.value.code == CloseCode.BAD_MESSAGE
