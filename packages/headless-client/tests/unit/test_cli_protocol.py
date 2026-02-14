"""Tests for zajel.cli.protocol — socket path, JSON-line helpers, serialization."""

import json
import os
import socket
import threading
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Optional

import pytest

from zajel.cli.protocol import (
    default_socket_path,
    send_request,
    read_response,
    serialize_result,
)


class TestDefaultSocketPath:
    def test_default_name(self):
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
        expected = os.path.join(runtime_dir, "zajel-headless-default.sock")
        assert default_socket_path() == expected

    def test_custom_name(self):
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
        expected = os.path.join(runtime_dir, "zajel-headless-bob.sock")
        assert default_socket_path("bob") == expected

    def test_special_characters(self):
        runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
        result = default_socket_path("test-bot")
        expected = os.path.join(runtime_dir, "zajel-headless-test-bot.sock")
        assert result == expected

    def test_invalid_name_with_path_traversal(self):
        with pytest.raises(ValueError, match="Invalid daemon name"):
            default_socket_path("../../etc/evil")

    def test_invalid_name_empty(self):
        with pytest.raises(ValueError, match="Invalid daemon name"):
            default_socket_path("")

    def test_invalid_name_with_spaces(self):
        with pytest.raises(ValueError, match="Invalid daemon name"):
            default_socket_path("name with spaces")


class TestJsonLineRoundTrip:
    """Test send_request/read_response over a real socket pair."""

    def test_simple_roundtrip(self, tmp_path):
        sock_path = str(tmp_path / "test.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock_path)
        server.listen(1)

        received = {}

        def server_thread():
            conn, _ = server.accept()
            buf = b""
            while b"\n" not in buf:
                buf += conn.recv(4096)
            line = buf.split(b"\n", 1)[0]
            received.update(json.loads(line))
            # Echo it back
            conn.sendall(line + b"\n")
            conn.close()

        t = threading.Thread(target=server_thread)
        t.start()

        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(sock_path)

        msg = {"id": "123", "cmd": "status", "args": {}}
        send_request(client, msg)
        response = read_response(client)

        t.join(timeout=5)
        client.close()
        server.close()

        assert received["id"] == "123"
        assert received["cmd"] == "status"
        assert response["id"] == "123"

    def test_unicode_content(self, tmp_path):
        sock_path = str(tmp_path / "unicode.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock_path)
        server.listen(1)

        def server_thread():
            conn, _ = server.accept()
            buf = b""
            while b"\n" not in buf:
                buf += conn.recv(4096)
            conn.sendall(buf.split(b"\n", 1)[0] + b"\n")
            conn.close()

        t = threading.Thread(target=server_thread)
        t.start()

        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(sock_path)

        msg = {"content": "Hello \u4e16\u754c \U0001f30d"}
        send_request(client, msg)
        response = read_response(client)

        t.join(timeout=5)
        client.close()
        server.close()

        assert response["content"] == "Hello \u4e16\u754c \U0001f30d"

    def test_connection_closed_raises(self, tmp_path):
        sock_path = str(tmp_path / "closed.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(sock_path)
        server.listen(1)

        def server_thread():
            conn, _ = server.accept()
            conn.close()  # Close immediately

        t = threading.Thread(target=server_thread)
        t.start()

        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.connect(sock_path)

        with pytest.raises(ConnectionError):
            read_response(client)

        t.join(timeout=5)
        client.close()
        server.close()


class TestSerializeResult:
    def test_primitives(self):
        assert serialize_result(None) is None
        assert serialize_result(42) == 42
        assert serialize_result(3.14) == 3.14
        assert serialize_result(True) is True
        assert serialize_result("hello") == "hello"

    def test_datetime(self):
        dt = datetime(2026, 2, 14, 12, 0, 0, tzinfo=timezone.utc)
        assert serialize_result(dt) == "2026-02-14T12:00:00+00:00"

    def test_bytes(self):
        result = serialize_result(b"\x00\x01\x02")
        assert result == "AAEC"  # base64

    def test_dict(self):
        result = serialize_result({"key": "value", "num": 42})
        assert result == {"key": "value", "num": 42}

    def test_nested_dict_with_datetime(self):
        dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
        result = serialize_result({"ts": dt, "data": [1, 2]})
        assert result["ts"] == "2026-01-01T00:00:00+00:00"
        assert result["data"] == [1, 2]

    def test_list(self):
        result = serialize_result([1, "two", None])
        assert result == [1, "two", None]

    def test_dataclass_with_to_dict(self):
        @dataclass
        class Dummy:
            name: str
            value: int

            def to_dict(self):
                return {"name": self.name, "value": self.value}

        result = serialize_result(Dummy(name="test", value=99))
        assert result == {"name": "test", "value": 99}

    def test_dataclass_without_to_dict(self):
        @dataclass
        class Plain:
            x: int
            y: str

        result = serialize_result(Plain(x=1, y="hi"))
        assert result == {"x": 1, "y": "hi"}

    def test_dataclass_with_optional_none(self):
        @dataclass
        class WithOptional:
            name: str
            alias: Optional[str] = None

        result = serialize_result(WithOptional(name="test"))
        assert result == {"name": "test", "alias": None}

    def test_result_is_json_serializable(self):
        """Verify serialize_result output can be passed to json.dumps."""
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)

        @dataclass
        class Complex:
            ts: datetime
            data: bytes
            items: list

        obj = Complex(ts=dt, data=b"\xff", items=[1, "a"])
        result = serialize_result(obj)
        # Should not raise
        json_str = json.dumps(result)
        parsed = json.loads(json_str)
        assert parsed["ts"] == "2026-02-14T00:00:00+00:00"
