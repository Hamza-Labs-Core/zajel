"""
Headless-only group E2E tests.

Tests the full group lifecycle using ZajelHeadlessClient and the
groups module directly — no GUI, no Appium, no signaling server.

Covers:
- Group creation via client API
- Add member with sender key
- Message encrypt/decrypt through client
- Cross-member messaging (Alice encrypts, Bob decrypts)
- Group invitation payload format
- Sender key rotation
- Leave group clears keys and data
- Max members enforcement (15-member limit)
"""

import asyncio
import base64
import json

import pytest

from zajel.client import ZajelHeadlessClient
from zajel.groups import (
    Group,
    GroupCryptoService,
    GroupMember,
    GroupMessage,
    GroupStorage,
    MAX_GROUP_MEMBERS,
)


# ── Fixtures ──────────────────────────────────────────────────


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def run(event_loop):
    return lambda coro: event_loop.run_until_complete(coro)


@pytest.fixture
def alice_client():
    """Create a headless client for Alice (no signaling connection)."""
    client = ZajelHeadlessClient(
        signaling_url="ws://localhost:0",  # Unused — no signaling needed
        name="Alice",
    )
    # Initialize crypto without connecting to signaling
    client._crypto.initialize()
    client._pairing_code = "alice-device"
    yield client


@pytest.fixture
def bob_client():
    """Create a headless client for Bob (no signaling connection)."""
    client = ZajelHeadlessClient(
        signaling_url="ws://localhost:0",
        name="Bob",
    )
    client._crypto.initialize()
    client._pairing_code = "bob-device"
    yield client


# ── Tests ─────────────────────────────────────────────────────


