"""Cryptographic operations compatible with the Dart/Flutter app.

Implements:
- X25519 key exchange (ECDH)
- ChaCha20-Poly1305 AEAD encryption/decryption
- HKDF-SHA256 key derivation
- Meeting point derivation (daily + hourly)
"""

import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# Constants matching the Dart app
NONCE_SIZE = 12
MAC_SIZE = 16
HKDF_INFO = b"zajel_session"
DAILY_PREFIX = "day_"
HOURLY_PREFIX = "hr_"
DAILY_SALT = "zajel:daily:"
HOURLY_SALT = "zajel:hourly:"


class CryptoService:
    """Manages cryptographic keys and encryption for the headless client."""

    def __init__(self):
        self._private_key: Optional[X25519PrivateKey] = None
        self._public_key_bytes: Optional[bytes] = None
        # peerId -> session key (32 bytes)
        self._session_keys: dict[str, bytes] = {}
        # peerId -> peer public key bytes
        self._peer_public_keys: dict[str, bytes] = {}

    def initialize(self) -> None:
        """Generate a new X25519 key pair."""
        self._private_key = X25519PrivateKey.generate()
        self._public_key_bytes = self._private_key.public_key().public_bytes_raw()

    @property
    def public_key_bytes(self) -> bytes:
        """Get our public key as raw bytes."""
        if self._public_key_bytes is None:
            raise RuntimeError("CryptoService not initialized")
        return self._public_key_bytes

    @property
    def public_key_base64(self) -> str:
        """Get our public key as base64."""
        return base64.b64encode(self.public_key_bytes).decode()

    def perform_key_exchange(self, peer_id: str, peer_public_key_b64: str) -> bytes:
        """Perform X25519 key exchange with a peer.

        Args:
            peer_id: The peer's identifier.
            peer_public_key_b64: The peer's X25519 public key (base64).

        Returns:
            The derived 32-byte session key.
        """
        if self._private_key is None:
            raise RuntimeError("CryptoService not initialized")

        peer_pub_bytes = base64.b64decode(peer_public_key_b64)
        self._peer_public_keys[peer_id] = peer_pub_bytes

        peer_pub = X25519PublicKey.from_public_bytes(peer_pub_bytes)
        shared_secret = self._private_key.exchange(peer_pub)

        # Derive session key using HKDF-SHA256
        session_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=b"",
            info=HKDF_INFO,
        ).derive(shared_secret)

        self._session_keys[peer_id] = session_key
        return session_key

    def encrypt(self, peer_id: str, plaintext: str) -> str:
        """Encrypt a message for a peer using ChaCha20-Poly1305.

        Args:
            peer_id: The peer's identifier.
            plaintext: The message to encrypt.

        Returns:
            Base64-encoded ciphertext (nonce || ciphertext || mac).
        """
        key = self._session_keys.get(peer_id)
        if key is None:
            raise RuntimeError(f"No session key for peer {peer_id}")

        nonce = os.urandom(NONCE_SIZE)
        aead = ChaCha20Poly1305(key)
        ciphertext = aead.encrypt(nonce, plaintext.encode(), None)
        # ciphertext includes the 16-byte MAC appended by the library
        return base64.b64encode(nonce + ciphertext).decode()

    def decrypt(self, peer_id: str, ciphertext_b64: str) -> str:
        """Decrypt a message from a peer.

        Args:
            peer_id: The peer's identifier.
            ciphertext_b64: Base64-encoded ciphertext (nonce || ciphertext || mac).

        Returns:
            The decrypted plaintext string.
        """
        key = self._session_keys.get(peer_id)
        if key is None:
            raise RuntimeError(f"No session key for peer {peer_id}")

        raw = base64.b64decode(ciphertext_b64)
        nonce = raw[:NONCE_SIZE]
        ciphertext = raw[NONCE_SIZE:]  # includes MAC

        aead = ChaCha20Poly1305(key)
        plaintext = aead.decrypt(nonce, ciphertext, None)
        return plaintext.decode()

    def has_session_key(self, peer_id: str) -> bool:
        """Check if we have a session key for a peer."""
        return peer_id in self._session_keys

    def get_session_key(self, peer_id: str) -> Optional[bytes]:
        """Get the session key for a peer."""
        return self._session_keys.get(peer_id)

    def set_session_key(self, peer_id: str, key: bytes) -> None:
        """Restore a previously saved session key."""
        self._session_keys[peer_id] = key

    def get_peer_public_key(self, peer_id: str) -> Optional[bytes]:
        """Get a peer's public key bytes."""
        return self._peer_public_keys.get(peer_id)

    # ── Meeting Points ──────────────────────────────────────

    def derive_daily_points(
        self, peer_public_key: bytes, days_offset: tuple[int, ...] = (-1, 0, 1)
    ) -> list[str]:
        """Derive daily meeting points from two public keys.

        Args:
            peer_public_key: The peer's public key bytes.
            days_offset: Day offsets from today (default: yesterday, today, tomorrow).

        Returns:
            List of daily meeting point strings.
        """
        my_pub = self.public_key_bytes
        # Sort keys lexicographically
        keys = sorted([my_pub, peer_public_key])
        now = datetime.now(timezone.utc)

        points = []
        for offset in days_offset:
            day = now + timedelta(days=offset)
            date_str = day.strftime("%Y-%m-%d")
            hash_input = keys[0] + keys[1] + (DAILY_SALT + date_str).encode()
            h = hashlib.sha256(hash_input).digest()
            point = DAILY_PREFIX + base64.urlsafe_b64encode(h).decode()[:22]
            points.append(point)

        return points

    def derive_hourly_tokens(
        self,
        shared_secret: bytes,
        hours_offset: tuple[int, ...] = (-1, 0, 1),
    ) -> list[str]:
        """Derive hourly tokens from a shared session secret.

        Args:
            shared_secret: The session key or shared secret.
            hours_offset: Hour offsets from now.

        Returns:
            List of hourly token strings.
        """
        now = datetime.now(timezone.utc)
        tokens = []
        for offset in hours_offset:
            hour = now + timedelta(hours=offset)
            hour_str = hour.strftime("%Y-%m-%dT%H")
            h = hmac.new(
                shared_secret,
                (HOURLY_SALT + hour_str).encode(),
                hashlib.sha256,
            ).digest()
            token = HOURLY_PREFIX + base64.urlsafe_b64encode(h).decode()[:22]
            tokens.append(token)

        return tokens
