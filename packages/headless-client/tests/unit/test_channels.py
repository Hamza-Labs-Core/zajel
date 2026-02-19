"""Tests for channel support: invite links, manifests, crypto, storage,
admin management, key rotation, upstream messages, and polling."""

import base64
import json
import os
from datetime import datetime, timezone

import pytest

from zajel.channels import (
    AdminKey,
    ChannelCryptoService,
    ChannelManifest,
    ChannelRules,
    ChannelStorage,
    Chunk,
    ChunkPayload,
    OwnedChannel,
    Poll,
    PollOption,
    PollResults,
    PollTracker,
    SubscribedChannel,
    UpstreamMessage,
    UpstreamMessageType,
    UpstreamPayload,
    decode_channel_link,
    is_channel_link,
    CHANNEL_LINK_PREFIX,
)


# ── Helper: build a test manifest and fake signed invite link ───


def _make_manifest(
    channel_id="test-channel-001",
    name="Test Channel",
    description="A test channel",
    owner_key="owner_pub_key_b64",
    current_encrypt_key="encrypt_pub_key_b64",
    key_epoch=1,
    signature="fake_sig",
) -> ChannelManifest:
    return ChannelManifest(
        channel_id=channel_id,
        name=name,
        description=description,
        owner_key=owner_key,
        admin_keys=[],
        current_encrypt_key=current_encrypt_key,
        key_epoch=key_epoch,
        rules=ChannelRules(),
        signature=signature,
    )


def _encode_invite_link(manifest: ChannelManifest, encryption_key: str) -> str:
    """Build a zajel://channel/<base64url> link from a manifest and key."""
    payload = {"m": manifest.to_dict(), "k": encryption_key}
    json_bytes = json.dumps(payload).encode("utf-8")
    encoded = base64.urlsafe_b64encode(json_bytes).decode().rstrip("=")
    return f"{CHANNEL_LINK_PREFIX}{encoded}"


# ── AdminKey ────────────────────────────────────────────────────


class TestAdminKey:
    def test_roundtrip(self):
        ak = AdminKey(key="pub_key_123", label="Alice")
        d = ak.to_dict()
        restored = AdminKey.from_dict(d)
        assert restored.key == ak.key
        assert restored.label == ak.label


# ── ChannelRules ────────────────────────────────────────────────


class TestChannelRules:
    def test_defaults(self):
        rules = ChannelRules()
        assert rules.replies_enabled is True
        assert rules.polls_enabled is True
        assert rules.max_upstream_size == 4096

    def test_roundtrip(self):
        rules = ChannelRules(
            replies_enabled=False, polls_enabled=True, max_upstream_size=8192
        )
        d = rules.to_dict()
        restored = ChannelRules.from_dict(d)
        assert restored.replies_enabled is False
        assert restored.polls_enabled is True
        assert restored.max_upstream_size == 8192


# ── ChannelManifest ─────────────────────────────────────────────


class TestChannelManifest:
    def test_roundtrip(self):
        manifest = _make_manifest()
        d = manifest.to_dict()
        restored = ChannelManifest.from_dict(d)
        assert restored.channel_id == manifest.channel_id
        assert restored.name == manifest.name
        assert restored.description == manifest.description
        assert restored.owner_key == manifest.owner_key
        assert restored.current_encrypt_key == manifest.current_encrypt_key
        assert restored.key_epoch == manifest.key_epoch
        assert restored.signature == manifest.signature

    def test_with_admin_keys(self):
        manifest = _make_manifest()
        manifest.admin_keys = [
            AdminKey(key="admin1_key", label="Admin One"),
            AdminKey(key="admin2_key", label="Admin Two"),
        ]
        d = manifest.to_dict()
        restored = ChannelManifest.from_dict(d)
        assert len(restored.admin_keys) == 2
        assert restored.admin_keys[0].label == "Admin One"
        assert restored.admin_keys[1].key == "admin2_key"

    def test_to_signable_json_is_deterministic(self):
        manifest = _make_manifest()
        json1 = manifest.to_signable_json()
        json2 = manifest.to_signable_json()
        assert json1 == json2

    def test_to_signable_json_excludes_signature(self):
        manifest = _make_manifest(signature="should_not_appear")
        signable = manifest.to_signable_json()
        parsed = json.loads(signable)
        assert "signature" not in parsed

    def test_to_signable_json_keys_are_sorted(self):
        manifest = _make_manifest()
        signable = manifest.to_signable_json()
        parsed = json.loads(signable)
        keys = list(parsed.keys())
        assert keys == sorted(keys)


# ── ChunkPayload ───────────────────────────────────────────────


class TestChunkPayload:
    def test_roundtrip(self):
        payload = ChunkPayload(
            content_type="text",
            payload=b"Hello, channel!",
            metadata={"format": "plain"},
        )
        raw = payload.to_bytes()
        restored = ChunkPayload.from_bytes(raw)
        assert restored.content_type == "text"
        assert restored.payload == b"Hello, channel!"
        assert restored.metadata["format"] == "plain"

    def test_with_reply_and_author(self):
        payload = ChunkPayload(
            content_type="text",
            payload=b"Reply content",
            reply_to="msg_id_123",
            author="admin_key_b64",
        )
        raw = payload.to_bytes()
        restored = ChunkPayload.from_bytes(raw)
        assert restored.reply_to == "msg_id_123"
        assert restored.author == "admin_key_b64"


