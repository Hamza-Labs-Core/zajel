"""Message protocol for Zajel data channel communication.

Handles message framing, parsing, and serialization for:
- Text messages (encrypted)
- Handshake messages (key exchange)
- File transfer control messages
"""

import json
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Any, Optional

logger = logging.getLogger("zajel.protocol")

# Data channel labels (must match Dart app: lib/core/constants.dart WebRTCConstants)
MESSAGE_CHANNEL_LABEL = "messages"
FILE_CHANNEL_LABEL = "files"

# File transfer constants
FILE_CHUNK_SIZE = 4096  # bytes
CHUNK_SEND_DELAY_MS = 10


class MessageType(str, Enum):
    HANDSHAKE = "handshake"
    TEXT = "text"
    FILE_START = "file_start"
    FILE_CHUNK = "file_chunk"
    FILE_COMPLETE = "file_complete"


@dataclass
class HandshakeMessage:
    """Key exchange handshake sent on data channel open."""

    public_key: str  # base64

    def to_json(self) -> str:
        return json.dumps({"type": "handshake", "publicKey": self.public_key})

    @staticmethod
    def from_json(data: str) -> "HandshakeMessage":
        msg = json.loads(data)
        return HandshakeMessage(public_key=msg["publicKey"])


@dataclass
class FileStartMessage:
    """Signals the beginning of a file transfer."""

    file_id: str
    file_name: str
    total_size: int
    total_chunks: int

    def to_json(self) -> str:
        return json.dumps({
            "type": "file_start",
            "fileId": self.file_id,
            "fileName": self.file_name,
            "totalSize": self.total_size,
            "totalChunks": self.total_chunks,
        })

    @staticmethod
    def from_json(data: str) -> "FileStartMessage":
        msg = json.loads(data)
        return FileStartMessage(
            file_id=msg["fileId"],
            file_name=msg["fileName"],
            total_size=msg["totalSize"],
            total_chunks=msg["totalChunks"],
        )


@dataclass
class FileChunkMessage:
    """A single chunk of a file transfer."""

    file_id: str
    chunk_index: int
    data: str  # base64-encoded chunk data

    def to_json(self) -> str:
        return json.dumps({
            "type": "file_chunk",
            "fileId": self.file_id,
            "chunkIndex": self.chunk_index,
            "data": self.data,
        })

    @staticmethod
    def from_json(data: str) -> "FileChunkMessage":
        msg = json.loads(data)
        return FileChunkMessage(
            file_id=msg["fileId"],
            chunk_index=msg["chunkIndex"],
            data=msg["data"],
        )


@dataclass
class FileCompleteMessage:
    """Signals the end of a file transfer."""

    file_id: str

    def to_json(self) -> str:
        return json.dumps({"type": "file_complete", "fileId": self.file_id})

    @staticmethod
    def from_json(data: str) -> "FileCompleteMessage":
        msg = json.loads(data)
        return FileCompleteMessage(file_id=msg["fileId"])


def parse_channel_message(data: str) -> dict[str, Any]:
    """Parse a raw data channel message.

    Messages on the data channel are either:
    - JSON control messages (handshake, file_start, file_chunk, file_complete)
    - Encrypted text messages (base64 ciphertext)

    Returns the parsed message as a dict with at least a 'type' key.
    For encrypted text messages, returns {'type': 'encrypted_text', 'data': raw_data}.
    """
    try:
        msg = json.loads(data)
        if isinstance(msg, dict) and "type" in msg:
            return msg
    except (json.JSONDecodeError, TypeError):
        pass

    # Not valid JSON or no type field — treat as encrypted text
    return {"type": "encrypted_text", "data": data}
