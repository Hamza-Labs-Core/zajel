"""Tests for zajel.cli.serializers — dataclass → JSON-safe dict converters."""

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from zajel.cli.serializers import (
    serialize_connected_peer,
    serialize_received_message,
    serialize_owned_channel,
    serialize_subscribed_channel,
    serialize_channel_content,
    serialize_group,
    serialize_group_member,
    serialize_group_message,
    serialize_file_transfer,
    serialize_stored_peer,
)


def _is_json_safe(obj):
    """Verify an object roundtrips through JSON without error."""
    return json.loads(json.dumps(obj, default=str)) is not None


class TestSerializeConnectedPeer:
    def test_basic(self):
        peer = SimpleNamespace(
            peer_id="abc123",
            public_key="pubkey_b64",
            display_name="Alice",
            is_initiator=True,
        )
        result = serialize_connected_peer(peer)
        assert result["peer_id"] == "abc123"
        assert result["public_key"] == "pubkey_b64"
        assert result["display_name"] == "Alice"
        assert result["is_initiator"] is True
        assert _is_json_safe(result)

    def test_none_display_name(self):
        peer = SimpleNamespace(
            peer_id="abc123",
            public_key="pubkey_b64",
            display_name=None,
            is_initiator=False,
        )
        result = serialize_connected_peer(peer)
        assert result["display_name"] is None
        assert _is_json_safe(result)


class TestSerializeReceivedMessage:
    def test_basic(self):
        msg = SimpleNamespace(
            peer_id="peer1", content="Hello!", timestamp=1707900000.0
        )
        result = serialize_received_message(msg)
        assert result["peer_id"] == "peer1"
        assert result["content"] == "Hello!"
        assert result["timestamp"] == 1707900000.0
        assert _is_json_safe(result)


class TestSerializeOwnedChannel:
    def test_basic(self):
        manifest = SimpleNamespace(name="News", description="Daily news")
        channel = SimpleNamespace(
            channel_id="ch_001",
            manifest=manifest,
            sequence=5,
        )
        result = serialize_owned_channel(channel)
        assert result["channel_id"] == "ch_001"
        assert result["name"] == "News"
        assert result["description"] == "Daily news"
        assert result["sequence"] == 5
        assert "signing_key_private" not in result
        assert _is_json_safe(result)


class TestSerializeSubscribedChannel:
    def test_basic(self):
        manifest = SimpleNamespace(name="Tech", description="Tech news")
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        channel = SimpleNamespace(
            channel_id="ch_002",
            manifest=manifest,
            subscribed_at=dt,
        )
        result = serialize_subscribed_channel(channel)
        assert result["channel_id"] == "ch_002"
        assert result["name"] == "Tech"
        assert "2026-02-14" in result["subscribed_at"]
        assert _is_json_safe(result)


class TestSerializeChannelContent:
    def test_text_content(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        payload = SimpleNamespace(
            content_type="text",
            payload=b"Hello subscribers",
            metadata={},
            reply_to=None,
            author=None,
            timestamp=dt,
        )
        result = serialize_channel_content("ch_001", payload)
        assert result["channel_id"] == "ch_001"
        assert result["content_type"] == "text"
        assert result["payload"] == "Hello subscribers"
        assert _is_json_safe(result)

    def test_metadata_preserved(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        payload = SimpleNamespace(
            content_type="text",
            payload=b"test",
            metadata={"key": "value"},
            reply_to="msg_001",
            author="alice",
            timestamp=dt,
        )
        result = serialize_channel_content("ch_001", payload)
        assert result["metadata"] == {"key": "value"}
        assert result["reply_to"] == "msg_001"
        assert result["author"] == "alice"


class TestSerializeGroup:
    def test_basic(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        member = SimpleNamespace(
            device_id="dev1",
            display_name="Alice",
            public_key="pubkey",
            joined_at=dt,
        )
        group = SimpleNamespace(
            id="grp_001",
            name="Family",
            member_count=1,
            members=[member],
            created_at=dt,
            created_by="dev1",
        )
        result = serialize_group(group)
        assert result["id"] == "grp_001"
        assert result["name"] == "Family"
        assert result["member_count"] == 1
        assert len(result["members"]) == 1
        assert result["members"][0]["device_id"] == "dev1"
        assert _is_json_safe(result)

    def test_empty_members(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        group = SimpleNamespace(
            id="grp_002",
            name="Empty",
            member_count=0,
            members=[],
            created_at=dt,
            created_by="dev1",
        )
        result = serialize_group(group)
        assert result["members"] == []


class TestSerializeGroupMember:
    def test_basic(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        member = SimpleNamespace(
            device_id="dev1",
            display_name="Bob",
            public_key="pubkey_b64",
            joined_at=dt,
        )
        result = serialize_group_member(member)
        assert result["device_id"] == "dev1"
        assert result["display_name"] == "Bob"
        assert _is_json_safe(result)


class TestSerializeGroupMessage:
    def test_basic(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        msg = SimpleNamespace(
            id="dev1:1",
            group_id="grp_001",
            author_device_id="dev1",
            content="Hello group",
            message_type="text",
            timestamp=dt,
            is_outgoing=True,
        )
        result = serialize_group_message(msg)
        assert result["id"] == "dev1:1"
        assert result["group_id"] == "grp_001"
        assert result["content"] == "Hello group"
        assert result["is_outgoing"] is True
        assert _is_json_safe(result)


class TestSerializeFileTransfer:
    def test_complete(self):
        progress = SimpleNamespace(
            file_id="f001",
            file_name="photo.jpg",
            total_size=1024,
            total_chunks=4,
            received_chunks=4,
            bytes_received=1024,
            completed=True,
            file_path="/tmp/photo.jpg",
            sha256="abcdef1234567890",
        )
        result = serialize_file_transfer(progress)
        assert result["file_id"] == "f001"
        assert result["completed"] is True
        assert result["file_path"] == "/tmp/photo.jpg"
        assert _is_json_safe(result)

    def test_in_progress(self):
        progress = SimpleNamespace(
            file_id="f002",
            file_name="video.mp4",
            total_size=10000,
            total_chunks=10,
            received_chunks=3,
            bytes_received=3000,
            completed=False,
            file_path=None,
            sha256=None,
        )
        result = serialize_file_transfer(progress)
        assert result["completed"] is False
        assert result["file_path"] is None
        assert _is_json_safe(result)


class TestSerializeStoredPeer:
    def test_basic(self):
        dt = datetime(2026, 2, 14, tzinfo=timezone.utc)
        peer = SimpleNamespace(
            peer_id="peer1",
            display_name="Alice",
            public_key="pubkey_b64",
            is_blocked=False,
            trusted_at=dt,
            last_seen=dt,
            alias="ali",
        )
        result = serialize_stored_peer(peer)
        assert result["peer_id"] == "peer1"
        assert result["is_blocked"] is False
        assert result["alias"] == "ali"
        assert "2026-02-14" in result["trusted_at"]
        assert _is_json_safe(result)

    def test_none_timestamps(self):
        peer = SimpleNamespace(
            peer_id="peer2",
            display_name="Bob",
            public_key="pubkey_b64",
            is_blocked=True,
            trusted_at=None,
            last_seen=None,
            alias=None,
        )
        result = serialize_stored_peer(peer)
        assert result["trusted_at"] is None
        assert result["last_seen"] is None
        assert result["alias"] is None
        assert _is_json_safe(result)
