"""Unit tests for ML-KEM-768 post-quantum key exchange.

Tests:
- ML-KEM availability detection
- Key generation, encapsulation, decapsulation
- Hybrid X25519 + ML-KEM session establishment
- Protocol version negotiation
- Constant correctness (FIPS 203 sizes)
"""

import base64

import pytest

from zajel.ml_kem import (
    MLKEM768_CIPHERTEXT_SIZE,
    MLKEM768_PUBLIC_KEY_SIZE,
    MLKEM768_SHARED_SECRET_SIZE,
    PROTOCOL_VERSION_CLASSICAL,
    PROTOCOL_VERSION_CURRENT,
    PROTOCOL_VERSION_HYBRID,
    SUPPORTED_KEMS,
    generate_mlkem_keypair,
    is_mlkem_available,
    mlkem_decapsulate,
    mlkem_encapsulate,
)


class TestMlKemConstants:
    """Test ML-KEM-768 constants match FIPS 203."""

    def test_public_key_size(self):
        assert MLKEM768_PUBLIC_KEY_SIZE == 1184

    def test_ciphertext_size(self):
        assert MLKEM768_CIPHERTEXT_SIZE == 1088

    def test_shared_secret_size(self):
        assert MLKEM768_SHARED_SECRET_SIZE == 32

    def test_protocol_versions(self):
        assert PROTOCOL_VERSION_CLASSICAL == 1
        assert PROTOCOL_VERSION_HYBRID == 2
        assert PROTOCOL_VERSION_CURRENT == PROTOCOL_VERSION_HYBRID

    def test_supported_kems(self):
        assert "x25519" in SUPPORTED_KEMS
        assert "x25519-mlkem768" in SUPPORTED_KEMS
        assert len(SUPPORTED_KEMS) == 2


class TestMlKemAvailability:
    """Test ML-KEM availability detection."""

    def test_is_mlkem_available_returns_bool(self):
        result = is_mlkem_available()
        assert isinstance(result, bool)

    def test_availability_is_cached(self):
        """Second call should return cached result."""
        result1 = is_mlkem_available()
        result2 = is_mlkem_available()
        assert result1 == result2


@pytest.mark.skipif(
    not is_mlkem_available(),
    reason="ML-KEM not available (cryptography >= 44.0 required)",
)
class TestMlKemKeyOperations:
    """Test ML-KEM key generation, encapsulation, and decapsulation."""

    def test_generate_keypair(self):
        public_key, private_key = generate_mlkem_keypair()
        assert len(public_key) == MLKEM768_PUBLIC_KEY_SIZE
        assert private_key is not None

    def test_encapsulate_produces_correct_sizes(self):
        public_key, _ = generate_mlkem_keypair()
        ciphertext, shared_secret = mlkem_encapsulate(public_key)
        assert len(ciphertext) == MLKEM768_CIPHERTEXT_SIZE
        assert len(shared_secret) == MLKEM768_SHARED_SECRET_SIZE

    def test_decapsulate_recovers_shared_secret(self):
        """Encapsulate + decapsulate should produce same shared secret."""
        public_key, private_key = generate_mlkem_keypair()
        ciphertext, shared_secret_enc = mlkem_encapsulate(public_key)
        shared_secret_dec = mlkem_decapsulate(ciphertext, private_key)
        assert shared_secret_enc == shared_secret_dec

    def test_different_keypairs_produce_different_secrets(self):
        """Two encapsulations to different keys should differ."""
        pub1, _ = generate_mlkem_keypair()
        pub2, _ = generate_mlkem_keypair()
        _, ss1 = mlkem_encapsulate(pub1)
        _, ss2 = mlkem_encapsulate(pub2)
        assert ss1 != ss2

    def test_encapsulate_invalid_key_size(self):
        with pytest.raises(ValueError, match="Invalid ML-KEM public key size"):
            mlkem_encapsulate(b"\x00" * 100)

    def test_decapsulate_invalid_ciphertext_size(self):
        _, private_key = generate_mlkem_keypair()
        with pytest.raises(ValueError, match="Invalid ML-KEM ciphertext size"):
            mlkem_decapsulate(b"\x00" * 100, private_key)