# ── Chunk ──────────────────────────────────────────────────────


class TestChunk:
    def test_roundtrip(self):
        chunk = Chunk(
            chunk_id="ch_test_001",
            routing_hash="abc123",
            sequence=1,
            chunk_index=0,
            total_chunks=1,
            size=100,
            signature="sig_b64",
            author_pubkey="author_pub_b64",
            encrypted_payload=b"\x01\x02\x03\x04",
        )
        d = chunk.to_dict()
        restored = Chunk.from_dict(d)
        assert restored.chunk_id == chunk.chunk_id
        assert restored.routing_hash == chunk.routing_hash
        assert restored.sequence == chunk.sequence
        assert restored.chunk_index == chunk.chunk_index
        assert restored.total_chunks == chunk.total_chunks
        assert restored.size == chunk.size
        assert restored.signature == chunk.signature
        assert restored.author_pubkey == chunk.author_pubkey
        assert restored.encrypted_payload == chunk.encrypted_payload


# ── Invite Link ────────────────────────────────────────────────


class TestInviteLink:
    def test_is_channel_link(self):
        assert is_channel_link("zajel://channel/abc123")
        assert is_channel_link("  zajel://channel/abc123  ")
        assert not is_channel_link("https://example.com")
        assert not is_channel_link("zajel://peer/abc")

    def test_decode_valid_link(self):
        manifest = _make_manifest(
            name="Decode Test", description="Testing decode"
        )
        encryption_key = "test_encryption_key_b64"
        link = _encode_invite_link(manifest, encryption_key)

        decoded_manifest, decoded_key = decode_channel_link(link)
        assert decoded_manifest.name == "Decode Test"
        assert decoded_manifest.description == "Testing decode"
        assert decoded_key == encryption_key

    def test_decode_preserves_all_manifest_fields(self):
        manifest = _make_manifest(
            channel_id="ch-preserve-test",
            name="Full Field Test",
            description="All fields",
            owner_key="owner_key_preserve",
            current_encrypt_key="enc_key_preserve",
            key_epoch=3,
        )
        manifest.admin_keys = [AdminKey(key="adm_key", label="Adm")]
        link = _encode_invite_link(manifest, "key_123")

        decoded_manifest, _ = decode_channel_link(link)
        assert decoded_manifest.channel_id == "ch-preserve-test"
        assert decoded_manifest.owner_key == "owner_key_preserve"
        assert decoded_manifest.current_encrypt_key == "enc_key_preserve"
        assert decoded_manifest.key_epoch == 3
        assert len(decoded_manifest.admin_keys) == 1
        assert decoded_manifest.admin_keys[0].label == "Adm"

    def test_decode_without_prefix(self):
        """decode_channel_link rejects links without the zajel://channel/ prefix."""
        manifest = _make_manifest(name="No Prefix")
        encryption_key = "key_no_prefix"
        payload = {"m": manifest.to_dict(), "k": encryption_key}
        json_bytes = json.dumps(payload).encode("utf-8")
        encoded = base64.urlsafe_b64encode(json_bytes).decode().rstrip("=")

        with pytest.raises(ValueError, match="must start with"):
            decode_channel_link(encoded)

    def test_decode_invalid_link(self):
        with pytest.raises(ValueError):
            decode_channel_link("not_valid_base64!!!")

    def test_decode_empty_link(self):
        with pytest.raises((ValueError, Exception)):
            decode_channel_link("")


# ── ChannelCryptoService ───────────────────────────────────────


