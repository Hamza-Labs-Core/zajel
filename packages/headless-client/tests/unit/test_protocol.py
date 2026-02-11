"""Tests for the message protocol."""

import json
import pytest
from zajel.protocol import (
    HandshakeMessage,
    FileStartMessage,
    FileChunkMessage,
    FileCompleteMessage,
    parse_channel_message,
)


class TestHandshakeMessage:
    def test_serialize(self):
        msg = HandshakeMessage(public_key="abc123==")
        data = msg.to_json()
        parsed = json.loads(data)
        assert parsed["type"] == "handshake"
        assert parsed["publicKey"] == "abc123=="

    def test_deserialize(self):
        data = json.dumps({"type": "handshake", "publicKey": "abc123=="})
        msg = HandshakeMessage.from_json(data)
        assert msg.public_key == "abc123=="

    def test_roundtrip(self):
        original = HandshakeMessage(public_key="test_key_base64")
        data = original.to_json()
        restored = HandshakeMessage.from_json(data)
        assert restored.public_key == original.public_key


class TestFileStartMessage:
    def test_serialize(self):
        msg = FileStartMessage(
            file_id="uuid-1",
            file_name="test.txt",
            total_size=1024,
            total_chunks=1,
        )
        data = msg.to_json()
        parsed = json.loads(data)
        assert parsed["type"] == "file_start"
        assert parsed["fileId"] == "uuid-1"
        assert parsed["fileName"] == "test.txt"
        assert parsed["totalSize"] == 1024
        assert parsed["totalChunks"] == 1

    def test_roundtrip(self):
        original = FileStartMessage(
            file_id="uuid-2",
            file_name="photo.jpg",
            total_size=50000,
            total_chunks=13,
        )
        data = original.to_json()
        restored = FileStartMessage.from_json(data)
        assert restored.file_id == original.file_id
        assert restored.file_name == original.file_name
        assert restored.total_size == original.total_size
        assert restored.total_chunks == original.total_chunks


class TestFileChunkMessage:
    def test_serialize(self):
        msg = FileChunkMessage(file_id="uuid-1", chunk_index=0, data="base64data")
        data = msg.to_json()
        parsed = json.loads(data)
        assert parsed["type"] == "file_chunk"
        assert parsed["chunkIndex"] == 0

    def test_roundtrip(self):
        original = FileChunkMessage(file_id="uuid-1", chunk_index=5, data="abc123")
        data = original.to_json()
        restored = FileChunkMessage.from_json(data)
        assert restored.file_id == original.file_id
        assert restored.chunk_index == original.chunk_index
        assert restored.data == original.data


class TestFileCompleteMessage:
    def test_serialize(self):
        msg = FileCompleteMessage(file_id="uuid-1")
        data = msg.to_json()
        parsed = json.loads(data)
        assert parsed["type"] == "file_complete"
        assert parsed["fileId"] == "uuid-1"


class TestParseChannelMessage:
    def test_parse_handshake(self):
        data = json.dumps({"type": "handshake", "publicKey": "key123"})
        msg = parse_channel_message(data)
        assert msg["type"] == "handshake"
        assert msg["publicKey"] == "key123"

    def test_parse_file_start(self):
        data = json.dumps({
            "type": "file_start",
            "fileId": "uuid-1",
            "fileName": "test.txt",
            "totalSize": 100,
            "totalChunks": 1,
        })
        msg = parse_channel_message(data)
        assert msg["type"] == "file_start"

    def test_parse_encrypted_text(self):
        # Base64 ciphertext (not valid JSON)
        data = "SGVsbG8gV29ybGQ="
        msg = parse_channel_message(data)
        assert msg["type"] == "encrypted_text"
        assert msg["data"] == data

    def test_parse_json_without_type(self):
        data = json.dumps({"key": "value"})
        msg = parse_channel_message(data)
        assert msg["type"] == "encrypted_text"
