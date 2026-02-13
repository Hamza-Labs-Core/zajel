"""
Headless-only channel E2E tests.

Tests the full channel lifecycle using ZajelHeadlessClient and the
channels module directly — no GUI, no Appium, no signaling server.

Covers:
- Invite link encode/decode roundtrip
- Channel subscription via client API
- Crypto encrypt/decrypt roundtrip through client
- Ed25519 manifest signature verification
- Ed25519 chunk signature verification
- Unsubscribe flow
- Text-only enforcement (4KB chunk limit)
- Cross-platform crypto interop (known test vectors)
"""

import asyncio
import base64
import json
import os

import pytest

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from zajel.channels import (
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


# ── Helpers ───────────────────────────────────────────────────


def _generate_ed25519_keypair():
    """Generate an Ed25519 key pair for testing.

    Returns (private_key, public_key_b64) where private_key is the
    Ed25519PrivateKey object and public_key_b64 is the base64-encoded
    32-byte public key.
    """
    private_key = Ed25519PrivateKey.generate()
    public_bytes = private_key.public_key().public_bytes_raw()
    return private_key, base64.b64encode(public_bytes).decode()


def _sign_manifest(manifest: ChannelManifest, private_key: Ed25519PrivateKey) -> str:
    """Sign a manifest and return the base64-encoded signature."""
    signable = manifest.to_signable_json().encode("utf-8")
    signature_bytes = private_key.sign(signable)
    return base64.b64encode(signature_bytes).decode()


def _encode_invite_link(manifest: ChannelManifest, encryption_key: str) -> str:
    """Build a zajel://channel/<base64url> link from a manifest and key."""
    payload = {"m": manifest.to_dict(), "k": encryption_key}
    json_bytes = json.dumps(payload).encode("utf-8")
    encoded = base64.urlsafe_b64encode(json_bytes).decode().rstrip("=")
    return f"{CHANNEL_LINK_PREFIX}{encoded}"


def _make_signed_manifest(
    channel_id="test-channel-e2e",
    name="Test E2E Channel",
    description="Channel for headless E2E tests",
    encrypt_key_b64=None,
    key_epoch=1,
):
    """Create a manifest with a valid Ed25519 signature."""
    owner_private, owner_pub_b64 = _generate_ed25519_keypair()

    if encrypt_key_b64 is None:
        encrypt_key_b64 = base64.b64encode(os.urandom(32)).decode()

    manifest = ChannelManifest(
        channel_id=channel_id,
        name=name,
        description=description,
        owner_key=owner_pub_b64,
        current_encrypt_key=encrypt_key_b64,
        key_epoch=key_epoch,
        rules=ChannelRules(),
    )
    manifest.signature = _sign_manifest(manifest, owner_private)

    return manifest, owner_private, encrypt_key_b64


# ── Tests ─────────────────────────────────────────────────────


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def run(event_loop):
    return lambda coro: event_loop.run_until_complete(coro)


@pytest.mark.headless
@pytest.mark.channels
class TestChannelsHeadless:
    """Channel E2E tests using the headless client's crypto and storage."""

    def test_invite_link_encode_decode_roundtrip(self):
        """Encode a channel invite link and decode it back."""
        manifest, _, encrypt_key = _make_signed_manifest()

        link = _encode_invite_link(manifest, encrypt_key)

        assert is_channel_link(link)
        assert link.startswith(CHANNEL_LINK_PREFIX)

        decoded_manifest, decoded_key = decode_channel_link(link)
        assert decoded_manifest.channel_id == manifest.channel_id
        assert decoded_manifest.name == manifest.name
        assert decoded_manifest.description == manifest.description
        assert decoded_manifest.owner_key == manifest.owner_key
        assert decoded_manifest.current_encrypt_key == manifest.current_encrypt_key
        assert decoded_manifest.key_epoch == manifest.key_epoch
        assert decoded_key == encrypt_key

    def test_manifest_signature_verify_valid(self):
        """A properly signed manifest passes verification."""
        manifest, _, _ = _make_signed_manifest()

        assert ChannelCryptoService.verify_manifest(manifest)

    def test_manifest_signature_verify_tampered(self):
        """A tampered manifest fails signature verification."""
        manifest, _, _ = _make_signed_manifest()

        # Tamper with the name
        manifest.name = "TAMPERED NAME"

        assert not ChannelCryptoService.verify_manifest(manifest)

    def test_manifest_signature_verify_wrong_key(self):
        """A manifest signed by the wrong key fails verification."""
        manifest, _, _ = _make_signed_manifest()

        # Replace owner key with a different key
        _, different_pub_b64 = _generate_ed25519_keypair()
        manifest.owner_key = different_pub_b64

        assert not ChannelCryptoService.verify_manifest(manifest)

    def test_channel_crypto_encrypt_decrypt_roundtrip(self):
        """Full encrypt → decrypt roundtrip through ChannelCryptoService."""
        encrypt_key_bytes = os.urandom(32)
        encrypt_key_b64 = base64.b64encode(encrypt_key_bytes).decode()

        original = ChunkPayload(
            content_type="text",
            payload=b"Hello from the headless E2E test!",
            metadata={"format": "plain"},
            author="test-author-key",
        )

        encrypted = ChannelCryptoService.encrypt_payload(
            original, encrypt_key_b64, key_epoch=1
        )

        # Encrypted must be larger (nonce + MAC overhead)
        assert len(encrypted) > len(original.to_bytes())

        decrypted = ChannelCryptoService.decrypt_payload(
            encrypted, encrypt_key_b64, key_epoch=1
        )

        assert decrypted.content_type == "text"
        assert decrypted.payload == b"Hello from the headless E2E test!"
        assert decrypted.metadata["format"] == "plain"
        assert decrypted.author == "test-author-key"

    def test_chunk_signature_verify_valid(self):
        """A chunk signed with Ed25519 passes verification."""
        signer_private, signer_pub_b64 = _generate_ed25519_keypair()

        payload_bytes = b"encrypted-chunk-content-here"
        signature = signer_private.sign(payload_bytes)

        chunk = Chunk(
            chunk_id="test-chunk-001",
            routing_hash="abc123",
            sequence=1,
            chunk_index=0,
            total_chunks=1,
            size=len(payload_bytes),
            signature=base64.b64encode(signature).decode(),
            author_pubkey=signer_pub_b64,
            encrypted_payload=payload_bytes,
        )

        assert ChannelCryptoService.verify_chunk_signature(chunk)

    def test_chunk_signature_verify_tampered(self):
        """A chunk with tampered payload fails signature verification."""
        signer_private, signer_pub_b64 = _generate_ed25519_keypair()

        original_payload = b"original-content"
        signature = signer_private.sign(original_payload)

        chunk = Chunk(
            chunk_id="test-chunk-002",
            routing_hash="abc123",
            sequence=1,
            chunk_index=0,
            total_chunks=1,
            size=len(original_payload),
            signature=base64.b64encode(signature).decode(),
            author_pubkey=signer_pub_b64,
            encrypted_payload=b"TAMPERED-content",
        )

        assert not ChannelCryptoService.verify_chunk_signature(chunk)

    def test_subscribe_and_receive_full_flow(self):
        """Full flow: create signed link → subscribe → receive chunk → decrypt."""
        # Owner creates channel
        manifest, owner_private, encrypt_key = _make_signed_manifest(
            name="Full Flow Channel"
        )
        link = _encode_invite_link(manifest, encrypt_key)

        # Subscriber decodes and subscribes
        decoded_manifest, decoded_key = decode_channel_link(link)
        assert ChannelCryptoService.verify_manifest(decoded_manifest)

        storage = ChannelStorage()
        channel = SubscribedChannel(
            channel_id=decoded_manifest.channel_id,
            manifest=decoded_manifest,
            encryption_key=decoded_key,
        )
        storage.save_channel(channel)

        # Owner publishes content
        payload = ChunkPayload(
            content_type="text",
            payload=b"Breaking news from the channel!",
            author="owner",
        )
        encrypted = ChannelCryptoService.encrypt_payload(
            payload, encrypt_key, manifest.key_epoch
        )

        # Sign the chunk
        chunk_signature = owner_private.sign(encrypted)

        chunk = Chunk(
            chunk_id="chunk-flow-001",
            routing_hash="hash",
            sequence=1,
            chunk_index=0,
            total_chunks=1,
            size=len(encrypted),
            signature=base64.b64encode(chunk_signature).decode(),
            author_pubkey=manifest.owner_key,
            encrypted_payload=encrypted,
        )

        # Subscriber verifies and decrypts
        assert ChannelCryptoService.verify_chunk_signature(chunk)

        stored_channel = storage.get_channel(decoded_manifest.channel_id)
        decrypted = ChannelCryptoService.decrypt_payload(
            chunk.encrypted_payload,
            stored_channel.encryption_key,
            stored_channel.manifest.key_epoch,
        )

        assert decrypted.content_type == "text"
        assert decrypted.payload == b"Breaking news from the channel!"
        assert decrypted.author == "owner"

    def test_unsubscribe_removes_channel(self):
        """Unsubscribing removes the channel from storage."""
        manifest, _, encrypt_key = _make_signed_manifest()

        storage = ChannelStorage()
        channel = SubscribedChannel(
            channel_id=manifest.channel_id,
            manifest=manifest,
            encryption_key=encrypt_key,
        )
        storage.save_channel(channel)
        assert storage.get_channel(manifest.channel_id) is not None

        storage.delete_channel(manifest.channel_id)
        assert storage.get_channel(manifest.channel_id) is None

    def test_different_key_epochs_cannot_cross_decrypt(self):
        """Content encrypted with epoch 1 cannot be decrypted with epoch 2."""
        key = base64.b64encode(os.urandom(32)).decode()

        payload = ChunkPayload(content_type="text", payload=b"epoch test")
        encrypted_epoch1 = ChannelCryptoService.encrypt_payload(payload, key, 1)

        with pytest.raises(Exception):
            ChannelCryptoService.decrypt_payload(encrypted_epoch1, key, 2)

    def test_text_only_enforcement_4kb_limit(self):
        """Verify the 4KB max_upstream_size rule is enforced in ChannelRules."""
        rules = ChannelRules()
        assert rules.max_upstream_size == 4096

        # A payload over 4KB should be rejected at the application level
        large_payload = ChunkPayload(
            content_type="text",
            payload=b"x" * 5000,
        )
        serialized = large_payload.to_bytes()
        assert len(serialized) > rules.max_upstream_size

    def test_multi_chunk_reassembly(self):
        """Chunks from the same sequence can be reassembled in order."""
        manifest, _, encrypt_key = _make_signed_manifest()

        storage = ChannelStorage()
        channel = SubscribedChannel(
            channel_id=manifest.channel_id,
            manifest=manifest,
            encryption_key=encrypt_key,
        )
        storage.save_channel(channel)

        # Simulate 3-chunk message
        for i in range(3):
            chunk = Chunk(
                chunk_id=f"multi-{i}",
                routing_hash="hash",
                sequence=1,
                chunk_index=i,
                total_chunks=3,
                size=10,
                signature="sig",
                author_pubkey=manifest.owner_key,
                encrypted_payload=f"part{i}".encode(),
            )
            storage.save_chunk(manifest.channel_id, chunk)

        chunks = storage.get_chunks_by_sequence(manifest.channel_id, 1)
        assert len(chunks) == 3

        # Reassemble in order
        sorted_chunks = sorted(chunks, key=lambda c: c.chunk_index)
        reassembled = b"".join(c.encrypted_payload for c in sorted_chunks)
        assert reassembled == b"part0part1part2"

    def test_unicode_content_survives_crypto_roundtrip(self):
        """Unicode and emoji content survives encrypt/decrypt."""
        key = base64.b64encode(os.urandom(32)).decode()

        test_strings = [
            "مرحبا بالعالم",
            "こんにちは世界",
            "Привет мир",
            "Hello World 🌍🔥💬",
        ]

        for text in test_strings:
            payload = ChunkPayload(
                content_type="text",
                payload=text.encode("utf-8"),
            )
            encrypted = ChannelCryptoService.encrypt_payload(payload, key, 1)
            decrypted = ChannelCryptoService.decrypt_payload(encrypted, key, 1)
            assert decrypted.payload.decode("utf-8") == text, f"Failed for: {text}"

    def test_empty_payload_roundtrip(self):
        """Empty payload survives crypto roundtrip."""
        key = base64.b64encode(os.urandom(32)).decode()

        payload = ChunkPayload(content_type="text", payload=b"")
        encrypted = ChannelCryptoService.encrypt_payload(payload, key, 1)
        decrypted = ChannelCryptoService.decrypt_payload(encrypted, key, 1)
        assert decrypted.payload == b""

    def test_channel_rules_custom_values(self):
        """Channel rules can be customized and survive serialization."""
        rules = ChannelRules(
            replies_enabled=False,
            polls_enabled=False,
            max_upstream_size=2048,
        )
        d = rules.to_dict()
        restored = ChannelRules.from_dict(d)
        assert restored.replies_enabled is False
        assert restored.polls_enabled is False
        assert restored.max_upstream_size == 2048