class TestChannelCryptoService:
    def test_encrypt_decrypt_payload_roundtrip(self):
        """Encrypt then decrypt a payload, verify content is preserved."""
        # Use a real 32-byte key (base64-encoded)
        key_bytes = os.urandom(32)
        key_b64 = base64.b64encode(key_bytes).decode()

        payload = ChunkPayload(
            content_type="text",
            payload=b"Hello encrypted world!",
        )

        encrypted = ChannelCryptoService.encrypt_payload(
            payload, key_b64, key_epoch=1
        )

        # Encrypted should be larger than plaintext (nonce + MAC)
        assert len(encrypted) > len(payload.to_bytes())

        decrypted = ChannelCryptoService.decrypt_payload(
            encrypted, key_b64, key_epoch=1
        )
        assert decrypted.content_type == "text"
        assert decrypted.payload == b"Hello encrypted world!"

    def test_different_epochs_produce_different_keys(self):
        """Different key epochs should produce different content keys."""
        key_bytes = os.urandom(32)
        key_b64 = base64.b64encode(key_bytes).decode()

        key1 = ChannelCryptoService._derive_content_key(key_b64, 1)
        key2 = ChannelCryptoService._derive_content_key(key_b64, 2)
        assert key1 != key2

    def test_decrypt_with_wrong_key_fails(self):
        """Decrypting with the wrong key should raise an exception."""
        key1 = base64.b64encode(os.urandom(32)).decode()
        key2 = base64.b64encode(os.urandom(32)).decode()

        payload = ChunkPayload(content_type="text", payload=b"secret")
        encrypted = ChannelCryptoService.encrypt_payload(payload, key1, 1)

        with pytest.raises(Exception):
            ChannelCryptoService.decrypt_payload(encrypted, key2, 1)

    def test_decrypt_with_wrong_epoch_fails(self):
        """Decrypting with the wrong epoch should raise an exception."""
        key = base64.b64encode(os.urandom(32)).decode()

        payload = ChunkPayload(content_type="text", payload=b"secret")
        encrypted = ChannelCryptoService.encrypt_payload(payload, key, 1)

        with pytest.raises(Exception):
            ChannelCryptoService.decrypt_payload(encrypted, key, 2)

    def test_decrypt_too_short_payload(self):
        """Decrypting a too-short payload should raise ValueError."""
        key = base64.b64encode(os.urandom(32)).decode()
        with pytest.raises(ValueError, match="too short"):
            ChannelCryptoService.decrypt_payload(b"\x00" * 10, key, 1)

    def test_encrypt_produces_different_ciphertext(self):
        """Each encryption should produce different ciphertext (random nonce)."""
        key = base64.b64encode(os.urandom(32)).decode()
        payload = ChunkPayload(content_type="text", payload=b"test")

        ct1 = ChannelCryptoService.encrypt_payload(payload, key, 1)
        ct2 = ChannelCryptoService.encrypt_payload(payload, key, 1)
        assert ct1 != ct2


# ── ChannelStorage ─────────────────────────────────────────────


class TestChannelStorage:
    def test_save_and_get_channel(self):
        storage = ChannelStorage()
        manifest = _make_manifest(name="Storage Test")
        channel = SubscribedChannel(
            channel_id=manifest.channel_id,
            manifest=manifest,
            encryption_key="enc_key",
        )
        storage.save_channel(channel)

        retrieved = storage.get_channel(manifest.channel_id)
        assert retrieved is not None
        assert retrieved.manifest.name == "Storage Test"
        assert retrieved.encryption_key == "enc_key"

    def test_get_all_channels(self):
        storage = ChannelStorage()
        for i in range(3):
            manifest = _make_manifest(
                channel_id=f"ch-{i}", name=f"Channel {i}"
            )
            storage.save_channel(
                SubscribedChannel(
                    channel_id=manifest.channel_id,
                    manifest=manifest,
                    encryption_key=f"key-{i}",
                )
            )
        channels = storage.get_all_channels()
        assert len(channels) == 3

    def test_delete_channel(self):
        storage = ChannelStorage()
        manifest = _make_manifest()
        storage.save_channel(
            SubscribedChannel(
                channel_id=manifest.channel_id,
                manifest=manifest,
                encryption_key="key",
            )
        )
        storage.delete_channel(manifest.channel_id)
        assert storage.get_channel(manifest.channel_id) is None

    def test_delete_nonexistent_channel_is_noop(self):
        storage = ChannelStorage()
        storage.delete_channel("nonexistent")  # should not raise

    def test_save_and_get_chunk(self):
        storage = ChannelStorage()
        manifest = _make_manifest()
        storage.save_channel(
            SubscribedChannel(
                channel_id=manifest.channel_id,
                manifest=manifest,
                encryption_key="key",
            )
        )
        chunk = Chunk(
            chunk_id="ch_test_001",
            routing_hash="hash",
            sequence=1,
            chunk_index=0,
            total_chunks=2,
            size=10,
            signature="sig",
            author_pubkey="author",
            encrypted_payload=b"\x01\x02",
        )
        storage.save_chunk(manifest.channel_id, chunk)

        chunks = storage.get_chunks_by_sequence(manifest.channel_id, 1)
        assert len(chunks) == 1
        assert chunks[0].chunk_id == "ch_test_001"

    def test_get_latest_sequence(self):
        storage = ChannelStorage()
        manifest = _make_manifest()
        storage.save_channel(
            SubscribedChannel(
                channel_id=manifest.channel_id,
                manifest=manifest,
                encryption_key="key",
            )
        )
        assert storage.get_latest_sequence(manifest.channel_id) == 0

        for seq in [1, 3, 2]:
            storage.save_chunk(
                manifest.channel_id,
                Chunk(
                    chunk_id=f"ch_{seq}",
                    routing_hash="hash",
                    sequence=seq,
                    chunk_index=0,
                    total_chunks=1,
                    size=1,
                    signature="sig",
                    author_pubkey="author",
                    encrypted_payload=b"\x00",
                ),
            )
        assert storage.get_latest_sequence(manifest.channel_id) == 3

    def test_get_chunks_by_sequence_returns_only_matching(self):
        storage = ChannelStorage()
        manifest = _make_manifest()
        storage.save_channel(
            SubscribedChannel(
                channel_id=manifest.channel_id,
                manifest=manifest,
                encryption_key="key",
            )
        )
        for seq in [1, 1, 2]:
            storage.save_chunk(
                manifest.channel_id,
                Chunk(
                    chunk_id=f"ch_seq{seq}_{os.urandom(4).hex()}",
                    routing_hash="hash",
                    sequence=seq,
                    chunk_index=0,
                    total_chunks=1,
                    size=1,
                    signature="sig",
                    author_pubkey="author",
                    encrypted_payload=b"\x00",
                ),
            )
        assert len(storage.get_chunks_by_sequence(manifest.channel_id, 1)) == 2
        assert len(storage.get_chunks_by_sequence(manifest.channel_id, 2)) == 1
        assert len(storage.get_chunks_by_sequence(manifest.channel_id, 3)) == 0


