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
import logging
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

logger = logging.getLogger(__name__)

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
        # Replay protection: track seen nonces per peer
        self._seen_nonces: dict[str, set[bytes]] = {}
        # Sliding window size for nonce tracking
        self._max_nonce_history = 10000

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

    @property
    def stable_id(self) -> str:
        """Derive a stable device identity from our public key.

        Matches the Flutter app's CryptoService.peerIdFromPublicKey:
        first 16 chars of SHA-256 hex hash, uppercased.
        """
        digest = hashlib.sha256(self.public_key_bytes).hexdigest().upper()
        return digest[:16]

    @staticmethod
    def peer_id_from_public_key(public_key_b64: str) -> str:
        """Derive a stable ID from a peer's public key (same as Flutter)."""
        pub_bytes = base64.b64decode(public_key_b64)
        return hashlib.sha256(pub_bytes).hexdigest().upper()[:16]

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
        # Info must match Dart app's establishSession() and web client's establishSession()
        # All clients use HKDF_INFO = b"zajel_session" for interop
        session_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=b"",
            info=HKDF_INFO,
        ).derive(shared_secret)

        self._session_keys[peer_id] = session_key
        self._seen_nonces[peer_id] = set()  # Reset for new session

        # Diagnostic: log key fingerprints for cross-platform debugging
        shared_hash = hashlib.sha256(shared_secret).hexdigest()[:16]
        session_hash = hashlib.sha256(session_key).hexdigest()[:16]
        our_pub = self.public_key_base64[:8]
        peer_pub = peer_public_key_b64[:8]
        logger.info(
            "perform_key_exchange(%s): ourPub=%s… peerPub=%s… "
            "sharedHash=%s sessionHash=%s",
            peer_id, our_pub, peer_pub, shared_hash, session_hash,
        )

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

        Raises:
            ValueError: If a replayed nonce is detected.
        """
        key = self._session_keys.get(peer_id)
        if key is None:
            raise RuntimeError(f"No session key for peer {peer_id}")

        raw = base64.b64decode(ciphertext_b64)
        nonce = raw[:NONCE_SIZE]
        ciphertext = raw[NONCE_SIZE:]  # includes MAC

        # Replay detection: check for previously seen nonces
        if peer_id not in self._seen_nonces:
            self._seen_nonces[peer_id] = set()
        if nonce in self._seen_nonces[peer_id]:
            raise ValueError(f"Replay detected: duplicate nonce from peer {peer_id}")

        aead = ChaCha20Poly1305(key)
        plaintext = aead.decrypt(nonce, ciphertext, None)

        # Record the nonce after successful decryption
        self._seen_nonces[peer_id].add(nonce)

        # Evict oldest nonces if the set is too large
        if len(self._seen_nonces[peer_id]) > self._max_nonce_history:
            nonce_list = list(self._seen_nonces[peer_id])
            self._seen_nonces[peer_id] = set(nonce_list[len(nonce_list) // 2:])

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

    def derive_daily_points_from_ids(
        self,
        my_stable_id: str,
        peer_stable_id: str,
        days_offset: tuple[int, ...] = (-1, 0, 1),
    ) -> list[str]:
        """Derive daily meeting points from two stable IDs.

        Unlike derive_daily_points which uses public key bytes, this uses
        persistent stable IDs that survive key rotation.

        Args:
            my_stable_id: Our stable ID (16 hex chars).
            peer_stable_id: Peer's stable ID (16 hex chars).
            days_offset: Day offsets from today.

        Returns:
            List of daily meeting point strings.
        """
        # Sort IDs lexicographically so both sides get same result
        ids = sorted([my_stable_id, peer_stable_id])
        now = datetime.now(timezone.utc)

        points = []
        for offset in days_offset:
            day = now + timedelta(days=offset)
            date_str = day.strftime("%Y-%m-%d")
            hash_input = (
                ids[0].encode() + ids[1].encode() + (DAILY_SALT + date_str).encode()
            )
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

    @staticmethod
    def compute_safety_number(
        public_key_a_base64: str, public_key_b_base64: str
    ) -> str:
        """Compute a shared safety number from two public keys.

        Both peers compute the same number by sorting keys lexicographically
        before hashing. Returns a 60-digit string.

        Compatible with the Dart and TypeScript implementations.
        """
        bytes_a = base64.b64decode(public_key_a_base64)
        bytes_b = base64.b64decode(public_key_b_base64)

        # Sort lexicographically
        if bytes_a <= bytes_b:
            combined = bytes_a + bytes_b
        else:
            combined = bytes_b + bytes_a

        hash_bytes = hashlib.sha256(combined).digest()

        # Format: pairs of bytes → 5-digit number (mod 100000)
        result = ""
        for i in range(0, 24, 2):
            if i + 1 < len(hash_bytes):
                val = ((hash_bytes[i] << 8) | hash_bytes[i + 1]) % 100000
                result += str(val).zfill(5)

        return result[:60]
