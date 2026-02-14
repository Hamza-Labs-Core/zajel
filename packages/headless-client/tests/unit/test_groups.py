"""Tests for group support: models, crypto, storage."""

import base64
import json
import os
from datetime import datetime

import pytest

from zajel.groups import (
    Group,
    GroupCryptoService,
    GroupMember,
    GroupMessage,
    GroupStorage,
    SENDER_KEY_SIZE,
)


# ── GroupMember ─────────────────────────────────────────────────


class TestGroupMember:
    def test_roundtrip(self):
        member = GroupMember(
            device_id="device_001",
            display_name="Alice",
            public_key="alice_pub_key_b64",
        )
        d = member.to_dict()
        restored = GroupMember.from_dict(d)
        assert restored.device_id == "device_001"
        assert restored.display_name == "Alice"
        assert restored.public_key == "alice_pub_key_b64"
        assert isinstance(restored.joined_at, datetime)


# ── Group ──────────────────────────────────────────────────────


class TestGroup:
    def _make_group(self, name="Test Group", member_count=2):
        members = [
            GroupMember(
                device_id=f"dev_{i}",
                display_name=f"User {i}",
                public_key=f"key_{i}",
            )
            for i in range(member_count)
        ]
        return Group(
            id="group-001",
            name=name,
            self_device_id="dev_0",
            members=members,
            created_by="dev_0",
        )

    def test_roundtrip(self):
        group = self._make_group()
        d = group.to_dict()
        restored = Group.from_dict(d)
        assert restored.id == group.id
        assert restored.name == group.name
        assert restored.self_device_id == "dev_0"
        assert len(restored.members) == 2
        assert restored.created_by == "dev_0"

    def test_member_count(self):
        group = self._make_group(member_count=3)
        assert group.member_count == 3

    def test_other_members(self):
        group = self._make_group(member_count=3)
        others = group.other_members
        assert len(others) == 2
        assert all(m.device_id != "dev_0" for m in others)

    def test_roundtrip_with_json_string_members(self):
        """Test that from_dict handles members as a JSON string (storage format)."""
        group = self._make_group()
        d = group.to_dict()
        # Ensure members is a JSON string
        assert isinstance(d["members"], str)
        restored = Group.from_dict(d)
        assert len(restored.members) == 2


# ── GroupMessage ───────────────────────────────────────────────


class TestGroupMessage:
    def test_id_format(self):
        msg = GroupMessage(
            group_id="g1",
            author_device_id="dev_1",
            sequence_number=42,
            content="Hello",
        )
        assert msg.id == "dev_1:42"

    def test_to_bytes_roundtrip(self):
        msg = GroupMessage(
            group_id="g1",
            author_device_id="dev_1",
            sequence_number=1,
            content="Hello group!",
            metadata={"key": "value"},
        )
        raw = msg.to_bytes()
        restored = GroupMessage.from_bytes(raw, group_id="g1")
        assert restored.author_device_id == "dev_1"
        assert restored.sequence_number == 1
        assert restored.content == "Hello group!"
        assert restored.metadata["key"] == "value"

    def test_to_bytes_preserves_type(self):
        msg = GroupMessage(
            group_id="g1",
            author_device_id="dev_1",
            sequence_number=1,
            content="system event",
            message_type="system",
        )
        raw = msg.to_bytes()
        restored = GroupMessage.from_bytes(raw, group_id="g1")
        assert restored.message_type == "system"

    def test_from_bytes_sets_is_outgoing(self):
        msg = GroupMessage(
            group_id="g1",
            author_device_id="dev_1",
            sequence_number=1,
            content="test",
        )
        raw = msg.to_bytes()
        restored = GroupMessage.from_bytes(raw, group_id="g1", is_outgoing=True)
        assert restored.is_outgoing is True

    def test_from_bytes_invalid_json(self):
        with pytest.raises(Exception):
            GroupMessage.from_bytes(b"not json", group_id="g1")


# ── GroupCryptoService ──────────────────────────────────────────


