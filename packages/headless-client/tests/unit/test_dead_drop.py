"""Tests for dead drop support: models, encryption/decryption roundtrip."""

import json
from datetime import datetime, timezone

import pytest

from zajel.crypto import CryptoService
from zajel.dead_drop import (
    ConnectionInfo,
    DeadDrop,
    DeadDropDecryptionError,
    LiveMatch,
    RendezvousResult,
    create_dead_drop,
    decrypt_dead_drop,
)


# ── ConnectionInfo ──────────────────────────────────────────────


class TestConnectionInfo:
    def test_roundtrip_dict(self):
        info = ConnectionInfo(
            public_key="abc123pubkey",
            relay_id="relay-001",
            source_id="src-001",
            ip="192.168.1.1",
            port=8080,
            fallback_relays=["relay-002", "relay-003"],
        )
        d = info.to_dict()
        restored = ConnectionInfo.from_dict(d)
        assert restored.public_key == "abc123pubkey"
        assert restored.relay_id == "relay-001"
        assert restored.source_id == "src-001"
        assert restored.ip == "192.168.1.1"
        assert restored.port == 8080
        assert restored.fallback_relays == ["relay-002", "relay-003"]
        assert isinstance(restored.timestamp, datetime)

    def test_roundtrip_json(self):
        info = ConnectionInfo(
            public_key="abc123pubkey",
            relay_id="relay-001",
            source_id="src-001",
        )
        json_str = info.to_json()
        restored = ConnectionInfo.from_json(json_str)
        assert restored.public_key == "abc123pubkey"
        assert restored.relay_id == "relay-001"
        assert restored.source_id == "src-001"

    def test_dart_compatible_keys(self):
        """Verify JSON keys match Dart ConnectionInfo.toJson() format."""
        info = ConnectionInfo(
            public_key="key",
            relay_id="relay",
            source_id="src",
            ip="1.2.3.4",
            port=443,
        )
        d = info.to_dict()
        assert "pubkey" in d
        assert "relay" in d
        assert "sourceId" in d
        assert "ip" in d
        assert "port" in d
        assert "fallbackRelays" in d
        assert "timestamp" in d

    def test_optional_fields_omitted(self):
        """Optional fields not set should not appear in dict."""
        info = ConnectionInfo(public_key="key")
        d = info.to_dict()
        assert "relay" not in d
        assert "sourceId" not in d
        assert "ip" not in d
        assert "port" not in d

    def test_from_dict_with_missing_optional_fields(self):
        """Should handle missing optional fields gracefully."""
        d = {
            "pubkey": "key",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        info = ConnectionInfo.from_dict(d)
        assert info.public_key == "key"
        assert info.relay_id is None
        assert info.source_id is None
        assert info.ip is None
        assert info.port is None
        assert info.fallback_relays == []


# ── DeadDrop ────────────────────────────────────────────────────


class TestDeadDrop:
    def test_roundtrip(self):
        drop = DeadDrop(
            encrypted_payload="encrypted_data_b64",
            relay_id="relay-001",
            meeting_point="day_abc123def456",
            peer_id="peer-001",
        )
        d = drop.to_dict()
        restored = DeadDrop.from_dict(d)
        assert restored.encrypted_payload == "encrypted_data_b64"
        assert restored.relay_id == "relay-001"
        assert restored.meeting_point == "day_abc123def456"
        assert restored.peer_id == "peer-001"
        assert isinstance(restored.retrieved_at, datetime)

    def test_dart_compatible_keys(self):
        drop = DeadDrop(
            encrypted_payload="data",
            relay_id="relay",
            meeting_point="point",
        )
        d = drop.to_dict()
        assert "encryptedPayload" in d
        assert "relayId" in d
        assert "meetingPoint" in d
        assert "peerId" in d
        assert "retrievedAt" in d

    def test_optional_peer_id(self):
        drop = DeadDrop(
            encrypted_payload="data",
            relay_id="relay",
            meeting_point="point",
        )
        assert drop.peer_id is None
        d = drop.to_dict()
        assert d["peerId"] is None


# ── LiveMatch ───────────────────────────────────────────────────


class TestLiveMatch:
    def test_roundtrip(self):
        match = LiveMatch(
            relay_id="relay-001",
            meeting_point="day_abc123",
            peer_id="peer-001",
            connection_hints={"hint": "value"},
        )
        d = match.to_dict()
        restored = LiveMatch.from_dict(d)
        assert restored.relay_id == "relay-001"
        assert restored.meeting_point == "day_abc123"
        assert restored.peer_id == "peer-001"
        assert restored.connection_hints == {"hint": "value"}

    def test_dart_compatible_keys(self):
        match = LiveMatch(
            relay_id="relay",
            meeting_point="point",
        )
        d = match.to_dict()
        assert "peerId" in d
        assert "relayId" in d
        assert "meetingPoint" in d
        assert "connectionHints" in d


# ── RendezvousResult ────────────────────────────────────────────


class TestRendezvousResult:
    def test_empty_result(self):
        result = RendezvousResult()
        assert result.success is True
        assert result.has_matches is False
        assert result.total_matches == 0

    def test_with_live_matches(self):
        result = RendezvousResult(
            live_matches=[
                LiveMatch(relay_id="r1", meeting_point="p1", peer_id="peer1"),
                LiveMatch(relay_id="r2", meeting_point="p2", peer_id="peer2"),
            ]
        )
        assert result.has_matches is True
        assert result.total_matches == 2

    def test_with_dead_drops(self):
        result = RendezvousResult(
            dead_drops=[
                DeadDrop(
                    encrypted_payload="data",
                    relay_id="r1",
                    meeting_point="p1",
                    peer_id="peer1",
                ),
            ]
        )
        assert result.has_matches is True
        assert result.total_matches == 1

    def test_failure(self):
        result = RendezvousResult(success=False, error="connection failed")
        assert result.success is False
        assert result.error == "connection failed"

    def test_roundtrip(self):
        result = RendezvousResult(
            live_matches=[
                LiveMatch(relay_id="r1", meeting_point="p1", peer_id="peer1"),
            ],
            dead_drops=[
                DeadDrop(
                    encrypted_payload="data",
                    relay_id="r2",
                    meeting_point="p2",
                    peer_id="peer2",
                ),
            ],
            success=True,
        )
        d = result.to_dict()
        restored = RendezvousResult.from_dict(d)
        assert len(restored.live_matches) == 1
        assert len(restored.dead_drops) == 1
        assert restored.success is True
        assert restored.live_matches[0].peer_id == "peer1"
        assert restored.dead_drops[0].peer_id == "peer2"


# ── Dead Drop Encryption/Decryption ────────────────────────────


class TestDeadDropCrypto:
    @pytest.fixture
    def paired_crypto(self):
        """Create two CryptoService instances with completed key exchange."""
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()
        alice.perform_key_exchange("bob", bob.public_key_base64)
        bob.perform_key_exchange("alice", alice.public_key_base64)
        return alice, bob

    def test_create_and_decrypt_roundtrip(self, paired_crypto):
        """Test that create_dead_drop + decrypt_dead_drop roundtrips correctly."""
        alice, bob = paired_crypto

        # Alice creates a dead drop for Bob
        conn_info = ConnectionInfo(
            public_key=alice.public_key_base64,
            relay_id="relay-001",
            source_id="alice-src",
            ip="10.0.0.1",
            port=9000,
            fallback_relays=["relay-002"],
        )
        encrypted = create_dead_drop(alice, "bob", conn_info)

        # Bob decrypts the dead drop
        decrypted = decrypt_dead_drop(bob, "alice", encrypted)
        assert decrypted.public_key == alice.public_key_base64
        assert decrypted.relay_id == "relay-001"
        assert decrypted.source_id == "alice-src"
        assert decrypted.ip == "10.0.0.1"
        assert decrypted.port == 9000
        assert decrypted.fallback_relays == ["relay-002"]

    def test_encrypted_payload_is_base64(self, paired_crypto):
        """Verify the encrypted payload is valid base64."""
        alice, _ = paired_crypto
        import base64

        conn_info = ConnectionInfo(
            public_key=alice.public_key_base64,
            relay_id="relay-001",
            source_id="alice-src",
        )
        encrypted = create_dead_drop(alice, "bob", conn_info)
        # Should not raise
        base64.b64decode(encrypted)

    def test_different_encryptions_produce_different_ciphertext(self, paired_crypto):
        """Each encryption should use a fresh nonce, producing different ciphertext."""
        alice, _ = paired_crypto
        conn_info = ConnectionInfo(
            public_key=alice.public_key_base64,
            relay_id="relay-001",
            source_id="alice-src",
        )
        ct1 = create_dead_drop(alice, "bob", conn_info)
        ct2 = create_dead_drop(alice, "bob", conn_info)
        assert ct1 != ct2

    def test_decrypt_with_wrong_peer_fails(self, paired_crypto):
        """Decrypting with the wrong key should fail."""
        alice, bob = paired_crypto

        # Create a third party
        charlie = CryptoService()
        charlie.initialize()
        charlie.perform_key_exchange("alice", alice.public_key_base64)

        conn_info = ConnectionInfo(
            public_key=alice.public_key_base64,
            relay_id="relay-001",
            source_id="alice-src",
        )
        encrypted = create_dead_drop(alice, "bob", conn_info)

        # Charlie cannot decrypt (different session key)
        with pytest.raises((DeadDropDecryptionError, Exception)):
            decrypt_dead_drop(charlie, "alice", encrypted)

    def test_decrypt_without_session_key_raises(self):
        """Decrypting without a session key should raise RuntimeError."""
        crypto = CryptoService()
        crypto.initialize()

        with pytest.raises(RuntimeError, match="No session key"):
            decrypt_dead_drop(crypto, "unknown-peer", "invalid_base64")

    def test_create_without_session_key_raises(self):
        """Creating a dead drop without a session key should raise RuntimeError."""
        crypto = CryptoService()
        crypto.initialize()

        conn_info = ConnectionInfo(public_key=crypto.public_key_base64)
        with pytest.raises(RuntimeError, match="No session key"):
            create_dead_drop(crypto, "unknown-peer", conn_info)

    def test_decrypt_corrupted_payload_raises(self, paired_crypto):
        """Decrypting a corrupted payload should raise DeadDropDecryptionError."""
        _, bob = paired_crypto

        import base64
        corrupted = base64.b64encode(b"\x00" * 50).decode()
        with pytest.raises((DeadDropDecryptionError, Exception)):
            decrypt_dead_drop(bob, "alice", corrupted)

    def test_minimal_connection_info_roundtrip(self, paired_crypto):
        """Test roundtrip with minimal ConnectionInfo (only required fields)."""
        alice, bob = paired_crypto

        conn_info = ConnectionInfo(
            public_key=alice.public_key_base64,
        )
        encrypted = create_dead_drop(alice, "bob", conn_info)
        decrypted = decrypt_dead_drop(bob, "alice", encrypted)
        assert decrypted.public_key == alice.public_key_base64
        assert decrypted.relay_id is None
        assert decrypted.source_id is None