# ── Helper: create a real owned channel with crypto keys ───────


def _make_owned_channel(
    name="Test Owned Channel",
    description="An owned test channel",
    polls_enabled=True,
    replies_enabled=True,
) -> OwnedChannel:
    """Create a real OwnedChannel with generated signing and encryption keys."""
    pub, priv = ChannelCryptoService.generate_signing_keypair()
    enc_pub, enc_priv = ChannelCryptoService.generate_encryption_keypair()
    channel_id = ChannelCryptoService.derive_channel_id(pub)

    manifest = ChannelManifest(
        channel_id=channel_id,
        name=name,
        description=description,
        owner_key=pub,
        current_encrypt_key=enc_pub,
        rules=ChannelRules(
            polls_enabled=polls_enabled,
            replies_enabled=replies_enabled,
        ),
    )
    manifest = ChannelCryptoService.sign_manifest(manifest, priv)

    return OwnedChannel(
        channel_id=channel_id,
        manifest=manifest,
        signing_key_private=priv,
        encryption_key_private=enc_priv,
        encryption_key_public=enc_pub,
    )


# ── Admin Management ──────────────────────────────────────────


class TestAdminManagement:
    def test_appoint_admin(self):
        """Appointing an admin adds them to manifest and re-signs."""
        channel = _make_owned_channel()
        assert len(channel.manifest.admin_keys) == 0

        # Generate an admin key
        admin_pub, _ = ChannelCryptoService.generate_signing_keypair()

        ChannelCryptoService.appoint_admin(channel, admin_pub, "Alice Admin")

        assert len(channel.manifest.admin_keys) == 1
        assert channel.manifest.admin_keys[0].key == admin_pub
        assert channel.manifest.admin_keys[0].label == "Alice Admin"
        # Manifest should be re-signed and valid
        assert ChannelCryptoService.verify_manifest(channel.manifest)

    def test_appoint_admin_duplicate_rejected(self):
        """Cannot appoint the same admin twice."""
        channel = _make_owned_channel()
        admin_pub, _ = ChannelCryptoService.generate_signing_keypair()

        ChannelCryptoService.appoint_admin(channel, admin_pub, "Admin")

        with pytest.raises(ValueError, match="already appointed"):
            ChannelCryptoService.appoint_admin(channel, admin_pub, "Admin Again")

    def test_appoint_owner_as_admin_rejected(self):
        """Cannot appoint the owner as an admin."""
        channel = _make_owned_channel()

        with pytest.raises(ValueError, match="Cannot appoint the owner"):
            ChannelCryptoService.appoint_admin(
                channel, channel.manifest.owner_key, "Owner"
            )

    def test_remove_admin(self):
        """Removing an admin removes them and rotates the encryption key."""
        channel = _make_owned_channel()
        admin_pub, _ = ChannelCryptoService.generate_signing_keypair()

        ChannelCryptoService.appoint_admin(channel, admin_pub, "Admin")
        assert len(channel.manifest.admin_keys) == 1

        old_encrypt_key = channel.manifest.current_encrypt_key
        old_epoch = channel.manifest.key_epoch

        ChannelCryptoService.remove_admin(channel, admin_pub)

        assert len(channel.manifest.admin_keys) == 0
        assert channel.manifest.current_encrypt_key != old_encrypt_key
        assert channel.manifest.key_epoch == old_epoch + 1
        assert ChannelCryptoService.verify_manifest(channel.manifest)

    def test_remove_nonexistent_admin_rejected(self):
        """Cannot remove an admin that is not in the manifest."""
        channel = _make_owned_channel()

        with pytest.raises(ValueError, match="not in the manifest"):
            ChannelCryptoService.remove_admin(channel, "nonexistent_key")

    def test_is_authorized_admin(self):
        """Check admin authorization."""
        channel = _make_owned_channel()
        admin_pub, _ = ChannelCryptoService.generate_signing_keypair()

        assert not ChannelCryptoService.is_authorized_admin(
            channel.manifest, admin_pub
        )

        ChannelCryptoService.appoint_admin(channel, admin_pub, "Admin")

        assert ChannelCryptoService.is_authorized_admin(
            channel.manifest, admin_pub
        )

    def test_is_authorized_publisher(self):
        """Owner and admins are authorized publishers."""
        channel = _make_owned_channel()
        admin_pub, _ = ChannelCryptoService.generate_signing_keypair()

        # Owner is always authorized
        assert ChannelCryptoService.is_authorized_publisher(
            channel.manifest, channel.manifest.owner_key
        )

        # Random key is not authorized
        assert not ChannelCryptoService.is_authorized_publisher(
            channel.manifest, admin_pub
        )

        # After appointing, admin is authorized
        ChannelCryptoService.appoint_admin(channel, admin_pub, "Admin")
        assert ChannelCryptoService.is_authorized_publisher(
            channel.manifest, admin_pub
        )

    def test_appoint_multiple_admins(self):
        """Can appoint multiple admins."""
        channel = _make_owned_channel()

        for i in range(3):
            pub, _ = ChannelCryptoService.generate_signing_keypair()
            ChannelCryptoService.appoint_admin(channel, pub, f"Admin {i}")

        assert len(channel.manifest.admin_keys) == 3
        assert ChannelCryptoService.verify_manifest(channel.manifest)