@pytest.mark.skipif(
    not is_mlkem_available(),
    reason="ML-KEM not available (cryptography >= 44.0 required)",
)
class TestHybridSession:
    """Test hybrid X25519 + ML-KEM session establishment."""

    def test_hybrid_session_initiator_responder(self):
        """Full hybrid key exchange between initiator and responder."""
        from zajel.crypto import CryptoService

        alice = CryptoService()
        alice.initialize()

        bob = CryptoService()
        bob.initialize()

        alice_pub = alice.public_key_base64
        bob_pub = bob.public_key_base64
        alice_mlkem_pub = alice.mlkem_public_key_base64
        bob_mlkem_pub = bob.mlkem_public_key_base64

        assert alice_mlkem_pub is not None
        assert bob_mlkem_pub is not None

        # Alice is initiator — encapsulates to Bob's ML-KEM key
        _, alice_ct = alice.establish_hybrid_session(
            peer_id="bob",
            peer_x25519_public_key_b64=bob_pub,
            peer_mlkem_public_key_b64=bob_mlkem_pub,
            role="initiator",
        )
        assert alice_ct is not None

        # Bob is responder — decapsulates using Alice's ciphertext
        ct_b64 = base64.b64encode(alice_ct).decode()
        _, bob_ct = bob.establish_hybrid_session(
            peer_id="alice",
            peer_x25519_public_key_b64=alice_pub,
            peer_mlkem_public_key_b64=alice_mlkem_pub,
            role="responder",
            mlkem_ciphertext_b64=ct_b64,
        )
        assert bob_ct is None  # Responder doesn't produce ciphertext

        # Both should be able to encrypt/decrypt
        encrypted = alice.encrypt("bob", "Quantum-safe hello!")
        decrypted = bob.decrypt("alice", encrypted)
        assert decrypted == "Quantum-safe hello!"

    def test_hybrid_session_uses_different_key_than_classical(self):
        """Hybrid session key should differ from classical."""
        from zajel.crypto import CryptoService

        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        bob_pub = bob.public_key_base64
        bob_mlkem_pub = bob.mlkem_public_key_base64
        assert bob_mlkem_pub is not None

        # Classical session
        classical_key = alice.perform_key_exchange("bob-classical", bob_pub)

        # Hybrid session
        hybrid_key, _ = alice.establish_hybrid_session(
            peer_id="bob-hybrid",
            peer_x25519_public_key_b64=bob_pub,
            peer_mlkem_public_key_b64=bob_mlkem_pub,
            role="initiator",
        )

        # Keys must differ (different HKDF info strings + ML-KEM contribution)
        assert classical_key != hybrid_key

    def test_hybrid_session_invalid_role(self):
        from zajel.crypto import CryptoService

        svc = CryptoService()
        svc.initialize()

        with pytest.raises(ValueError, match="Invalid role"):
            svc.establish_hybrid_session(
                peer_id="peer",
                peer_x25519_public_key_b64="AAAA",
                peer_mlkem_public_key_b64="BBBB",
                role="invalid",
            )

    def test_hybrid_session_responder_without_ciphertext(self):
        from zajel.crypto import CryptoService

        svc = CryptoService()
        svc.initialize()

        bob = CryptoService()
        bob.initialize()

        with pytest.raises(ValueError, match="mlkem_ciphertext_b64 required"):
            svc.establish_hybrid_session(
                peer_id="bob",
                peer_x25519_public_key_b64=bob.public_key_base64,
                peer_mlkem_public_key_b64=bob.mlkem_public_key_base64 or "",
                role="responder",
            )

    def test_protocol_version_tracked(self):
        """After hybrid session, peer version should be HYBRID."""
        from zajel.crypto import CryptoService

        alice = CryptoService()
        alice.initialize()
        bob = CryptoService()
        bob.initialize()

        assert alice.mlkem_public_key_base64 is not None

        alice.establish_hybrid_session(
            peer_id="bob",
            peer_x25519_public_key_b64=bob.public_key_base64,
            peer_mlkem_public_key_b64=bob.mlkem_public_key_base64 or "",
            role="initiator",
        )
        assert alice.get_peer_protocol_version("bob") == PROTOCOL_VERSION_HYBRID
