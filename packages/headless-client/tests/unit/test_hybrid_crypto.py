"""Tests for post-quantum hybrid KEM combiner and protocol version negotiation.

Verifies cross-platform compatibility using shared test vectors from
docs/security/test-vectors/hybrid-kem-vectors.json.
"""

import pytest
from zajel.crypto import (
    HKDF_INFO_CLASSICAL,
    HKDF_INFO_HYBRID,
    MLKEM768_CIPHERTEXT_SIZE,
    MLKEM768_PUBLIC_KEY_SIZE,
    MLKEM768_SECRET_KEY_SIZE,
    MLKEM768_SHARED_SECRET_SIZE,
    PROTOCOL_VERSION_CLASSICAL,
    PROTOCOL_VERSION_HYBRID,
    PROTOCOL_VERSION_CURRENT,
    SUPPORTED_KEMS,
    derive_hybrid_session_key,
    negotiate_protocol_version,
)


class TestDeriveHybridSessionKey:
    """Tests for the hybrid HKDF-SHA256 key derivation combiner."""

    def test_vector_1_known_secrets(self):
        """Cross-platform test vector 1: known non-zero secrets."""
        x25519_secret = bytes.fromhex(
            "73b8ab88d1b50f58eadcef6b4c51ee50"
            "63b8d192785d46be71bb727168331a4d"
        )
        mlkem_secret = bytes.fromhex(
            "a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8"
            "c1c2c3c4c5c6c7c8d1d2d3d4d5d6d7d8"
        )
        expected = bytes.fromhex(
            "3d69badd53949f348c0f1771167d4a07"
            "33e555942bc35a9873512743d70628a0"
        )

        result = derive_hybrid_session_key(x25519_secret, mlkem_secret)
        assert result == expected

    def test_all_zero_secrets(self):
        """Cross-platform test vector: all-zero shared secrets."""
        all_zeros = bytes(32)
        expected = bytes.fromhex(
            "de04e898e05e6014f0749178da9a6120"
            "976f134cec5ab67082eb4ef9a98115e3"
        )

        result = derive_hybrid_session_key(all_zeros, all_zeros)
        assert result == expected

    def test_all_ff_secrets(self):
        """Cross-platform test vector: all-0xFF shared secrets."""
        all_ff = bytes([0xFF] * 32)
        expected = bytes.fromhex(
            "ca8d6733c59edff4256491da10760cb1"
            "743ac43c55d7bb9d1a3c5a9fb543deaf"
        )

        result = derive_hybrid_session_key(all_ff, all_ff)
        assert result == expected

    def test_hybrid_differs_from_classical(self):
        """Hybrid key must differ from classical with same X25519 secret."""
        from cryptography.hazmat.primitives.hashes import SHA256
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF

        x25519_secret = bytes.fromhex(
            "73b8ab88d1b50f58eadcef6b4c51ee50"
            "63b8d192785d46be71bb727168331a4d"
        )
        mlkem_secret = bytes.fromhex(
            "a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8"
            "c1c2c3c4c5c6c7c8d1d2d3d4d5d6d7d8"
        )

        hybrid_key = derive_hybrid_session_key(x25519_secret, mlkem_secret)

        classical_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=b"",
            info=HKDF_INFO_CLASSICAL,
        ).derive(x25519_secret)

        assert hybrid_key != classical_key

    def test_output_is_32_bytes(self):
        """Output must always be 32 bytes."""
        result = derive_hybrid_session_key(bytes(32), bytes(32))
        assert len(result) == 32

    def test_wrong_x25519_length_raises(self):
        """Must reject X25519 secret with wrong length."""
        with pytest.raises(ValueError, match="X25519 shared secret must be 32 bytes"):
            derive_hybrid_session_key(bytes(16), bytes(32))

    def test_wrong_mlkem_length_raises(self):
        """Must reject ML-KEM secret with wrong length."""
        with pytest.raises(ValueError, match="ML-KEM shared secret must be"):
            derive_hybrid_session_key(bytes(32), bytes(64))

    def test_deterministic(self):
        """Same inputs must always produce the same output."""
        secret = bytes(range(32))
        mlkem = bytes(range(32, 64))

        result1 = derive_hybrid_session_key(secret, mlkem)
        result2 = derive_hybrid_session_key(secret, mlkem)
        assert result1 == result2

    def test_different_inputs_produce_different_keys(self):
        """Different ML-KEM secrets with same X25519 must produce different keys."""
        x25519 = bytes(32)
        mlkem_a = bytes([0xAA] * 32)
        mlkem_b = bytes([0xBB] * 32)

        key_a = derive_hybrid_session_key(x25519, mlkem_a)
        key_b = derive_hybrid_session_key(x25519, mlkem_b)
        assert key_a != key_b