# ── Key Epoch Rotation ────────────────────────────────────────


class TestKeyEpochRotation:
    def test_rotate_key_increments_epoch(self):
        """Key rotation increments the epoch and changes the key."""
        channel = _make_owned_channel()
        old_key = channel.encryption_key_private
        old_pub = channel.manifest.current_encrypt_key
        old_epoch = channel.manifest.key_epoch

        ChannelCryptoService.rotate_encryption_key(channel)

        assert channel.manifest.key_epoch == old_epoch + 1
        assert channel.encryption_key_private != old_key
        assert channel.manifest.current_encrypt_key != old_pub
        assert ChannelCryptoService.verify_manifest(channel.manifest)

    def test_old_key_cannot_decrypt_new_messages(self):
        """After rotation, the old key cannot decrypt new content."""
        channel = _make_owned_channel()
        old_key = channel.encryption_key_private
        old_epoch = channel.manifest.key_epoch

        # Encrypt with old key
        payload = ChunkPayload(content_type="text", payload=b"old message")
        encrypted_old = ChannelCryptoService.encrypt_payload(
            payload, old_key, old_epoch
        )

        # Rotate key
        ChannelCryptoService.rotate_encryption_key(channel)
        new_key = channel.encryption_key_private
        new_epoch = channel.manifest.key_epoch

        # Old key can still decrypt old message
        decrypted = ChannelCryptoService.decrypt_payload(
            encrypted_old, old_key, old_epoch
        )
        assert decrypted.payload == b"old message"

        # Encrypt with new key
        payload2 = ChunkPayload(content_type="text", payload=b"new message")
        encrypted_new = ChannelCryptoService.encrypt_payload(
            payload2, new_key, new_epoch
        )

        # Old key/epoch cannot decrypt new message
        with pytest.raises(Exception):
            ChannelCryptoService.decrypt_payload(encrypted_new, old_key, old_epoch)

        # New key/epoch can decrypt new message
        decrypted2 = ChannelCryptoService.decrypt_payload(
            encrypted_new, new_key, new_epoch
        )
        assert decrypted2.payload == b"new message"

    def test_multiple_rotations(self):
        """Multiple rotations increment epoch correctly."""
        channel = _make_owned_channel()
        assert channel.manifest.key_epoch == 1

        for i in range(5):
            ChannelCryptoService.rotate_encryption_key(channel)

        assert channel.manifest.key_epoch == 6
        assert ChannelCryptoService.verify_manifest(channel.manifest)


# ── Upstream Message Models ───────────────────────────────────


