"""Tests for channel support: invite links, manifests, crypto, storage."""

import base64
import json
import os

import pytest

from zajel.channels import (
    AdminKey,
    ChannelCryptoService,
    ChannelManifest,
    ChannelRules,
    ChannelStorage,
    Chunk,
    ChunkPayload,
    SubscribedChannel,
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
        """decode_channel_link can handle just the encoded part."""
        manifest = _make_manifest(name="No Prefix")
        encryption_key = "key_no_prefix"
        payload = {"m": manifest.to_dict(), "k": encryption_key}
        json_bytes = json.dumps(payload).encode("utf-8")
        encoded = base64.urlsafe_b64encode(json_bytes).decode().rstrip("=")

        decoded_manifest, decoded_key = decode_channel_link(encoded)
        assert decoded_manifest.name == "No Prefix"
        assert decoded_key == encryption_key

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
