"""Tests for the cryptographic operations."""

import base64
import os
import tempfile
import time
from unittest.mock import patch

import pytest
from zajel.crypto import (
    CryptoService,
    GRACE_PERIOD_SECONDS,
    RATCHET_NONCE_SIZE,
)


class TestCryptoService:
    def test_initialize_generates_key_pair(self):
        crypto = CryptoService()
        crypto.initialize()
        assert crypto.public_key_bytes is not None
        assert len(crypto.public_key_bytes) == 32

    def test_public_key_base64(self):
        crypto = CryptoService()
        crypto.initialize()
        b64 = crypto.public_key_base64
        decoded = base64.b64decode(b64)
        assert decoded == crypto.public_key_bytes

    def test_key_exchange_produces_session_key(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice_key = alice.perform_key_exchange("bob", bob.public_key_base64)
        bob_key = bob.perform_key_exchange("alice", alice.public_key_base64)

        assert alice_key == bob_key
        assert len(alice_key) == 32

    def test_encrypt_decrypt_roundtrip(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)
        bob.perform_key_exchange("alice", alice.public_key_base64)

        plaintext = "Hello, World!"
        ciphertext = alice.encrypt("bob", plaintext)
        decrypted = bob.decrypt("alice", ciphertext)

        assert decrypted == plaintext

    def test_encrypt_produces_different_ciphertext_each_time(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)

        ct1 = alice.encrypt("bob", "test")
        ct2 = alice.encrypt("bob", "test")
        assert ct1 != ct2  # Different nonces

    def test_decrypt_fails_with_wrong_key(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()
        eve = CryptoService()
        eve.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)
        eve.perform_key_exchange("alice", alice.public_key_base64)

        ciphertext = alice.encrypt("bob", "secret")

        with pytest.raises(Exception):
            eve.decrypt("alice", ciphertext)

    def test_has_session_key(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        assert not alice.has_session_key("bob")
        alice.perform_key_exchange("bob", bob.public_key_base64)
        assert alice.has_session_key("bob")

    def test_set_session_key(self):
        alice = CryptoService()
        alice.initialize()

        key = b"\x00" * 32
        alice.set_session_key("peer1", key)
        assert alice.get_session_key("peer1") == key

    def test_daily_meeting_points(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice_points = alice.derive_daily_points(bob.public_key_bytes)
        bob_points = bob.derive_daily_points(alice.public_key_bytes)

        assert alice_points == bob_points
        assert len(alice_points) == 3
        assert all(p.startswith("day_") for p in alice_points)

    def test_hourly_tokens(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)
        bob.perform_key_exchange("alice", alice.public_key_base64)

        alice_key = alice.get_session_key("bob")
        bob_key = bob.get_session_key("alice")

        alice_tokens = alice.derive_hourly_tokens(alice_key)
        bob_tokens = bob.derive_hourly_tokens(bob_key)

        assert alice_tokens == bob_tokens
        assert len(alice_tokens) == 3
        assert all(t.startswith("hr_") for t in alice_tokens)

    def test_encrypt_empty_string(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)
        bob.perform_key_exchange("alice", alice.public_key_base64)

        ciphertext = alice.encrypt("bob", "")
        decrypted = bob.decrypt("alice", ciphertext)
        assert decrypted == ""

    def test_encrypt_unicode(self):
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)
        bob.perform_key_exchange("alice", alice.public_key_base64)

        plaintext = "Hello 🌍 World 🎉 こんにちは"
        ciphertext = alice.encrypt("bob", plaintext)
        decrypted = bob.decrypt("alice", ciphertext)
        assert decrypted == plaintext

    def test_daily_points_from_ids(self):
        crypto = CryptoService()
        crypto.initialize()

        points_ab = crypto.derive_daily_points_from_ids("idA", "idB")
        points_ba = crypto.derive_daily_points_from_ids("idB", "idA")

        assert points_ab == points_ba  # order-independent
        assert len(points_ab) == 3
        assert all(p.startswith("day_") for p in points_ab)

    def test_daily_points_from_ids_different_pairs(self):
        crypto = CryptoService()
        crypto.initialize()

        points_ab = crypto.derive_daily_points_from_ids("idA", "idB")
        points_ac = crypto.derive_daily_points_from_ids("idA", "idC")

        assert points_ab != points_ac

    def test_daily_points_from_ids_cross_client_interop(self):
        """Verify Python produces same values as Dart Flutter client."""
        crypto = CryptoService()
        crypto.initialize()

        # These reference values match the Dart test:
        # deriveDailyPointsFromIdsForDate('abc123def456ab01', 'ff00ee11dd22cc33', 2026-02-18)
        from datetime import datetime, timezone, timedelta
        import hashlib

        my_id = "abc123def456ab01"
        peer_id = "ff00ee11dd22cc33"
        ids = sorted([my_id, peer_id])

        # Compute for 2026-02-18 (today point)
        date_str = "2026-02-18"
        hash_input = ids[0].encode() + ids[1].encode() + f"zajel:daily:{date_str}".encode()
        h = hashlib.sha256(hash_input).digest()
        point = "day_" + base64.urlsafe_b64encode(h).decode()[:22]

        assert point == "day_YgtUz6-JOPCoVxUJxbpWZP"


class TestStableId:
    """Tests for persistent stable ID support."""

    def test_stable_id_is_16_hex_chars(self):
        """stable_id should be 16 uppercase hex characters."""
        crypto = CryptoService()
        crypto.initialize()
        sid = crypto.stable_id
        assert len(sid) == 16
        assert all(c in "0123456789ABCDEF" for c in sid)

    def test_stable_id_derived_from_public_key_by_default(self):
        """Without a persistence path, stable_id is derived from public key."""
        crypto = CryptoService()
        crypto.initialize()
        import hashlib
        expected = hashlib.sha256(crypto.public_key_bytes).hexdigest().upper()[:16]
        assert crypto.stable_id == expected

    def test_stable_id_not_available_before_initialize(self):
        """Accessing stable_id before initialize should raise."""
        crypto = CryptoService()
        with pytest.raises(RuntimeError, match="not initialized"):
            _ = crypto.stable_id

    def test_stable_id_persists_to_file(self):
        """stable_id should be written to file when stable_id_path is provided."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "stable_id.txt")
            crypto = CryptoService(stable_id_path=path)
            crypto.initialize()

            assert os.path.exists(path)
            with open(path) as f:
                stored = f.read().strip()
            assert stored == crypto.stable_id

    def test_stable_id_loaded_from_file(self):
        """stable_id should be loaded from existing file on subsequent init."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "stable_id.txt")

            # First init writes the ID
            crypto1 = CryptoService(stable_id_path=path)
            crypto1.initialize()
            first_id = crypto1.stable_id

            # Second init with different keys should load the same ID
            crypto2 = CryptoService(stable_id_path=path)
            crypto2.initialize()
            assert crypto2.stable_id == first_id

    def test_stable_id_survives_key_rotation(self):
        """stable_id should remain the same even when keys change."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "stable_id.txt")

            crypto1 = CryptoService(stable_id_path=path)
            crypto1.initialize()
            id1 = crypto1.stable_id
            key1 = crypto1.public_key_base64

            # Re-initialize generates new keys
            crypto2 = CryptoService(stable_id_path=path)
            crypto2.initialize()
            id2 = crypto2.stable_id
            key2 = crypto2.public_key_base64

            # Keys differ (new generation), but stable_id is the same
            assert key1 != key2
            assert id1 == id2

    def test_stable_id_without_path_is_key_derived(self):
        """Without persistence, two instances get different IDs (key-derived)."""
        crypto1 = CryptoService()
        crypto1.initialize()
        crypto2 = CryptoService()
        crypto2.initialize()

        # Different keys produce different IDs
        assert crypto1.stable_id != crypto2.stable_id

    def test_peer_id_from_public_key_still_works(self):
        """peer_id_from_public_key should still derive from public key hash."""
        crypto = CryptoService()
        crypto.initialize()

        peer_id = CryptoService.peer_id_from_public_key(crypto.public_key_base64)
        import hashlib
        expected = hashlib.sha256(crypto.public_key_bytes).hexdigest().upper()[:16]
        assert peer_id == expected


class TestEphemeralKeyExchange:
    """Tests for ephemeral key exchange (forward secrecy)."""

    def test_generate_ephemeral_keypair(self):
        priv, pub_bytes = CryptoService.generate_ephemeral_keypair()
        assert priv is not None
        assert len(pub_bytes) == 32

    def test_generate_ephemeral_keypair_unique(self):
        _, pub1 = CryptoService.generate_ephemeral_keypair()
        _, pub2 = CryptoService.generate_ephemeral_keypair()
        assert pub1 != pub2

    def test_ephemeral_session_produces_shared_key(self):
        """Both sides performing ephemeral key exchange get the same session key."""
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        # Each generates an ephemeral keypair
        alice_eph_priv, alice_eph_pub = CryptoService.generate_ephemeral_keypair()
        bob_eph_priv, bob_eph_pub = CryptoService.generate_ephemeral_keypair()

        alice_eph_pub_b64 = base64.b64encode(alice_eph_pub).decode()
        bob_eph_pub_b64 = base64.b64encode(bob_eph_pub).decode()

        alice_key = alice.establish_session_with_ephemeral(
            peer_id="bob",
            peer_identity_key_b64=bob.public_key_base64,
            peer_ephemeral_key_b64=bob_eph_pub_b64,
            our_ephemeral_private_key=alice_eph_priv,
        )

        bob_key = bob.establish_session_with_ephemeral(
            peer_id="alice",
            peer_identity_key_b64=alice.public_key_base64,
            peer_ephemeral_key_b64=alice_eph_pub_b64,
            our_ephemeral_private_key=bob_eph_priv,
        )

        assert alice_key == bob_key
        assert len(alice_key) == 32

    def test_ephemeral_session_encrypt_decrypt(self):
        """Messages encrypted with ephemeral session can be decrypted."""
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice_eph_priv, alice_eph_pub = CryptoService.generate_ephemeral_keypair()
        bob_eph_priv, bob_eph_pub = CryptoService.generate_ephemeral_keypair()

        alice.establish_session_with_ephemeral(
            "bob",
            bob.public_key_base64,
            base64.b64encode(bob_eph_pub).decode(),
            alice_eph_priv,
        )
        bob.establish_session_with_ephemeral(
            "alice",
            alice.public_key_base64,
            base64.b64encode(alice_eph_pub).decode(),
            bob_eph_priv,
        )

        plaintext = "Forward-secret message!"
        ciphertext = alice.encrypt("bob", plaintext)
        decrypted = bob.decrypt("alice", ciphertext)
        assert decrypted == plaintext

    def test_ephemeral_key_differs_from_identity_only(self):
        """Ephemeral session key differs from identity-only session key."""
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        # Identity-only
        identity_key = alice.perform_key_exchange("bob_id", bob.public_key_base64)

        # Ephemeral
        alice_eph_priv, alice_eph_pub = CryptoService.generate_ephemeral_keypair()
        bob_eph_priv, bob_eph_pub = CryptoService.generate_ephemeral_keypair()

        eph_key = alice.establish_session_with_ephemeral(
            "bob_eph",
            bob.public_key_base64,
            base64.b64encode(bob_eph_pub).decode(),
            alice_eph_priv,
        )

        assert identity_key != eph_key

    def test_ephemeral_sets_ratchet_version(self):
        """Ephemeral session initializes ratchet version to 1."""
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice_eph_priv, alice_eph_pub = CryptoService.generate_ephemeral_keypair()
        bob_eph_priv, bob_eph_pub = CryptoService.generate_ephemeral_keypair()

        alice.establish_session_with_ephemeral(
            "bob",
            bob.public_key_base64,
            base64.b64encode(bob_eph_pub).decode(),
            alice_eph_priv,
        )

        assert alice.get_ratchet_version("bob") == 1

    def test_ephemeral_requires_initialization(self):
        """Ephemeral exchange raises if CryptoService not initialized."""
        crypto = CryptoService()
        eph_priv, eph_pub = CryptoService.generate_ephemeral_keypair()

        with pytest.raises(RuntimeError, match="not initialized"):
            crypto.establish_session_with_ephemeral(
                "peer",
                base64.b64encode(b"\x00" * 32).decode(),
                base64.b64encode(eph_pub).decode(),
                eph_priv,
            )

    def test_mixed_exchange_modes_cannot_decrypt(self):
        """If one side uses ephemeral and the other identity-only, decryption fails.

        This simulates the race condition where one side sends a handshake
        with an ephemeral key but the other side hasn't generated its
        ephemeral key yet and falls back to identity-only key exchange.
        The resulting session keys differ, so messages can't be decrypted.
        """
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        # Alice uses ephemeral key exchange (has both identity + ephemeral)
        alice_eph_priv, alice_eph_pub = CryptoService.generate_ephemeral_keypair()
        bob_eph_priv, bob_eph_pub = CryptoService.generate_ephemeral_keypair()

        alice.establish_session_with_ephemeral(
            "bob",
            bob.public_key_base64,
            base64.b64encode(bob_eph_pub).decode(),
            alice_eph_priv,
        )

        # Bob falls back to identity-only (race: ephemeral key not ready)
        bob.perform_key_exchange("alice", alice.public_key_base64)

        # Alice encrypts with ephemeral-derived key
        ciphertext = alice.encrypt("bob", "Hello from Alice")

        # Bob cannot decrypt: his identity-only key differs from Alice's
        # ephemeral-derived key.  This is the exact failure seen in CI:
        # "Decrypt failed for peer ... (sessionHash=...)"
        with pytest.raises(Exception):
            bob.decrypt("alice", ciphertext)


class TestKeyRatcheting:
    """Tests for key ratcheting (in-session forward secrecy)."""

    def _setup_peers(self):
        """Helper: create Alice and Bob with an established session."""
        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        alice.perform_key_exchange("bob", bob.public_key_base64)
        bob.perform_key_exchange("alice", alice.public_key_base64)
        return alice, bob

    def test_ratchet_changes_session_key(self):
        alice, bob = self._setup_peers()
        old_key = alice.get_session_key("bob")

        nonce = alice.ratchet_session_key("bob")
        new_key = alice.get_session_key("bob")

        assert old_key != new_key
        assert len(new_key) == 32
        assert len(nonce) == RATCHET_NONCE_SIZE

    def test_ratchet_both_sides_same_key(self):
        """Both sides ratcheting with the same nonce get the same new key."""
        alice, bob = self._setup_peers()

        nonce = alice.ratchet_session_key("bob")
        bob.ratchet_session_key("alice", nonce=nonce)

        assert alice.get_session_key("bob") == bob.get_session_key("alice")

    def test_ratchet_encrypt_decrypt(self):
        """After ratcheting both sides, messages still work."""
        alice, bob = self._setup_peers()

        nonce = alice.ratchet_session_key("bob")
        bob.ratchet_session_key("alice", nonce=nonce)

        ciphertext = alice.encrypt("bob", "After ratchet")
        decrypted = bob.decrypt("alice", ciphertext)
        assert decrypted == "After ratchet"

    def test_ratchet_increments_version(self):
        alice, bob = self._setup_peers()

        assert alice.get_ratchet_version("bob") == 1
        alice.ratchet_session_key("bob")
        assert alice.get_ratchet_version("bob") == 2
        alice.ratchet_session_key("bob")
        assert alice.get_ratchet_version("bob") == 3

    def test_ratchet_grace_period_old_key_works(self):
        """During grace period, messages encrypted with old key still decrypt."""
        alice, bob = self._setup_peers()

        # Alice encrypts with old key
        ciphertext = alice.encrypt("bob", "Before ratchet")

        # Bob ratchets
        nonce = bob.ratchet_session_key("alice")
        # Alice has NOT ratcheted yet, so ciphertext was encrypted with old key

        # Bob should still be able to decrypt using grace-period old key
        decrypted = bob.decrypt("alice", ciphertext)
        assert decrypted == "Before ratchet"

    def test_ratchet_grace_period_expires(self):
        """After grace period, old key no longer works."""
        alice, bob = self._setup_peers()

        ciphertext = alice.encrypt("bob", "Before ratchet")

        bob.ratchet_session_key("alice")

        # Simulate grace period expiry by manipulating the timestamp
        peer_id = "alice"
        old_key, _ = bob._previous_session_keys[peer_id]
        bob._previous_session_keys[peer_id] = (
            old_key,
            time.monotonic() - GRACE_PERIOD_SECONDS - 1,
        )

        with pytest.raises(Exception):
            bob.decrypt("alice", ciphertext)

    def test_ratchet_no_session_raises(self):
        alice = CryptoService()
        alice.initialize()

        with pytest.raises(RuntimeError, match="No session key"):
            alice.ratchet_session_key("nonexistent")

    def test_ratchet_invalid_nonce_size(self):
        alice, _ = self._setup_peers()

        with pytest.raises(ValueError, match="32 bytes"):
            alice.ratchet_session_key("bob", nonce=b"\x00" * 16)

    def test_ratchet_custom_nonce(self):
        """Providing a specific nonce uses it instead of generating one."""
        alice, bob = self._setup_peers()

        custom_nonce = os.urandom(RATCHET_NONCE_SIZE)
        returned_nonce = alice.ratchet_session_key("bob", nonce=custom_nonce)
        assert returned_nonce == custom_nonce

    # ── Two-phase ratchet (prepare + commit) ──

    def test_prepare_ratchet_does_not_change_active_key(self):
        alice, bob = self._setup_peers()
        old_key = alice.get_session_key("bob")

        nonce = os.urandom(RATCHET_NONCE_SIZE)
        alice.prepare_ratchet("bob", nonce)

        assert alice.get_session_key("bob") == old_key
        assert alice.has_pending_ratchet("bob")

    def test_commit_ratchet_installs_new_key(self):
        alice, bob = self._setup_peers()
        old_key = alice.get_session_key("bob")

        nonce = os.urandom(RATCHET_NONCE_SIZE)
        alice.prepare_ratchet("bob", nonce)
        alice.commit_ratchet("bob")

        assert alice.get_session_key("bob") != old_key
        assert not alice.has_pending_ratchet("bob")

    def test_prepare_commit_matches_direct_ratchet(self):
        """Two-phase ratchet produces same key as direct ratchet."""
        alice, bob = self._setup_peers()

        nonce = os.urandom(RATCHET_NONCE_SIZE)

        # Alice does two-phase
        alice.prepare_ratchet("bob", nonce)
        alice.commit_ratchet("bob")

        # Bob does direct
        bob.ratchet_session_key("alice", nonce=nonce)

        assert alice.get_session_key("bob") == bob.get_session_key("alice")

    def test_commit_ratchet_no_pending_is_noop(self):
        alice, bob = self._setup_peers()
        old_key = alice.get_session_key("bob")

        alice.commit_ratchet("bob")  # No pending ratchet
        assert alice.get_session_key("bob") == old_key

    def test_decrypt_auto_commits_pending_ratchet(self):
        """When peer sends message encrypted with the new key, decrypt
        auto-commits our pending ratchet."""
        alice, bob = self._setup_peers()

        nonce = os.urandom(RATCHET_NONCE_SIZE)

        # Alice prepares (but doesn't commit) the ratchet
        alice.prepare_ratchet("bob", nonce)
        assert alice.has_pending_ratchet("bob")

        # Bob does a direct ratchet and encrypts with the new key
        bob.ratchet_session_key("alice", nonce=nonce)
        ciphertext = bob.encrypt("alice", "With new key")

        # Alice decrypts -- this should auto-commit the pending ratchet
        decrypted = alice.decrypt("bob", ciphertext)
        assert decrypted == "With new key"
        assert not alice.has_pending_ratchet("bob")

    def test_prepare_ratchet_no_session_raises(self):
        alice = CryptoService()
        alice.initialize()

        with pytest.raises(RuntimeError, match="No session key"):
            alice.prepare_ratchet("nonexistent", os.urandom(RATCHET_NONCE_SIZE))

    def test_prepare_ratchet_invalid_nonce_size(self):
        alice, _ = self._setup_peers()

        with pytest.raises(ValueError, match="32 bytes"):
            alice.prepare_ratchet("bob", b"\x00" * 16)

    def test_multiple_ratchets_sequential(self):
        """Multiple sequential ratchets work correctly."""
        alice, bob = self._setup_peers()

        for i in range(5):
            nonce = alice.ratchet_session_key("bob")
            bob.ratchet_session_key("alice", nonce=nonce)

            msg = f"Message after ratchet {i}"
            ct = alice.encrypt("bob", msg)
            assert bob.decrypt("alice", ct) == msg

        assert alice.get_ratchet_version("bob") == 6  # 1 initial + 5 ratchets


class TestHandshakeMessage:
    """Tests for the updated HandshakeMessage format."""

    def test_handshake_with_ephemeral_key(self):
        from zajel.protocol import HandshakeMessage

        eph_key = base64.b64encode(os.urandom(32)).decode()
        msg = HandshakeMessage(
            public_key="publicKeyBase64",
            ephemeral_key=eph_key,
            ratchet_version=1,
            username="TestUser",
            stable_id="ABCD1234EFGH5678",
        )
        json_str = msg.to_json()
        parsed = HandshakeMessage.from_json(json_str)

        assert parsed.public_key == "publicKeyBase64"
        assert parsed.ephemeral_key == eph_key
        assert parsed.ratchet_version == 1
        assert parsed.username == "TestUser"
        assert parsed.stable_id == "ABCD1234EFGH5678"

    def test_handshake_without_ephemeral_key(self):
        """Backward compatibility: handshake without ephemeralKey."""
        from zajel.protocol import HandshakeMessage

        msg = HandshakeMessage(public_key="publicKeyBase64")
        json_str = msg.to_json()
        parsed = HandshakeMessage.from_json(json_str)

        assert parsed.public_key == "publicKeyBase64"
        assert parsed.ephemeral_key is None
        assert parsed.ratchet_version == 1
        assert parsed.username is None
        assert parsed.stable_id is None

    def test_handshake_json_contains_expected_fields(self):
        """Ensure to_json() emits the right field names for interop."""
        import json
        from zajel.protocol import HandshakeMessage

        msg = HandshakeMessage(
            public_key="pk",
            ephemeral_key="ek",
            ratchet_version=2,
            username="Bob",
            stable_id="STABLE123",
        )
        data = json.loads(msg.to_json())

        assert data["type"] == "handshake"
        assert data["publicKey"] == "pk"
        assert data["ephemeralKey"] == "ek"
        assert data["ratchetVersion"] == 2
        assert data["username"] == "Bob"
        assert data["stableId"] == "STABLE123"

    def test_handshake_optional_fields_omitted_from_json(self):
        """Optional fields not set should not appear in JSON."""
        import json
        from zajel.protocol import HandshakeMessage

        msg = HandshakeMessage(public_key="pk")
        data = json.loads(msg.to_json())

        assert "ephemeralKey" not in data
        assert "username" not in data
        assert "stableId" not in data
        assert data["ratchetVersion"] == 1

    def test_handshake_from_json_legacy_format(self):
        """Parse a legacy handshake (only publicKey, no new fields)."""
        import json
        from zajel.protocol import HandshakeMessage

        legacy_json = json.dumps({"type": "handshake", "publicKey": "legacyPK"})
        parsed = HandshakeMessage.from_json(legacy_json)

        assert parsed.public_key == "legacyPK"
        assert parsed.ephemeral_key is None
        assert parsed.ratchet_version == 1