class TestGroupCryptoService:
    def test_generate_sender_key(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        key_bytes = base64.b64decode(key)
        assert len(key_bytes) == SENDER_KEY_SIZE

    def test_set_and_has_sender_key(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        assert not crypto.has_sender_key("g1", "dev_1")
        crypto.set_sender_key("g1", "dev_1", key)
        assert crypto.has_sender_key("g1", "dev_1")
        assert not crypto.has_sender_key("g1", "dev_2")
        assert not crypto.has_sender_key("g2", "dev_1")

    def test_get_sender_key(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        crypto.set_sender_key("g1", "dev_1", key)
        retrieved = crypto.get_sender_key("g1", "dev_1")
        assert retrieved is not None
        assert len(retrieved) == SENDER_KEY_SIZE

    def test_remove_sender_key(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        crypto.set_sender_key("g1", "dev_1", key)
        crypto.remove_sender_key("g1", "dev_1")
        assert not crypto.has_sender_key("g1", "dev_1")

    def test_clear_group_keys(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        crypto.set_sender_key("g1", "dev_1", key)
        crypto.set_sender_key("g1", "dev_2", key)
        crypto.clear_group_keys("g1")
        assert not crypto.has_sender_key("g1", "dev_1")
        assert not crypto.has_sender_key("g1", "dev_2")

    def test_set_invalid_key_length_raises(self):
        crypto = GroupCryptoService()
        short_key = base64.b64encode(b"\x00" * 16).decode()
        with pytest.raises(ValueError, match="Invalid sender key length"):
            crypto.set_sender_key("g1", "dev_1", short_key)

    def test_encrypt_decrypt_roundtrip(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        crypto.set_sender_key("g1", "dev_1", key)

        plaintext = b"Hello encrypted group!"
        encrypted = crypto.encrypt(plaintext, "g1", "dev_1")

        # Encrypted should be larger (nonce + MAC)
        assert len(encrypted) > len(plaintext)

        decrypted = crypto.decrypt(encrypted, "g1", "dev_1")
        assert decrypted == plaintext

    def test_encrypt_produces_different_ciphertext(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        crypto.set_sender_key("g1", "dev_1", key)

        plaintext = b"same message"
        ct1 = crypto.encrypt(plaintext, "g1", "dev_1")
        ct2 = crypto.encrypt(plaintext, "g1", "dev_1")
        assert ct1 != ct2  # Different nonces

    def test_decrypt_with_wrong_key_fails(self):
        crypto = GroupCryptoService()
        key1 = crypto.generate_sender_key()
        key2 = crypto.generate_sender_key()

        crypto.set_sender_key("g1", "dev_1", key1)
        encrypted = crypto.encrypt(b"secret", "g1", "dev_1")

        # Replace with wrong key
        crypto.set_sender_key("g1", "dev_1", key2)
        with pytest.raises(Exception):
            crypto.decrypt(encrypted, "g1", "dev_1")

    def test_encrypt_without_key_raises(self):
        crypto = GroupCryptoService()
        with pytest.raises(RuntimeError, match="No sender key"):
            crypto.encrypt(b"test", "g1", "dev_1")

    def test_decrypt_without_key_raises(self):
        crypto = GroupCryptoService()
        with pytest.raises(RuntimeError, match="No sender key"):
            crypto.decrypt(b"\x00" * 40, "g1", "dev_1")

    def test_decrypt_too_short_raises(self):
        crypto = GroupCryptoService()
        key = crypto.generate_sender_key()
        crypto.set_sender_key("g1", "dev_1", key)
        with pytest.raises(ValueError, match="too short"):
            crypto.decrypt(b"\x00" * 10, "g1", "dev_1")

    def test_cross_member_encrypt_decrypt(self):
        """Alice encrypts, Bob decrypts (using Alice's sender key)."""
        crypto = GroupCryptoService()
        alice_key = crypto.generate_sender_key()

        # Both Alice and Bob have Alice's sender key
        crypto.set_sender_key("g1", "alice", alice_key)

        plaintext = b"Message from Alice"
        encrypted = crypto.encrypt(plaintext, "g1", "alice")

        # Bob uses Alice's key to decrypt
        decrypted = crypto.decrypt(encrypted, "g1", "alice")
        assert decrypted == plaintext


# ── GroupStorage ───────────────────────────────────────────────


class TestGroupStorage:
    def _make_group(self, group_id="g1", name="Test Group"):
        return Group(
            id=group_id,
            name=name,
            self_device_id="dev_0",
            members=[
                GroupMember(
                    device_id="dev_0",
                    display_name="Self",
                    public_key="key_0",
                )
            ],
            created_by="dev_0",
        )

    def test_save_and_get_group(self):
        storage = GroupStorage()
        group = self._make_group()
        storage.save_group(group)

        retrieved = storage.get_group("g1")
        assert retrieved is not None
        assert retrieved.name == "Test Group"
        assert retrieved.member_count == 1

    def test_get_all_groups(self):
        storage = GroupStorage()
        for i in range(3):
            storage.save_group(self._make_group(group_id=f"g{i}", name=f"Group {i}"))
        groups = storage.get_all_groups()
        assert len(groups) == 3

    def test_delete_group(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())
        storage.delete_group("g1")
        assert storage.get_group("g1") is None

    def test_delete_group_removes_messages(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())
        storage.save_message(
            GroupMessage(
                group_id="g1",
                author_device_id="dev_0",
                sequence_number=1,
                content="test",
            )
        )
        storage.delete_group("g1")
        assert storage.get_messages("g1") == []

    def test_save_and_get_messages(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        for i in range(3):
            storage.save_message(
                GroupMessage(
                    group_id="g1",
                    author_device_id="dev_0",
                    sequence_number=i + 1,
                    content=f"Message {i}",
                )
            )

        msgs = storage.get_messages("g1")
        assert len(msgs) == 3

    def test_get_messages_with_limit(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        for i in range(5):
            storage.save_message(
                GroupMessage(
                    group_id="g1",
                    author_device_id="dev_0",
                    sequence_number=i + 1,
                    content=f"Message {i}",
                )
            )

        msgs = storage.get_messages("g1", limit=2)
        assert len(msgs) == 2

    def test_get_next_sequence(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        assert storage.get_next_sequence("g1", "dev_0") == 1
        assert storage.get_next_sequence("g1", "dev_0") == 2
        assert storage.get_next_sequence("g1", "dev_0") == 3
        # Different device starts at 1
        assert storage.get_next_sequence("g1", "dev_1") == 1

    def test_is_duplicate(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        msg = GroupMessage(
            group_id="g1",
            author_device_id="dev_0",
            sequence_number=1,
            content="test",
        )
        assert not storage.is_duplicate("g1", msg.id)
        storage.save_message(msg)
        assert storage.is_duplicate("g1", msg.id)

    def test_get_messages_empty_group(self):
        storage = GroupStorage()
        msgs = storage.get_messages("nonexistent")
        assert msgs == []

    def test_messages_ordered_by_timestamp(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        # Add messages in reverse order
        for i in [3, 1, 2]:
            storage.save_message(
                GroupMessage(
                    group_id="g1",
                    author_device_id="dev_0",
                    sequence_number=i,
                    content=f"Message {i}",
                    timestamp=datetime(2025, 1, i),
                )
            )

        msgs = storage.get_messages("g1")
        assert msgs[0].sequence_number == 1
        assert msgs[1].sequence_number == 2
        assert msgs[2].sequence_number == 3
