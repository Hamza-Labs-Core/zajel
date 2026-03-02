"""Cryptographic operations compatible with the Dart/Flutter app.

Implements:
- X25519 key exchange (ECDH)
- ChaCha20-Poly1305 AEAD encryption/decryption
- HKDF-SHA256 key derivation
- Ephemeral key exchange for forward secrecy
- Key ratcheting for in-session forward secrecy
- Meeting point derivation (daily + hourly)
"""

import base64
import hashlib
import hmac
import logging
import os
import time
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
HKDF_INFO_V2 = b"zajel_session_v2"
HKDF_RATCHET_INFO = b"zajel_ratchet"
RATCHET_NONCE_SIZE = 32
GRACE_PERIOD_SECONDS = 30
DAILY_PREFIX = "day_"
HOURLY_PREFIX = "hr_"
DAILY_SALT = "zajel:daily:"
HOURLY_SALT = "zajel:hourly:"


class CryptoService:
    """Manages cryptographic keys and encryption for the headless client."""

    def __init__(self, stable_id_path: Optional[str] = None):
        self._private_key: Optional[X25519PrivateKey] = None
        self._public_key_bytes: Optional[bytes] = None
        # peerId -> session key (32 bytes)
        self._session_keys: dict[str, bytes] = {}
        # peerId -> peer public key bytes
        self._peer_public_keys: dict[str, bytes] = {}
        # peerId -> (old_key, expiry_timestamp) for grace period after ratchet
        self._previous_session_keys: dict[str, tuple[bytes, float]] = {}
        # peerId -> (new_key, old_key, nonce) for two-phase ratchets
        self._pending_ratchets: dict[str, tuple[bytes, bytes, bytes]] = {}
        # Current ratchet version per peer
        self._ratchet_versions: dict[str, int] = {}
        # Replay protection: track seen nonces per peer
        self._seen_nonces: dict[str, set[bytes]] = {}
        # Sliding window size for nonce tracking
        self._max_nonce_history = 10000
        # Persistent stable ID (survives key rotation)
        self._stable_id: Optional[str] = None
        self._stable_id_path: Optional[str] = stable_id_path

    def initialize(self) -> None:
        """Generate a new X25519 key pair and load/generate stable ID."""
        self._private_key = X25519PrivateKey.generate()
        self._public_key_bytes = self._private_key.public_key().public_bytes_raw()
        self._load_or_generate_stable_id()

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
        """Get our persistent stable device identity.

        Unlike the public-key-derived peer ID, this is a randomly generated
        16 hex-char identity anchor that survives key rotation.  It is
        persisted to ``stable_id_path`` (if provided) so that it remains
        constant across restarts.

        Mirrors the Flutter app's CryptoService.stableId which uses
        SharedPreferences for persistence.
        """
        if self._stable_id is None:
            raise RuntimeError("CryptoService not initialized")
        return self._stable_id

    def _load_or_generate_stable_id(self) -> None:
        """Load a stable ID from disk or generate a new one.

        Migration strategy (matches Flutter app):
        1. If a file exists at stable_id_path, load from it.
        2. Otherwise, derive from current public key for backward compat.
        3. Persist to stable_id_path if path is provided.
        """
        from pathlib import Path

        # Try loading from file
        if self._stable_id_path:
            path = Path(self._stable_id_path)
            if path.exists():
                stored = path.read_text().strip()
                if len(stored) == 16:
                    self._stable_id = stored
                    return

        # Derive from public key (backward-compatible default)
        digest = hashlib.sha256(self.public_key_bytes).hexdigest().upper()
        self._stable_id = digest[:16]

        # Persist for future runs
        if self._stable_id_path:
            path = Path(self._stable_id_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(self._stable_id)

    @staticmethod
    def peer_id_from_public_key(public_key_b64: str) -> str:
        """Derive a peer ID from a peer's public key.

        This is the public-key-derived ID (SHA-256 hash prefix), NOT the
        persistent stable ID.  Used when no stable ID is available from
        the peer's handshake.
        """
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

    # ── Ephemeral Key Exchange ─────────────────────────────

    @staticmethod
    def generate_ephemeral_keypair() -> tuple[X25519PrivateKey, bytes]:
        """Generate an ephemeral X25519 keypair for forward secrecy.

        Returns:
            Tuple of (private_key, public_key_bytes).
        """
        private_key = X25519PrivateKey.generate()
        public_key_bytes = private_key.public_key().public_bytes_raw()
        return private_key, public_key_bytes

    def establish_session_with_ephemeral(
        self,
        peer_id: str,
        peer_identity_key_b64: str,
        peer_ephemeral_key_b64: str,
        our_ephemeral_private_key: X25519PrivateKey,
    ) -> bytes:
        """Establish a session using both identity and ephemeral key exchange.

        Performs two X25519 ECDH computations:
        1. Identity key x Peer identity key (authenticates both parties)
        2. Ephemeral key x Peer ephemeral key (provides forward secrecy)

        Session key = HKDF(identitySecret || ephemeralSecret, "zajel_session_v2")

        The ephemeral private key should be discarded after this call.
        If the identity key is later compromised, past session keys
        cannot be recovered because the ephemeral secret is gone.

        Args:
            peer_id: The peer's identifier.
            peer_identity_key_b64: Peer's identity public key (base64).
            peer_ephemeral_key_b64: Peer's ephemeral public key (base64).
            our_ephemeral_private_key: Our ephemeral private key object.

        Returns:
            The derived 32-byte session key.
        """
        if self._private_key is None:
            raise RuntimeError("CryptoService not initialized")

        # 1. Identity ECDH
        peer_identity_bytes = base64.b64decode(peer_identity_key_b64)
        self._peer_public_keys[peer_id] = peer_identity_bytes
        peer_identity_pub = X25519PublicKey.from_public_bytes(peer_identity_bytes)
        identity_secret = self._private_key.exchange(peer_identity_pub)

        # 2. Ephemeral ECDH
        peer_ephemeral_bytes = base64.b64decode(peer_ephemeral_key_b64)
        peer_ephemeral_pub = X25519PublicKey.from_public_bytes(peer_ephemeral_bytes)
        ephemeral_secret = our_ephemeral_private_key.exchange(peer_ephemeral_pub)

        # 3. Combine secrets: identity || ephemeral
        combined_secret = identity_secret + ephemeral_secret

        # 4. Derive session key via HKDF with v2 info string
        session_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=b"",
            info=HKDF_INFO_V2,
        ).derive(combined_secret)

        self._session_keys[peer_id] = session_key
        self._ratchet_versions[peer_id] = 1
        self._seen_nonces[peer_id] = set()  # Reset for new session

        # Diagnostic logging
        session_hash = hashlib.sha256(session_key).hexdigest()[:16]
        logger.info(
            "establish_session_with_ephemeral(%s): "
            "peerPub=%s… peerEph=%s… sessionHash=%s",
            peer_id,
            peer_identity_key_b64[:8],
            peer_ephemeral_key_b64[:8],
            session_hash,
        )

        return session_key

    # ── Key Ratcheting ─────────────────────────────────────

    def ratchet_session_key(self, peer_id: str, nonce: Optional[bytes] = None) -> bytes:
        """Ratchet the session key forward using a nonce.

        new_key = HKDF(current_key || nonce, "zajel_ratchet")

        The old key is kept for a brief grace period (30 seconds) to decrypt
        in-flight messages sent before the peer processed the ratchet.

        Args:
            peer_id: The peer's identifier.
            nonce: 32-byte random nonce. Generated if not provided.

        Returns:
            The nonce used (so it can be sent to the peer).
        """
        current_key = self._session_keys.get(peer_id)
        if current_key is None:
            raise RuntimeError(f"No session key to ratchet for peer {peer_id}")

        if nonce is None:
            nonce = os.urandom(RATCHET_NONCE_SIZE)
        if len(nonce) != RATCHET_NONCE_SIZE:
            raise ValueError(
                f"Ratchet nonce must be {RATCHET_NONCE_SIZE} bytes, got {len(nonce)}"
            )

        # Combine current key material with nonce
        combined = current_key + nonce

        # Derive new key
        new_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=b"",
            info=HKDF_RATCHET_INFO,
        ).derive(combined)

        # Clean up expired previous keys
        now = time.monotonic()
        expired = [
            pid for pid, (_, expiry) in self._previous_session_keys.items()
            if now - expiry >= GRACE_PERIOD_SECONDS
        ]
        for pid in expired:
            del self._previous_session_keys[pid]

        # Keep old key for grace period
        self._previous_session_keys[peer_id] = (current_key, now)

        # Install new key
        self._session_keys[peer_id] = new_key
        self._ratchet_versions[peer_id] = self._ratchet_versions.get(peer_id, 1) + 1

        new_hash = hashlib.sha256(new_key).hexdigest()[:16]
        logger.info(
            "ratchet_session_key(%s): newHash=%s version=%d",
            peer_id, new_hash, self._ratchet_versions[peer_id],
        )

        return nonce

    def prepare_ratchet(self, peer_id: str, nonce: bytes) -> None:
        """Prepare a ratchet without committing it.

        Derives the new key but does NOT replace the active session key.
        The caller must later call commit_ratchet() once the peer has
        acknowledged or proved they hold the new key (by successfully
        decrypting with it). This avoids the race where the initiator
        switches keys before the peer has received the ratchet control
        message.

        Args:
            peer_id: The peer's identifier.
            nonce: 32-byte ratchet nonce.
        """
        current_key = self._session_keys.get(peer_id)
        if current_key is None:
            raise RuntimeError(f"No session key for peer {peer_id}")

        if len(nonce) != RATCHET_NONCE_SIZE:
            raise ValueError(
                f"Ratchet nonce must be {RATCHET_NONCE_SIZE} bytes, got {len(nonce)}"
            )

        combined = current_key + nonce

        new_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=b"",
            info=HKDF_RATCHET_INFO,
        ).derive(combined)

        self._pending_ratchets[peer_id] = (new_key, current_key, nonce)

    def commit_ratchet(self, peer_id: str) -> None:
        """Commit a previously prepared ratchet.

        Moves the old key into the grace-period store and installs the
        new key as the active session key.

        Args:
            peer_id: The peer's identifier.
        """
        pending = self._pending_ratchets.pop(peer_id, None)
        if pending is None:
            return

        new_key, old_key, _nonce = pending

        # Clean up expired previous keys
        now = time.monotonic()
        expired = [
            pid for pid, (_, expiry) in self._previous_session_keys.items()
            if now - expiry >= GRACE_PERIOD_SECONDS
        ]
        for pid in expired:
            del self._previous_session_keys[pid]

        # Keep old key for grace period
        self._previous_session_keys[peer_id] = (old_key, now)

        # Install new key
        self._session_keys[peer_id] = new_key
        self._ratchet_versions[peer_id] = self._ratchet_versions.get(peer_id, 1) + 1

        logger.info(
            "Ratchet committed for peer %s (version=%d)",
            peer_id[:8], self._ratchet_versions[peer_id],
        )

    def has_pending_ratchet(self, peer_id: str) -> bool:
        """Whether a prepared-but-not-committed ratchet exists for peer."""
        return peer_id in self._pending_ratchets

    def get_ratchet_version(self, peer_id: str) -> int:
        """Get the current ratchet version for a peer (starts at 1)."""
        return self._ratchet_versions.get(peer_id, 1)

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

        After a key ratchet, falls back to the previous key during the
        grace period if the current key fails to decrypt. Also tries
        a pending ratchet key (we're the initiator, peer already ratcheted).

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

        # Try current key first
        try:
            aead = ChaCha20Poly1305(key)
            plaintext = aead.decrypt(nonce, ciphertext, None)

            # Record the nonce after successful decryption
            self._seen_nonces[peer_id].add(nonce)
            if len(self._seen_nonces[peer_id]) > self._max_nonce_history:
                nonce_list = list(self._seen_nonces[peer_id])
                self._seen_nonces[peer_id] = set(nonce_list[len(nonce_list) // 2:])

            return plaintext.decode()
        except Exception:
            pass

        # Try pending ratchet key (peer already ratcheted and is using new key)
        pending = self._pending_ratchets.get(peer_id)
        if pending is not None:
            new_key, _old_key, _ratchet_nonce = pending
            try:
                aead = ChaCha20Poly1305(new_key)
                plaintext = aead.decrypt(nonce, ciphertext, None)
                # Peer proved they have the new key -- commit the ratchet
                self.commit_ratchet(peer_id)

                # Record nonce
                self._seen_nonces[peer_id].add(nonce)
                if len(self._seen_nonces[peer_id]) > self._max_nonce_history:
                    nonce_list = list(self._seen_nonces[peer_id])
                    self._seen_nonces[peer_id] = set(nonce_list[len(nonce_list) // 2:])

                return plaintext.decode()
            except Exception:
                pass

        # Try previous key during grace period after a ratchet
        prev = self._previous_session_keys.get(peer_id)
        if prev is not None:
            prev_key, expiry = prev
            if time.monotonic() - expiry < GRACE_PERIOD_SECONDS:
                try:
                    aead = ChaCha20Poly1305(prev_key)
                    plaintext = aead.decrypt(nonce, ciphertext, None)

                    # Record nonce
                    self._seen_nonces[peer_id].add(nonce)
                    if len(self._seen_nonces[peer_id]) > self._max_nonce_history:
                        nonce_list = list(self._seen_nonces[peer_id])
                        self._seen_nonces[peer_id] = set(nonce_list[len(nonce_list) // 2:])

                    return plaintext.decode()
                except Exception:
                    pass

        # All keys failed -- raise with original key
        # Re-attempt with current key to get the proper exception
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
