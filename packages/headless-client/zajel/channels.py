"""Channel and invite link support for the headless client.

Handles:
- Decoding zajel:// invite links (manifest + decryption key)
- Channel manifest model (matching the Dart app's ChannelManifest)
- Chunk model (matching the Dart app's Chunk)
- Channel subscription storage (in-memory)
- Chunk payload encryption/decryption (HKDF + ChaCha20-Poly1305)
- Ed25519 signature verification for manifests and chunks

Channels use VPS relays (not direct P2P). The headless client stores
subscribed channels locally and can listen for incoming chunks.
"""

import base64
import hashlib
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PublicKey,
)

logger = logging.getLogger("zajel.channels")

# Constants matching the Dart app
NONCE_SIZE = 12
MAC_SIZE = 16
CHANNEL_LINK_PREFIX = "zajel://channel/"


# ── Models ──────────────────────────────────────────────────────


@dataclass
class AdminKey:
    """An admin entry in the channel manifest."""

    key: str  # Ed25519 public key, base64
    label: str

    def to_dict(self) -> dict[str, str]:
        return {"key": self.key, "label": self.label}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "AdminKey":
        return AdminKey(key=data["key"], label=data["label"])


@dataclass
class ChannelRules:
    """Rules governing channel behavior."""

    replies_enabled: bool = True
    polls_enabled: bool = True
    max_upstream_size: int = 4096

    def to_dict(self) -> dict[str, Any]:
        return {
            "replies_enabled": self.replies_enabled,
            "polls_enabled": self.polls_enabled,
            "max_upstream_size": self.max_upstream_size,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ChannelRules":
        return ChannelRules(
            replies_enabled=data.get("replies_enabled", True),
            polls_enabled=data.get("polls_enabled", True),
            max_upstream_size=data.get("max_upstream_size", 4096),
        )


@dataclass
class ChannelManifest:
    """The signed channel manifest."""

    channel_id: str
    name: str
    description: str
    owner_key: str  # Ed25519 public key, base64
    admin_keys: list[AdminKey] = field(default_factory=list)
    current_encrypt_key: str = ""  # X25519 public key, base64
    key_epoch: int = 1
    rules: ChannelRules = field(default_factory=ChannelRules)
    signature: str = ""

    def to_signable_json(self) -> str:
        """Canonical JSON for signing (sorted keys, no signature field).

        Must match the Dart app's toSignableJson() output exactly.
        """
        data = {
            "admin_keys": [a.to_dict() for a in self.admin_keys],
            "channel_id": self.channel_id,
            "current_encrypt_key": self.current_encrypt_key,
            "description": self.description,
            "key_epoch": self.key_epoch,
            "name": self.name,
            "owner_key": self.owner_key,
            "rules": self.rules.to_dict(),
        }
        return json.dumps(data, separators=(",", ":"), ensure_ascii=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "admin_keys": [a.to_dict() for a in self.admin_keys],
            "channel_id": self.channel_id,
            "current_encrypt_key": self.current_encrypt_key,
            "description": self.description,
            "key_epoch": self.key_epoch,
            "name": self.name,
            "owner_key": self.owner_key,
            "rules": self.rules.to_dict(),
            "signature": self.signature,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ChannelManifest":
        admin_keys_raw = data.get("admin_keys") or []
        return ChannelManifest(
            channel_id=data["channel_id"],
            name=data["name"],
            description=data["description"],
            owner_key=data["owner_key"],
            admin_keys=[AdminKey.from_dict(a) for a in admin_keys_raw],
            current_encrypt_key=data["current_encrypt_key"],
            key_epoch=data.get("key_epoch", 1),
            rules=ChannelRules.from_dict(data["rules"])
            if "rules" in data
            else ChannelRules(),
            signature=data.get("signature", ""),
        )


@dataclass
class ChunkPayload:
    """Decrypted content of a channel chunk."""

    content_type: str  # "text", "file", "audio", "video", "document", "poll"
    payload: bytes
    metadata: dict[str, Any] = field(default_factory=dict)
    reply_to: Optional[str] = None
    author: Optional[str] = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_bytes(self) -> bytes:
        """Serialize for encryption (matches Dart ChunkPayload.toBytes)."""
        data: dict[str, Any] = {
            "type": self.content_type,
            "payload": base64.b64encode(self.payload).decode(),
            "metadata": self.metadata,
            "timestamp": self.timestamp.isoformat(),
        }
        if self.reply_to is not None:
            data["reply_to"] = self.reply_to
        if self.author is not None:
            data["author"] = self.author
        return json.dumps(data, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def from_bytes(raw: bytes) -> "ChunkPayload":
        """Deserialize from decrypted bytes."""
        data = json.loads(raw.decode("utf-8"))
        return ChunkPayload(
            content_type=data["type"],
            payload=base64.b64decode(data["payload"]),
            metadata=data.get("metadata", {}),
            reply_to=data.get("reply_to"),
            author=data.get("author"),
            timestamp=datetime.fromisoformat(data["timestamp"]),
        )


@dataclass
class Chunk:
    """A chunk — the atomic unit of channel content."""

    chunk_id: str
    routing_hash: str
    sequence: int
    chunk_index: int
    total_chunks: int
    size: int
    signature: str  # Ed25519 signature, base64
    author_pubkey: str  # Ed25519 public key, base64
    encrypted_payload: bytes

    def to_dict(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "routing_hash": self.routing_hash,
            "sequence": self.sequence,
            "chunk_index": self.chunk_index,
            "total_chunks": self.total_chunks,
            "size": self.size,
            "signature": self.signature,
            "author_pubkey": self.author_pubkey,
            "encrypted_payload": base64.b64encode(self.encrypted_payload).decode(),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Chunk":
        return Chunk(
            chunk_id=data["chunk_id"],
            routing_hash=data["routing_hash"],
            sequence=data["sequence"],
            chunk_index=data["chunk_index"],
            total_chunks=data["total_chunks"],
            size=data["size"],
            signature=data["signature"],
            author_pubkey=data["author_pubkey"],
            encrypted_payload=base64.b64decode(data["encrypted_payload"]),
        )


@dataclass
class SubscribedChannel:
    """A channel the headless client has subscribed to."""

    channel_id: str
    manifest: ChannelManifest
    encryption_key: str  # The shared decryption key (base64)
    subscribed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    chunks: dict[str, Chunk] = field(default_factory=dict)


# ── Invite Link Decode ──────────────────────────────────────────


def decode_channel_link(link: str) -> tuple[ChannelManifest, str]:
    """Decode a zajel://channel/<base64url> invite link.

    Returns:
        (manifest, encryption_key) tuple.

    Raises:
        ValueError: If the link format is invalid.
    """
    trimmed = link.strip()

    if trimmed.startswith(CHANNEL_LINK_PREFIX):
        encoded = trimmed[len(CHANNEL_LINK_PREFIX) :]
    else:
        encoded = trimmed

    # Restore base64url padding
    pad_len = (4 - len(encoded) % 4) % 4
    padded = encoded + "=" * pad_len

    try:
        json_bytes = base64.urlsafe_b64decode(padded)
        payload = json.loads(json_bytes.decode("utf-8"))
    except Exception as e:
        raise ValueError(f"Invalid channel link: {e}") from e

    manifest_data = payload["m"]
    encryption_key = payload["k"]

    manifest = ChannelManifest.from_dict(manifest_data)
    return manifest, encryption_key


def is_channel_link(text: str) -> bool:
    """Check if a string looks like a channel invite link."""
    return text.strip().startswith(CHANNEL_LINK_PREFIX)


# ── Channel Crypto ──────────────────────────────────────────────


class ChannelCryptoService:
    """Cryptographic operations for channels.

    Handles:
    - Ed25519 signature verification for manifests and chunks
    - HKDF-derived content key derivation
    - ChaCha20-Poly1305 decryption of chunk payloads
    """

    @staticmethod
    def verify_manifest(manifest: ChannelManifest) -> bool:
        """Verify a manifest's Ed25519 signature.

        Returns True if the signature is valid.
        """
        try:
            signable = manifest.to_signable_json()
            signable_bytes = signable.encode("utf-8")

            signature_bytes = base64.b64decode(manifest.signature)
            public_key_bytes = base64.b64decode(manifest.owner_key)

            if not signature_bytes or not public_key_bytes:
                return False

            public_key = Ed25519PublicKey.from_public_bytes(public_key_bytes)
            public_key.verify(signature_bytes, signable_bytes)
            return True
        except Exception:
            return False

    @staticmethod
    def verify_chunk_signature(chunk: Chunk) -> bool:
        """Verify a chunk's Ed25519 signature over its encrypted payload.

        Returns True if the signature is valid.
        """
        try:
            signature_bytes = base64.b64decode(chunk.signature)
            public_key_bytes = base64.b64decode(chunk.author_pubkey)

            if not signature_bytes or not public_key_bytes:
                return False

            public_key = Ed25519PublicKey.from_public_bytes(public_key_bytes)
            public_key.verify(signature_bytes, chunk.encrypted_payload)
            return True
        except Exception:
            return False

    @staticmethod
    def _derive_content_key(
        encryption_private_key_b64: str, key_epoch: int
    ) -> bytes:
        """Derive the symmetric content key using HKDF.

        Matches the Dart app's _deriveContentKey method.
        """
        private_key_bytes = base64.b64decode(encryption_private_key_b64)
        info = f"zajel_channel_content_epoch_{key_epoch}".encode("utf-8")

        key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=None,
            info=info,
        ).derive(private_key_bytes)
        return key

    @staticmethod
    def decrypt_payload(
        encrypted_bytes: bytes,
        encryption_private_key_b64: str,
        key_epoch: int,
    ) -> ChunkPayload:
        """Decrypt a chunk's encrypted payload.

        Expects: nonce (12 bytes) + ciphertext + MAC (16 bytes).
        """
        if len(encrypted_bytes) < NONCE_SIZE + MAC_SIZE:
            raise ValueError("Encrypted payload too short")

        content_key = ChannelCryptoService._derive_content_key(
            encryption_private_key_b64, key_epoch
        )

        nonce = encrypted_bytes[:NONCE_SIZE]
        ciphertext_with_mac = encrypted_bytes[NONCE_SIZE:]

        aead = ChaCha20Poly1305(content_key)
        plaintext = aead.decrypt(nonce, ciphertext_with_mac, None)
        return ChunkPayload.from_bytes(plaintext)

    @staticmethod
    def encrypt_payload(
        payload: ChunkPayload,
        encryption_private_key_b64: str,
        key_epoch: int,
    ) -> bytes:
        """Encrypt a chunk payload.

        Returns: nonce (12 bytes) + ciphertext + MAC (16 bytes).
        """
        content_key = ChannelCryptoService._derive_content_key(
            encryption_private_key_b64, key_epoch
        )

        nonce = os.urandom(NONCE_SIZE)
        plaintext = payload.to_bytes()

        aead = ChaCha20Poly1305(content_key)
        ciphertext = aead.encrypt(nonce, plaintext, None)
        return nonce + ciphertext


# ── Channel Storage (in-memory) ─────────────────────────────────


class ChannelStorage:
    """In-memory storage for subscribed channels and their chunks."""

    def __init__(self):
        self._channels: dict[str, SubscribedChannel] = {}

    def save_channel(self, channel: SubscribedChannel) -> None:
        """Save or update a subscribed channel."""
        self._channels[channel.channel_id] = channel

    def get_channel(self, channel_id: str) -> Optional[SubscribedChannel]:
        """Get a subscribed channel by ID."""
        return self._channels.get(channel_id)

    def get_all_channels(self) -> list[SubscribedChannel]:
        """Get all subscribed channels."""
        return list(self._channels.values())

    def delete_channel(self, channel_id: str) -> None:
        """Remove a channel subscription."""
        self._channels.pop(channel_id, None)

    def save_chunk(self, channel_id: str, chunk: Chunk) -> None:
        """Save a chunk for a channel."""
        channel = self._channels.get(channel_id)
        if channel:
            channel.chunks[chunk.chunk_id] = chunk

    def get_chunks_by_sequence(
        self, channel_id: str, sequence: int
    ) -> list[Chunk]:
        """Get all chunks for a given sequence number."""
        channel = self._channels.get(channel_id)
        if not channel:
            return []
        return [
            c for c in channel.chunks.values() if c.sequence == sequence
        ]

    def get_latest_sequence(self, channel_id: str) -> int:
        """Get the highest sequence number seen for a channel."""
        channel = self._channels.get(channel_id)
        if not channel or not channel.chunks:
            return 0
        return max(c.sequence for c in channel.chunks.values())