class TestNegotiateProtocolVersion:
    """Tests for protocol version negotiation."""

    def test_both_hybrid(self):
        """Both peers support hybrid and PQ key present -> hybrid."""
        result = negotiate_protocol_version(
            our_version=PROTOCOL_VERSION_HYBRID,
            peer_version=PROTOCOL_VERSION_HYBRID,
            peer_has_pq_key=True,
        )
        assert result == PROTOCOL_VERSION_HYBRID

    def test_we_hybrid_peer_classical(self):
        """We support hybrid, peer is classical -> classical."""
        result = negotiate_protocol_version(
            our_version=PROTOCOL_VERSION_HYBRID,
            peer_version=PROTOCOL_VERSION_CLASSICAL,
            peer_has_pq_key=False,
        )
        assert result == PROTOCOL_VERSION_CLASSICAL

    def test_we_classical_peer_hybrid(self):
        """We are classical, peer supports hybrid -> classical."""
        result = negotiate_protocol_version(
            our_version=PROTOCOL_VERSION_CLASSICAL,
            peer_version=PROTOCOL_VERSION_HYBRID,
            peer_has_pq_key=True,
        )
        assert result == PROTOCOL_VERSION_CLASSICAL

    def test_both_classical(self):
        """Both peers are classical -> classical."""
        result = negotiate_protocol_version(
            our_version=PROTOCOL_VERSION_CLASSICAL,
            peer_version=PROTOCOL_VERSION_CLASSICAL,
            peer_has_pq_key=False,
        )
        assert result == PROTOCOL_VERSION_CLASSICAL

    def test_both_hybrid_but_no_pq_key(self):
        """Both claim hybrid but no PQ key provided -> classical fallback."""
        result = negotiate_protocol_version(
            our_version=PROTOCOL_VERSION_HYBRID,
            peer_version=PROTOCOL_VERSION_HYBRID,
            peer_has_pq_key=False,
        )
        assert result == PROTOCOL_VERSION_CLASSICAL


class TestPostQuantumConstants:
    """Verify post-quantum constant values match FIPS 203."""

    def test_mlkem768_public_key_size(self):
        assert MLKEM768_PUBLIC_KEY_SIZE == 1184

    def test_mlkem768_ciphertext_size(self):
        assert MLKEM768_CIPHERTEXT_SIZE == 1088

    def test_mlkem768_shared_secret_size(self):
        assert MLKEM768_SHARED_SECRET_SIZE == 32

    def test_mlkem768_secret_key_size(self):
        assert MLKEM768_SECRET_KEY_SIZE == 2400

    def test_protocol_versions_are_distinct(self):
        assert PROTOCOL_VERSION_CLASSICAL != PROTOCOL_VERSION_HYBRID

    def test_current_version_is_hybrid(self):
        """PQ hybrid mode is the advertised current version."""
        assert PROTOCOL_VERSION_CURRENT == PROTOCOL_VERSION_HYBRID

    def test_hkdf_info_strings_are_distinct(self):
        assert HKDF_INFO_CLASSICAL != HKDF_INFO_HYBRID

    def test_supported_kems_includes_both(self):
        assert "x25519" in SUPPORTED_KEMS
        assert "x25519-mlkem768" in SUPPORTED_KEMS