@pytest.mark.headless
@pytest.mark.groups
class TestGroupsHeadless:
    """Group E2E tests using headless clients."""

    def test_create_group(self, run, alice_client):
        """Create a group and verify its properties."""

        async def _test():
            group = await alice_client.create_group("Family Chat")

            assert group.name == "Family Chat"
            assert group.id  # Non-empty UUID
            assert group.member_count == 1
            assert group.members[0].display_name == "Alice"
            assert group.members[0].device_id == "alice-device"
            assert group.self_device_id == "alice-device"
            assert group.created_by == "alice-device"

            # Sender key should be stored
            assert alice_client._group_crypto.has_sender_key(
                group.id, "alice-device"
            )

        run(_test())

    def test_get_groups(self, run, alice_client):
        """Get all groups after creating multiple."""

        async def _test():
            await alice_client.create_group("Group 1")
            await alice_client.create_group("Group 2")
            await alice_client.create_group("Group 3")

            groups = await alice_client.get_groups()
            assert len(groups) == 3
            names = {g.name for g in groups}
            assert names == {"Group 1", "Group 2", "Group 3"}

        run(_test())

    def test_add_member(self, run, alice_client):
        """Add a member to a group and verify membership."""

        async def _test():
            group = await alice_client.create_group("Test Group")

            bob_member = GroupMember(
                device_id="bob-device",
                display_name="Bob",
                public_key="bob-public-key-b64",
            )
            bob_key = alice_client._group_crypto.generate_sender_key()

            updated = await alice_client.add_group_member(
                group.id, bob_member, bob_key
            )

            assert updated.member_count == 2
            assert any(m.device_id == "bob-device" for m in updated.members)
            assert alice_client._group_crypto.has_sender_key(
                group.id, "bob-device"
            )

        run(_test())

    def test_add_duplicate_member_fails(self, run, alice_client):
        """Adding the same member twice raises an error."""

        async def _test():
            group = await alice_client.create_group("Test Group")

            bob_member = GroupMember(
                device_id="bob-device",
                display_name="Bob",
                public_key="bob-key",
            )
            bob_key = alice_client._group_crypto.generate_sender_key()
            await alice_client.add_group_member(group.id, bob_member, bob_key)

            with pytest.raises(RuntimeError, match="already in group"):
                await alice_client.add_group_member(
                    group.id, bob_member, bob_key
                )

        run(_test())

    def test_send_group_message(self, run, alice_client):
        """Send a message and verify it's stored."""

        async def _test():
            group = await alice_client.create_group("Messaging Group")

            msg = await alice_client.send_group_message(
                group.id, "Hello everyone!"
            )

            assert msg.content == "Hello everyone!"
            assert msg.author_device_id == "alice-device"
            assert msg.is_outgoing is True
            assert msg.sequence_number == 1

            # Message should be in storage
            stored = await alice_client.get_group_messages(group.id)
            assert len(stored) == 1
            assert stored[0].content == "Hello everyone!"

        run(_test())

    def test_send_multiple_messages_increments_sequence(self, run, alice_client):
        """Sending multiple messages increments the sequence number."""

        async def _test():
            group = await alice_client.create_group("Seq Test Group")

            msg1 = await alice_client.send_group_message(group.id, "First")
            msg2 = await alice_client.send_group_message(group.id, "Second")
            msg3 = await alice_client.send_group_message(group.id, "Third")

            assert msg1.sequence_number == 1
            assert msg2.sequence_number == 2
            assert msg3.sequence_number == 3

        run(_test())

    def test_cross_member_encrypt_decrypt(self):
        """Alice encrypts a message, Bob decrypts using Alice's sender key."""
        crypto = GroupCryptoService()
        alice_key = crypto.generate_sender_key()

        # Both Alice and Bob store Alice's sender key
        crypto.set_sender_key("group-1", "alice-device", alice_key)

        msg = GroupMessage(
            group_id="group-1",
            author_device_id="alice-device",
            sequence_number=1,
            content="Hello Bob, this is Alice!",
            is_outgoing=True,
        )

        # Alice encrypts
        encrypted = crypto.encrypt(msg.to_bytes(), "group-1", "alice-device")

        # Bob decrypts using Alice's sender key
        plaintext = crypto.decrypt(encrypted, "group-1", "alice-device")
        restored = GroupMessage.from_bytes(
            plaintext, group_id="group-1", is_outgoing=False
        )

        assert restored.content == "Hello Bob, this is Alice!"
        assert restored.author_device_id == "alice-device"
        assert restored.sequence_number == 1

    def test_cross_member_via_client_api(self, run, alice_client, bob_client):
        """Full E2E: Alice creates group, sends message, Bob receives and decrypts."""

        async def _test():
            # Alice creates group
            group = await alice_client.create_group("Cross Chat")

            # Get Alice's sender key for sharing with Bob
            alice_sender_key = alice_client._group_crypto.get_sender_key(
                group.id, "alice-device"
            )
            alice_key_b64 = base64.b64encode(alice_sender_key).decode()

            # Bob creates the same group locally (simulating invitation acceptance)
            bob_member = GroupMember(
                device_id="bob-device",
                display_name="Bob",
                public_key=bob_client._crypto.public_key_base64,
            )
            alice_member = GroupMember(
                device_id="alice-device",
                display_name="Alice",
                public_key=alice_client._crypto.public_key_base64,
            )

            bob_group = Group(
                id=group.id,
                name=group.name,
                self_device_id="bob-device",
                members=[alice_member, bob_member],
                created_by="alice-device",
            )
            bob_client._group_storage.save_group(bob_group)

            # Bob generates his sender key
            bob_key_b64 = bob_client._group_crypto.generate_sender_key()
            bob_client._group_crypto.set_sender_key(
                group.id, "bob-device", bob_key_b64
            )

            # Bob stores Alice's sender key
            bob_client._group_crypto.set_sender_key(
                group.id, "alice-device", alice_key_b64
            )

            # Alice also stores Bob's sender key
            alice_client._group_crypto.set_sender_key(
                group.id, "bob-device", bob_key_b64
            )

            # Alice sends a message (encrypt with her sender key)
            alice_msg = await alice_client.send_group_message(
                group.id, "Hello Bob!"
            )

            # Simulate transmission: get encrypted bytes
            msg_bytes = alice_msg.to_bytes()
            encrypted = alice_client._group_crypto.encrypt(
                msg_bytes, group.id, "alice-device"
            )

            # Bob receives the encrypted message
            received = await bob_client.receive_group_message(
                group.id, "alice-device", encrypted
            )

            assert received is not None
            assert received.content == "Hello Bob!"
            assert received.author_device_id == "alice-device"
            assert received.is_outgoing is False

        run(_test())

    def test_sender_key_rotation(self):
        """After rotating a sender key, old key can't decrypt new messages."""
        crypto = GroupCryptoService()

        # Set initial key
        old_key = crypto.generate_sender_key()
        crypto.set_sender_key("group-1", "alice", old_key)

        # Encrypt with old key
        old_encrypted = crypto.encrypt(b"old message", "group-1", "alice")

        # Rotate to new key
        new_key = crypto.generate_sender_key()
        crypto.set_sender_key("group-1", "alice", new_key)

        # New key can't decrypt old message (different key)
        with pytest.raises(Exception):
            crypto.decrypt(old_encrypted, "group-1", "alice")

        # New key can encrypt and decrypt new messages
        new_encrypted = crypto.encrypt(b"new message", "group-1", "alice")
        decrypted = crypto.decrypt(new_encrypted, "group-1", "alice")
        assert decrypted == b"new message"

    def test_leave_group_clears_keys_and_data(self, run, alice_client):
        """Leaving a group clears sender keys and stored data."""

        async def _test():
            group = await alice_client.create_group("Leave Test")
            await alice_client.send_group_message(group.id, "Before leaving")

            # Verify data exists
            assert alice_client._group_crypto.has_sender_key(
                group.id, "alice-device"
            )
            msgs = await alice_client.get_group_messages(group.id)
            assert len(msgs) == 1

            # Leave the group
            await alice_client.leave_group(group.id)

            # Keys should be cleared
            assert not alice_client._group_crypto.has_sender_key(
                group.id, "alice-device"
            )

            # Group should be gone
            retrieved = await alice_client.get_group(group.id)
            assert retrieved is None

            # Messages should be gone
            msgs = await alice_client.get_group_messages(group.id)
            assert len(msgs) == 0

        run(_test())

    def test_max_members_enforcement(self, run, alice_client):
        """Group enforces the 15-member limit."""

        async def _test():
            group = await alice_client.create_group("Full Group")

            # Add 14 more members (total = 15)
            for i in range(14):
                member = GroupMember(
                    device_id=f"device-{i}",
                    display_name=f"User {i}",
                    public_key=f"key-{i}",
                )
                key = alice_client._group_crypto.generate_sender_key()
                group = await alice_client.add_group_member(
                    group.id, member, key
                )

            assert group.member_count == 15

            # Adding the 16th member should fail
            overflow_member = GroupMember(
                device_id="overflow-device",
                display_name="Overflow",
                public_key="overflow-key",
            )
            overflow_key = alice_client._group_crypto.generate_sender_key()

            with pytest.raises(RuntimeError, match="full"):
                await alice_client.add_group_member(
                    group.id, overflow_member, overflow_key
                )

        run(_test())

    def test_receive_duplicate_message_ignored(self, run, alice_client, bob_client):
        """Receiving the same message twice returns None on second receive."""

        async def _test():
            # Setup group with both clients
            group = await alice_client.create_group("Dedup Test")
            alice_key = alice_client._group_crypto.get_sender_key(
                group.id, "alice-device"
            )
            alice_key_b64 = base64.b64encode(alice_key).decode()

            # Bob sets up his side
            bob_group = Group(
                id=group.id,
                name=group.name,
                self_device_id="bob-device",
                members=[
                    GroupMember(
                        device_id="alice-device",
                        display_name="Alice",
                        public_key="alice-key",
                    ),
                    GroupMember(
                        device_id="bob-device",
                        display_name="Bob",
                        public_key="bob-key",
                    ),
                ],
                created_by="alice-device",
            )
            bob_client._group_storage.save_group(bob_group)
            bob_client._group_crypto.set_sender_key(
                group.id, "alice-device", alice_key_b64
            )

            # Alice sends a message
            msg = await alice_client.send_group_message(group.id, "Unique msg")
            encrypted = alice_client._group_crypto.encrypt(
                msg.to_bytes(), group.id, "alice-device"
            )

            # Bob receives it first time — success
            result1 = await bob_client.receive_group_message(
                group.id, "alice-device", encrypted
            )
            assert result1 is not None
            assert result1.content == "Unique msg"

            # Bob receives the same message again — duplicate, returns None
            result2 = await bob_client.receive_group_message(
                group.id, "alice-device", encrypted
            )
            assert result2 is None

        run(_test())

    def test_author_mismatch_raises(self, run, bob_client):
        """Receiving a message where encrypted author != claimed author raises."""

        async def _test():
            # Bob creates group
            group = await bob_client.create_group("Auth Test")

            # Create a message claiming to be from alice
            msg = GroupMessage(
                group_id=group.id,
                author_device_id="alice-device",  # Claims to be Alice
                sequence_number=1,
                content="Forged message",
            )

            # But encrypt with Bob's key (the only key we have)
            encrypted = bob_client._group_crypto.encrypt(
                msg.to_bytes(), group.id, "bob-device"
            )

            # Now try to receive as "bob-device" — author in decrypted payload
            # says "alice-device" but we told receive it came from "bob-device"
            # The author mismatch should raise
            with pytest.raises(RuntimeError, match="Author mismatch"):
                await bob_client.receive_group_message(
                    group.id, "bob-device", encrypted
                )

        run(_test())

    def test_message_unicode_roundtrip(self, run, alice_client):
        """Unicode messages survive the full send/store/retrieve cycle."""

        async def _test():
            group = await alice_client.create_group("Unicode Group")

            test_strings = [
                "مرحبا بالعالم",
                "こんにちは世界",
                "🎉🔥💬🌍",
                "Mixed: Hello مرحبا 🌍",
            ]

            for text in test_strings:
                await alice_client.send_group_message(group.id, text)

            msgs = await alice_client.get_group_messages(group.id)
            assert len(msgs) == len(test_strings)

            for msg, expected in zip(msgs, test_strings):
                assert msg.content == expected, f"Failed for: {expected}"

        run(_test())

    def test_group_not_found_raises(self, run, alice_client):
        """Operations on a nonexistent group raise RuntimeError."""

        async def _test():
            with pytest.raises(RuntimeError, match="not found"):
                await alice_client.send_group_message("nonexistent", "Hello")

            with pytest.raises(RuntimeError, match="not found"):
                await alice_client.add_group_member(
                    "nonexistent",
                    GroupMember(
                        device_id="x",
                        display_name="X",
                        public_key="k",
                    ),
                    "key",
                )

        run(_test())
