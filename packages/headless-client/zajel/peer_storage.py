"""Local peer and session key storage using SQLite.

Stores:
- Trusted peer information (public key, name, timestamps)
- Session keys for reconnection
- Block list
"""

import logging
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger("zajel.peer_storage")


@dataclass
class StoredPeer:
    """A trusted peer stored locally."""

    peer_id: str
    display_name: str
    public_key: str  # base64
    session_key: Optional[bytes] = None
    trusted_at: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    alias: Optional[str] = None
    is_blocked: bool = False


class PeerStorage:
    """SQLite-backed storage for peer information and session keys."""

    def __init__(self, db_path: str = "zajel_peers.db"):
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def initialize(self) -> None:
        """Open or create the database."""
        db_existed = os.path.exists(self._db_path)
        self._conn = sqlite3.connect(self._db_path)
        if not db_existed:
            os.chmod(self._db_path, 0o600)
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS peers (
                peer_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                public_key TEXT NOT NULL,
                session_key BLOB,
                trusted_at TEXT,
                last_seen TEXT,
                alias TEXT,
                is_blocked INTEGER DEFAULT 0
            )
        """)
        self._conn.commit()
        self._master_key = self._get_or_create_master_key(self._db_path)

    def save_peer(self, peer: StoredPeer) -> None:
        """Save or update a peer."""
        if self._conn is None:
            return
        self._conn.execute(
            """INSERT OR REPLACE INTO peers
               (peer_id, display_name, public_key, session_key, trusted_at, last_seen, alias, is_blocked)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                peer.peer_id,
                peer.display_name,
                peer.public_key,
                peer.session_key,
                peer.trusted_at.isoformat() if peer.trusted_at else None,
                peer.last_seen.isoformat() if peer.last_seen else None,
                peer.alias,
                1 if peer.is_blocked else 0,
            ),
        )
        self._conn.commit()

    def get_peer(self, peer_id: str) -> Optional[StoredPeer]:
        """Get a peer by ID."""
        if self._conn is None:
            return None
        row = self._conn.execute(
            "SELECT * FROM peers WHERE peer_id = ?", (peer_id,)
        ).fetchone()
        return self._row_to_peer(row) if row else None

    def get_all_peers(self) -> list[StoredPeer]:
        """Get all non-blocked peers."""
        if self._conn is None:
            return []
        rows = self._conn.execute(
            "SELECT * FROM peers WHERE is_blocked = 0"
        ).fetchall()
        return [self._row_to_peer(row) for row in rows]

    def is_trusted(self, peer_id: str) -> bool:
        """Check if a peer is trusted."""
        return self.get_peer(peer_id) is not None

    def is_trusted_by_public_key(self, public_key: str) -> bool:
        """Check if a peer is trusted by their public key."""
        if self._conn is None:
            return False
        row = self._conn.execute(
            "SELECT 1 FROM peers WHERE public_key = ? AND is_blocked = 0",
            (public_key,),
        ).fetchone()
        return row is not None

    def remove_peer(self, peer_id: str) -> None:
        """Remove a peer."""
        if self._conn is None:
            return
        self._conn.execute("DELETE FROM peers WHERE peer_id = ?", (peer_id,))
        self._conn.commit()

    def block_peer(self, peer_id: str) -> None:
        """Block a peer."""
        if self._conn is None:
            return
        self._conn.execute(
            "UPDATE peers SET is_blocked = 1 WHERE peer_id = ?", (peer_id,)
        )
        self._conn.commit()

    def unblock_peer(self, peer_id: str) -> None:
        """Unblock a peer."""
        if self._conn is None:
            return
        self._conn.execute(
            "UPDATE peers SET is_blocked = 0 WHERE peer_id = ?", (peer_id,)
        )
        self._conn.commit()

    def save_session_key(self, peer_id: str, session_key: bytes) -> None:
        """Save a session key for a peer (encrypted with master key)."""
        if self._conn is None:
            return
        encrypted = self._encrypt_key(session_key)
        self._conn.execute(
            "UPDATE peers SET session_key = ? WHERE peer_id = ?",
            (encrypted, peer_id),
        )
        self._conn.commit()

    def get_session_key(self, peer_id: str) -> Optional[bytes]:
        """Get the session key for a peer (decrypted from storage)."""
        if self._conn is None:
            return None
        row = self._conn.execute(
            "SELECT session_key FROM peers WHERE peer_id = ?", (peer_id,)
        ).fetchone()
        if not row or not row[0]:
            return None
        try:
            return self._decrypt_key(row[0])
        except Exception:
            logger.warning(
                "Failed to decrypt session key for peer %s "
                "(may be legacy plaintext)", peer_id
            )
            return row[0]

    @staticmethod
    def _get_or_create_master_key(db_path: str) -> bytes:
        """Get or create a master key for encrypting session keys."""
        key_path = db_path + ".key"
        if os.path.exists(key_path):
            with open(key_path, "rb") as f:
                return f.read()
        key = os.urandom(32)
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(key)
        return key

    def _encrypt_key(self, plaintext: bytes) -> bytes:
        """Encrypt a session key using ChaCha20-Poly1305 with the master key."""
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        nonce = os.urandom(12)
        cipher = ChaCha20Poly1305(self._master_key)
        ciphertext = cipher.encrypt(nonce, plaintext, None)
        return nonce + ciphertext

    def _decrypt_key(self, data: bytes) -> bytes:
        """Decrypt a session key using ChaCha20-Poly1305 with the master key."""
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        if len(data) < 12:
            raise ValueError("Encrypted data too short")
        nonce = data[:12]
        ciphertext = data[12:]
        cipher = ChaCha20Poly1305(self._master_key)
        return cipher.decrypt(nonce, ciphertext, None)

    def close(self) -> None:
        """Close the database connection."""
        if self._conn:
            self._conn.close()
            self._conn = None

    @staticmethod
    def _row_to_peer(row: tuple) -> StoredPeer:
        return StoredPeer(
            peer_id=row[0],
            display_name=row[1],
            public_key=row[2],
            session_key=row[3],
            trusted_at=datetime.fromisoformat(row[4]) if row[4] else None,
            last_seen=datetime.fromisoformat(row[5]) if row[5] else None,
            alias=row[6],
            is_blocked=bool(row[7]),
        )
