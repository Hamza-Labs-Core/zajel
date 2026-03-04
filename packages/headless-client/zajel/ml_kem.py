"""ML-KEM-768 post-quantum key exchange support.

Provides ML-KEM-768 (FIPS 203) key generation, encapsulation, and
decapsulation using the Python cryptography library (>= 44.0).

This module is used by the headless client's CryptoService for hybrid
X25519 + ML-KEM-768 key exchange.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# ML-KEM-768 constants (NIST FIPS 203)
MLKEM768_PUBLIC_KEY_SIZE = 1184
MLKEM768_CIPHERTEXT_SIZE = 1088
MLKEM768_SHARED_SECRET_SIZE = 32

# Protocol version constants
PROTOCOL_VERSION_CLASSICAL = 1
PROTOCOL_VERSION_HYBRID = 2
PROTOCOL_VERSION_CURRENT = PROTOCOL_VERSION_HYBRID
SUPPORTED_KEMS = ["x25519", "x25519-mlkem768"]

# Track whether ML-KEM is available
_mlkem_available: Optional[bool] = None


def is_mlkem_available() -> bool:
    """Check if ML-KEM-768 support is available.

    Requires cryptography >= 44.0 with ML-KEM support.
    """
    global _mlkem_available
    if _mlkem_available is not None:
        return _mlkem_available

    try:
        from cryptography.hazmat.primitives.asymmetric.mlkem import (  # noqa: F401
            MLKEM768PrivateKey,
        )
        _mlkem_available = True
    except ImportError:
        logger.warning(
            "ML-KEM not available: cryptography >= 44.0 required. "
            "Hybrid mode disabled."
        )
        _mlkem_available = False

    return _mlkem_available


def generate_mlkem_keypair():
    """Generate an ML-KEM-768 keypair.

    Returns:
        Tuple of (public_key_bytes, private_key_object).

    Raises:
        RuntimeError: If ML-KEM is not available.
    """
    if not is_mlkem_available():
        raise RuntimeError("ML-KEM not available: cryptography >= 44.0 required")

    from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PrivateKey

    private_key = MLKEM768PrivateKey.generate()
    public_key_bytes = private_key.public_key().public_bytes_raw()
    return public_key_bytes, private_key


def mlkem_encapsulate(peer_public_key_bytes: bytes) -> tuple[bytes, bytes]:
    """Encapsulate to a peer's ML-KEM public key (initiator side).

    Args:
        peer_public_key_bytes: Peer's ML-KEM-768 public key (1184 bytes).

    Returns:
        Tuple of (ciphertext, shared_secret).

    Raises:
        ValueError: If the public key size is invalid.
        RuntimeError: If ML-KEM is not available.
    """
    if not is_mlkem_available():
        raise RuntimeError("ML-KEM not available: cryptography >= 44.0 required")

    if len(peer_public_key_bytes) != MLKEM768_PUBLIC_KEY_SIZE:
        raise ValueError(
            f"Invalid ML-KEM public key size: {len(peer_public_key_bytes)}"
        )

    from cryptography.hazmat.primitives.asymmetric.mlkem import MLKEM768PublicKey

    peer_public_key = MLKEM768PublicKey.from_public_bytes(peer_public_key_bytes)
    ciphertext, shared_secret = peer_public_key.encapsulate()
    return ciphertext, shared_secret


def mlkem_decapsulate(ciphertext: bytes, private_key) -> bytes:
    """Decapsulate a ciphertext (responder side).

    Args:
        ciphertext: ML-KEM-768 ciphertext (1088 bytes).
        private_key: Our ML-KEM-768 private key object.

    Returns:
        The 32-byte shared secret.

    Raises:
        ValueError: If the ciphertext size is invalid.
    """
    if len(ciphertext) != MLKEM768_CIPHERTEXT_SIZE:
        raise ValueError(f"Invalid ML-KEM ciphertext size: {len(ciphertext)}")

    shared_secret = private_key.decapsulate(ciphertext)
    return shared_secret