class TestUpstreamPayload:
    def test_reply_roundtrip(self):
        """UpstreamPayload reply serializes and deserializes correctly."""
        payload = UpstreamPayload(
            type=UpstreamMessageType.reply,
            content="This is a reply",
            reply_to="chunk_abc123",
            timestamp=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        raw = payload.to_bytes()
        restored = UpstreamPayload.from_bytes(raw)

        assert restored.type == UpstreamMessageType.reply
        assert restored.content == "This is a reply"
        assert restored.reply_to == "chunk_abc123"
        assert restored.poll_id is None
        assert restored.vote_option_index is None

    def test_vote_roundtrip(self):
        """UpstreamPayload vote serializes with poll_id and vote_option_index."""
        payload = UpstreamPayload(
            type=UpstreamMessageType.vote,
            content="",
            poll_id="poll_12345678",
            vote_option_index=2,
            timestamp=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        raw = payload.to_bytes()
        restored = UpstreamPayload.from_bytes(raw)

        assert restored.type == UpstreamMessageType.vote
        assert restored.content == ""
        assert restored.poll_id == "poll_12345678"
        assert restored.vote_option_index == 2

    def test_reaction_roundtrip(self):
        """UpstreamPayload reaction serializes correctly."""
        payload = UpstreamPayload(
            type=UpstreamMessageType.reaction,
            content="thumbsup",
            reply_to="chunk_def456",
            timestamp=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        raw = payload.to_bytes()
        restored = UpstreamPayload.from_bytes(raw)

        assert restored.type == UpstreamMessageType.reaction
        assert restored.content == "thumbsup"
        assert restored.reply_to == "chunk_def456"

    def test_to_bytes_matches_dart_format(self):
        """Verify the JSON structure matches the Dart UpstreamPayload.toBytes()."""
        payload = UpstreamPayload(
            type=UpstreamMessageType.reply,
            content="test",
            reply_to="msg_001",
            timestamp=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        raw = payload.to_bytes()
        data = json.loads(raw.decode("utf-8"))

        assert data["type"] == "reply"
        assert data["content"] == "test"
        assert data["reply_to"] == "msg_001"
        assert "timestamp" in data
        # Optional fields should not be present when None
        assert "poll_id" not in data
        assert "vote_option_index" not in data


class TestUpstreamMessage:
    def test_roundtrip(self):
        """UpstreamMessage serializes to dict and back."""
        msg = UpstreamMessage(
            id="up_abc12345",
            channel_id="ch-test-001",
            type=UpstreamMessageType.reply,
            encrypted_payload=b"\x01\x02\x03",
            signature="sig_b64_test",
            sender_ephemeral_key="ephem_pub_test",
            timestamp=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        d = msg.to_dict()
        restored = UpstreamMessage.from_dict(d)

        assert restored.id == msg.id
        assert restored.channel_id == msg.channel_id
        assert restored.type == UpstreamMessageType.reply
        assert restored.encrypted_payload == b"\x01\x02\x03"
        assert restored.signature == "sig_b64_test"
        assert restored.sender_ephemeral_key == "ephem_pub_test"

    def test_dict_format_matches_dart(self):
        """Verify JSON keys match the Dart UpstreamMessage.toJson() format."""
        msg = UpstreamMessage(
            id="up_test",
            channel_id="ch_test",
            type=UpstreamMessageType.vote,
            encrypted_payload=b"\x00",
            signature="sig",
            sender_ephemeral_key="key",
        )
        d = msg.to_dict()

        assert "id" in d
        assert "channel_id" in d
        assert "type" in d
        assert "encrypted_payload" in d
        assert "signature" in d
        assert "sender_ephemeral_key" in d
        assert "timestamp" in d
        assert d["type"] == "vote"


# ── Upstream Encryption/Decryption ────────────────────────────


class TestUpstreamEncryption:
    def test_encrypt_decrypt_roundtrip(self):
        """Encrypt upstream then decrypt as owner, verify content is preserved."""
        channel = _make_owned_channel()

        payload = UpstreamPayload(
            type=UpstreamMessageType.reply,
            content="Hello owner!",
            reply_to="chunk_001",
        )

        msg = ChannelCryptoService.encrypt_upstream(
            payload=payload,
            owner_encrypt_pub_b64=channel.manifest.current_encrypt_key,
            channel_id=channel.channel_id,
            msg_type=UpstreamMessageType.reply,
        )

        assert msg.id.startswith("up_")
        assert msg.channel_id == channel.channel_id
        assert msg.type == UpstreamMessageType.reply
        assert len(msg.encrypted_payload) > 0

        # Decrypt as owner
        decrypted = ChannelCryptoService.decrypt_upstream(
            message=msg,
            encryption_private_key_b64=channel.encryption_key_private,
            ephemeral_x25519_pub_b64=msg._ephemeral_x25519_pub_b64,
        )

        assert decrypted.type == UpstreamMessageType.reply
        assert decrypted.content == "Hello owner!"
        assert decrypted.reply_to == "chunk_001"

    def test_vote_encrypt_decrypt(self):
        """Encrypt a vote upstream message and decrypt it."""
        channel = _make_owned_channel()

        payload = UpstreamPayload(
            type=UpstreamMessageType.vote,
            content="",
            poll_id="poll_test",
            vote_option_index=1,
        )

        msg = ChannelCryptoService.encrypt_upstream(
            payload=payload,
            owner_encrypt_pub_b64=channel.manifest.current_encrypt_key,
            channel_id=channel.channel_id,
            msg_type=UpstreamMessageType.vote,
        )

        decrypted = ChannelCryptoService.decrypt_upstream(
            message=msg,
            encryption_private_key_b64=channel.encryption_key_private,
            ephemeral_x25519_pub_b64=msg._ephemeral_x25519_pub_b64,
        )

        assert decrypted.type == UpstreamMessageType.vote
        assert decrypted.poll_id == "poll_test"
        assert decrypted.vote_option_index == 1

    def test_reaction_encrypt_decrypt(self):
        """Encrypt a reaction upstream message and decrypt it."""
        channel = _make_owned_channel()

        payload = UpstreamPayload(
            type=UpstreamMessageType.reaction,
            content="heart",
            reply_to="chunk_xyz",
        )

        msg = ChannelCryptoService.encrypt_upstream(
            payload=payload,
            owner_encrypt_pub_b64=channel.manifest.current_encrypt_key,
            channel_id=channel.channel_id,
            msg_type=UpstreamMessageType.reaction,
        )

        decrypted = ChannelCryptoService.decrypt_upstream(
            message=msg,
            encryption_private_key_b64=channel.encryption_key_private,
            ephemeral_x25519_pub_b64=msg._ephemeral_x25519_pub_b64,
        )

        assert decrypted.type == UpstreamMessageType.reaction
        assert decrypted.content == "heart"
        assert decrypted.reply_to == "chunk_xyz"

    def test_wrong_key_cannot_decrypt(self):
        """Upstream message encrypted for one owner cannot be decrypted by another."""
        channel1 = _make_owned_channel()
        channel2 = _make_owned_channel()

        payload = UpstreamPayload(
            type=UpstreamMessageType.reply,
            content="secret",
            reply_to="chunk_001",
        )

        msg = ChannelCryptoService.encrypt_upstream(
            payload=payload,
            owner_encrypt_pub_b64=channel1.manifest.current_encrypt_key,
            channel_id=channel1.channel_id,
            msg_type=UpstreamMessageType.reply,
        )

        # Try to decrypt with wrong owner's key
        with pytest.raises(ValueError):
            ChannelCryptoService.decrypt_upstream(
                message=msg,
                encryption_private_key_b64=channel2.encryption_key_private,
                ephemeral_x25519_pub_b64=msg._ephemeral_x25519_pub_b64,
            )

    def test_tampered_signature_rejected(self):
        """Upstream message with tampered signature is rejected."""
        channel = _make_owned_channel()

        payload = UpstreamPayload(
            type=UpstreamMessageType.reply,
            content="test",
            reply_to="chunk_001",
        )

        msg = ChannelCryptoService.encrypt_upstream(
            payload=payload,
            owner_encrypt_pub_b64=channel.manifest.current_encrypt_key,
            channel_id=channel.channel_id,
            msg_type=UpstreamMessageType.reply,
        )

        # Tamper with the signature
        msg.signature = base64.b64encode(b"\x00" * 64).decode()

        with pytest.raises(ValueError, match="signature"):
            ChannelCryptoService.decrypt_upstream(
                message=msg,
                encryption_private_key_b64=channel.encryption_key_private,
                ephemeral_x25519_pub_b64=msg._ephemeral_x25519_pub_b64,
            )


# ── Poll Models ───────────────────────────────────────────────


class TestPollOption:
    def test_roundtrip(self):
        option = PollOption(index=0, label="Yes")
        d = option.to_dict()
        restored = PollOption.from_dict(d)
        assert restored.index == 0
        assert restored.label == "Yes"


class TestPoll:
    def test_roundtrip(self):
        poll = Poll(
            poll_id="poll_test123",
            question="Do you agree?",
            options=[
                PollOption(index=0, label="Yes"),
                PollOption(index=1, label="No"),
                PollOption(index=2, label="Maybe"),
            ],
            allow_multiple=False,
            created_at=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        d = poll.to_dict()
        restored = Poll.from_dict(d)

        assert restored.poll_id == "poll_test123"
        assert restored.question == "Do you agree?"
        assert len(restored.options) == 3
        assert restored.options[0].label == "Yes"
        assert restored.options[2].label == "Maybe"
        assert restored.allow_multiple is False
        assert restored.closes_at is None

    def test_with_closes_at(self):
        closes = datetime(2026, 3, 1, tzinfo=timezone.utc)
        poll = Poll(
            poll_id="poll_closing",
            question="Time-limited?",
            options=[
                PollOption(index=0, label="A"),
                PollOption(index=1, label="B"),
            ],
            closes_at=closes,
        )
        d = poll.to_dict()
        restored = Poll.from_dict(d)
        assert restored.closes_at is not None

    def test_dict_format_matches_dart(self):
        """Verify JSON keys match the Dart Poll.toJson() format."""
        poll = Poll(
            poll_id="poll_fmt",
            question="Q?",
            options=[
                PollOption(index=0, label="A"),
                PollOption(index=1, label="B"),
            ],
        )
        d = poll.to_dict()
        assert "poll_id" in d
        assert "question" in d
        assert "options" in d
        assert "allow_multiple" in d
        assert "created_at" in d


class TestPollResults:
    def test_roundtrip(self):
        results = PollResults(
            poll_id="poll_r1",
            vote_counts={0: 5, 1: 3, 2: 1},
            total_votes=9,
            is_final=True,
            tallied_at=datetime(2026, 2, 14, tzinfo=timezone.utc),
        )
        d = results.to_dict()
        restored = PollResults.from_dict(d)

        assert restored.poll_id == "poll_r1"
        assert restored.vote_counts == {0: 5, 1: 3, 2: 1}
        assert restored.total_votes == 9
        assert restored.is_final is True

    def test_dict_keys_are_strings(self):
        """Vote counts keys should be stringified ints in the dict."""
        results = PollResults(
            poll_id="poll_keys",
            vote_counts={0: 1, 1: 2},
            total_votes=3,
        )
        d = results.to_dict()
        assert "0" in d["vote_counts"]
        assert "1" in d["vote_counts"]


# ── Poll Tracker ──────────────────────────────────────────────


class TestPollTracker:
    def test_record_and_tally(self):
        """Record votes and tally results."""
        tracker = PollTracker()
        poll = Poll(
            poll_id="poll_tally",
            question="Favorite?",
            options=[
                PollOption(index=0, label="A"),
                PollOption(index=1, label="B"),
                PollOption(index=2, label="C"),
            ],
        )
        tracker.init_poll(poll.poll_id)

        # Record 3 votes
        assert tracker.record_vote(poll.poll_id, 0, "voter_1") is True
        assert tracker.record_vote(poll.poll_id, 1, "voter_2") is True
        assert tracker.record_vote(poll.poll_id, 0, "voter_3") is True

        results = tracker.tally(poll)

        assert results.poll_id == "poll_tally"
        assert results.total_votes == 3
        assert results.vote_counts[0] == 2
        assert results.vote_counts[1] == 1
        assert results.vote_counts[2] == 0

    def test_duplicate_vote_rejected(self):
        """Same sender cannot vote twice."""
        tracker = PollTracker()
        tracker.init_poll("poll_dup")

        assert tracker.record_vote("poll_dup", 0, "voter_1") is True
        assert tracker.record_vote("poll_dup", 1, "voter_1") is False

        assert tracker.get_vote_count("poll_dup") == 1

    def test_vote_on_uninitialized_poll_rejected(self):
        """Voting on a poll that hasn't been initialized returns False."""
        tracker = PollTracker()
        assert tracker.record_vote("unknown_poll", 0, "voter_1") is False

    def test_clear_votes(self):
        """Clearing votes removes all data for a poll."""
        tracker = PollTracker()
        tracker.init_poll("poll_clear")
        tracker.record_vote("poll_clear", 0, "voter_1")

        assert tracker.get_vote_count("poll_clear") == 1

        tracker.clear_votes("poll_clear")
        assert tracker.get_vote_count("poll_clear") == 0

    def test_get_vote_count(self):
        """get_vote_count returns correct count."""
        tracker = PollTracker()
        tracker.init_poll("poll_count")

        assert tracker.get_vote_count("poll_count") == 0

        tracker.record_vote("poll_count", 0, "v1")
        tracker.record_vote("poll_count", 1, "v2")

        assert tracker.get_vote_count("poll_count") == 2

    def test_get_vote_count_unknown_poll(self):
        """get_vote_count returns 0 for unknown poll."""
        tracker = PollTracker()
        assert tracker.get_vote_count("nonexistent") == 0


# ── Poll Chunk Creation ──────────────────────────────────────


class TestPollChunks:
    def test_create_poll_chunks(self):
        """Create encrypted poll chunks and verify they can be decrypted."""
        channel = _make_owned_channel()

        poll = Poll(
            poll_id="poll_chunk_test",
            question="Test question?",
            options=[
                PollOption(index=0, label="Option A"),
                PollOption(index=1, label="Option B"),
            ],
        )

        routing_hash = ChannelCryptoService.derive_routing_hash(
            channel.encryption_key_private
        )
        chunks = ChannelCryptoService.create_poll_chunks(
            poll=poll,
            channel=channel,
            sequence=1,
            routing_hash=routing_hash,
        )

        assert len(chunks) >= 1
        assert chunks[0].sequence == 1

        # Decrypt the chunks to verify content
        combined = b""
        for c in sorted(chunks, key=lambda c: c.chunk_index):
            combined += c.encrypted_payload

        payload = ChannelCryptoService.decrypt_payload(
            combined,
            channel.encryption_key_private,
            channel.manifest.key_epoch,
        )
        assert payload.content_type == "poll"
        poll_data = json.loads(payload.payload.decode("utf-8"))
        assert poll_data["poll_id"] == "poll_chunk_test"
        assert poll_data["question"] == "Test question?"

    def test_create_poll_results_chunks(self):
        """Create encrypted poll results chunks."""
        channel = _make_owned_channel()

        poll = Poll(
            poll_id="poll_res_test",
            question="Results test?",
            options=[
                PollOption(index=0, label="X"),
                PollOption(index=1, label="Y"),
            ],
        )

        results = PollResults(
            poll_id="poll_res_test",
            vote_counts={0: 3, 1: 7},
            total_votes=10,
            is_final=True,
        )

        routing_hash = ChannelCryptoService.derive_routing_hash(
            channel.encryption_key_private
        )
        chunks = ChannelCryptoService.create_poll_results_chunks(
            results=results,
            poll=poll,
            channel=channel,
            sequence=2,
            routing_hash=routing_hash,
            is_final=True,
        )

        assert len(chunks) >= 1

        # Decrypt and verify
        combined = b""
        for c in sorted(chunks, key=lambda c: c.chunk_index):
            combined += c.encrypted_payload

        payload = ChannelCryptoService.decrypt_payload(
            combined,
            channel.encryption_key_private,
            channel.manifest.key_epoch,
        )
        assert payload.content_type == "poll"
        assert payload.metadata.get("is_results") is True
        assert payload.metadata.get("is_final") is True

        results_data = json.loads(payload.payload.decode("utf-8"))
        assert results_data["total_votes"] == 10
