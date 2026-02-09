"""Tests for the cryptographic operations."""

import base64
import pytest
from zajel.crypto import CryptoService


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
