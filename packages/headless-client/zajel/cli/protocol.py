"""Shared protocol helpers for the daemon ↔ CLI communication.

Transport: UNIX domain socket with JSON-line framing.
Each message is a single JSON object followed by a newline character.
"""

import asyncio
import json
import os
import re
import socket
from dataclasses import asdict, fields, is_dataclass
from datetime import datetime
from typing import Any

MAX_MESSAGE_SIZE = 1024 * 1024  # 1 MB


def default_socket_path(name: str = "default") -> str:
    """Return the default UNIX socket path for a given daemon name."""
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        raise ValueError(
            f"Invalid daemon name '{name}': "
            "only alphanumeric characters, hyphens, and underscores allowed"
        )
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
    return os.path.join(runtime_dir, f"zajel-headless-{name}.sock")


def send_request(sock: socket.socket, request: dict) -> None:
    """Write a JSON-line request to a socket."""
    line = json.dumps(request, default=_json_default) + "\n"
    sock.sendall(line.encode("utf-8"))


def read_response(sock: socket.socket) -> dict:
    """Read a single JSON-line response from a socket.

    Reads bytes until a newline is found.
    Raises ValueError if the response exceeds MAX_MESSAGE_SIZE.
    """
    buf = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("Socket closed before response received")
        buf += chunk
        if len(buf) > MAX_MESSAGE_SIZE:
            raise ValueError(
                f"Response exceeds maximum size ({MAX_MESSAGE_SIZE} bytes)"
            )
        if b"\n" in buf:
            line, _ = buf.split(b"\n", 1)
            return json.loads(line.decode("utf-8"))


async def async_send(writer, response: dict) -> None:
    """Write a JSON-line response to an asyncio StreamWriter."""
    line = json.dumps(response, default=_json_default) + "\n"
    writer.write(line.encode("utf-8"))
    await writer.drain()


async def async_readline(reader) -> str | None:
    """Read a single line from an asyncio StreamReader.

    Returns None on EOF.
    Raises ValueError if the line exceeds MAX_MESSAGE_SIZE.
    """
    try:
        line = await reader.readline()
    except asyncio.LimitOverrunError:
        raise ValueError(
            f"Message exceeds maximum size ({MAX_MESSAGE_SIZE} bytes)"
        )
    if not line:
        return None
    if len(line) > MAX_MESSAGE_SIZE:
        raise ValueError(
            f"Message exceeds maximum size ({MAX_MESSAGE_SIZE} bytes)"
        )
    return line.decode("utf-8").strip()


def serialize_result(obj: Any) -> Any:
    """Convert a value to a JSON-safe representation.

    Handles dataclasses, datetime, bytes, dicts, lists, and primitives.
    """
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, bytes):
        import base64
        return base64.b64encode(obj).decode("ascii")
    if isinstance(obj, dict):
        return {str(k): serialize_result(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [serialize_result(item) for item in obj]
    if is_dataclass(obj) and not isinstance(obj, type):
        # Use to_dict() if the dataclass provides it, otherwise asdict()
        if hasattr(obj, "to_dict"):
            return serialize_result(obj.to_dict())
        result = {}
        for f in fields(obj):
            result[f.name] = serialize_result(getattr(obj, f.name))
        return result
    # Fallback: convert to string
    return str(obj)


def _json_default(obj: Any) -> Any:
    """Default JSON serializer for non-standard types."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, bytes):
        import base64
        return base64.b64encode(obj).decode("ascii")
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")
