"""Channel and invite link support for the headless client.

Handles:
- Creating channels (Ed25519 signing keypair + X25519 encryption keypair)
- Encoding/decoding zajel:// invite links (manifest + decryption key)
- Channel manifest model (matching the Dart app's ChannelManifest)
- Chunk model (matching the Dart app's Chunk)
- Channel subscription storage (in-memory)
- Chunk payload encryption/decryption (HKDF + ChaCha20-Poly1305)
- Ed25519 signature creation and verification for manifests and chunks
- Chunk creation: encrypt, split, sign for publishing

Channels use VPS relays (not direct P2P). The headless client stores
subscribed channels locally and can listen for incoming chunks.
"""

import base64
import hashlib
import hmac
import json
import logging
import math
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

logger = logging.getLogger("zajel.channels")

# Constants matching the Dart app
NONCE_SIZE = 12
MAC_SIZE = 16
CHANNEL_LINK_PREFIX = "zajel://channel/"
CHUNK_SIZE = 64 * 1024  # 64 KB — must match Dart app's ChannelService.chunkSize
MAX_CHUNKS_PER_CHANNEL = 1000


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
    allowed_types: list[str] = field(default_factory=lambda: ["text"])

    def to_dict(self) -> dict[str, Any]:
        # Key order must match Dart's ChannelRules.toJson() exactly
        return {
            "replies_enabled": self.replies_enabled,
            "polls_enabled": self.polls_enabled,
            "max_upstream_size": self.max_upstream_size,
            "allowed_types": self.allowed_types,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ChannelRules":
        return ChannelRules(
            replies_enabled=data.get("replies_enabled", True),
            polls_enabled=data.get("polls_enabled", True),
            max_upstream_size=data.get("max_upstream_size", 4096),
            allowed_types=data.get("allowed_types", ["text"]),
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


@dataclass
class OwnedChannel:
    """A channel owned by the headless client."""

    channel_id: str
    manifest: ChannelManifest
    signing_key_private: str  # Ed25519 private key seed, base64
    encryption_key_private: str  # X25519 private key, base64
    encryption_key_public: str  # X25519 public key, base64
    sequence: int = 0  # Latest published sequence number
    chunks: dict[str, Chunk] = field(default_factory=dict)


# ── Upstream Message Models ────────────────────────────────────


class UpstreamMessageType(Enum):
    """Types of upstream messages that subscribers can send to the channel owner.

    Matches the Dart app's UpstreamMessageType enum.
    """

    reply = "reply"
    vote = "vote"
    reaction = "reaction"


@dataclass
class UpstreamPayload:
    """The decrypted content of an upstream message, visible only to the owner.

    Matches the Dart app's UpstreamPayload class.
    """

    type: UpstreamMessageType
    content: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    reply_to: Optional[str] = None
    poll_id: Optional[str] = None
    vote_option_index: Optional[int] = None

    def to_bytes(self) -> bytes:
        """Serialize to bytes for encryption (matches Dart UpstreamPayload.toBytes)."""
        data: dict[str, Any] = {
            "type": self.type.value,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
        }
        if self.reply_to is not None:
            data["reply_to"] = self.reply_to
        if self.poll_id is not None:
            data["poll_id"] = self.poll_id
        if self.vote_option_index is not None:
            data["vote_option_index"] = self.vote_option_index
        return json.dumps(data, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def from_bytes(raw: bytes) -> "UpstreamPayload":
        """Deserialize from decrypted bytes."""
        data = json.loads(raw.decode("utf-8"))
        type_str = data.get("type", "reply")
        try:
            msg_type = UpstreamMessageType(type_str)
        except ValueError:
            msg_type = UpstreamMessageType.reply

        return UpstreamPayload(
            type=msg_type,
            content=data.get("content", ""),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            reply_to=data.get("reply_to"),
            poll_id=data.get("poll_id"),
            vote_option_index=data.get("vote_option_index"),
        )


@dataclass
class UpstreamMessage:
    """An upstream message from a subscriber to the channel owner.

    Matches the Dart app's UpstreamMessage class.
    """

    id: str
    channel_id: str
    type: UpstreamMessageType
    encrypted_payload: bytes
    signature: str  # Ed25519 signature, base64
    sender_ephemeral_key: str  # Ed25519 public key, base64
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "channel_id": self.channel_id,
            "type": self.type.value,
            "encrypted_payload": base64.b64encode(self.encrypted_payload).decode(),
            "signature": self.signature,
            "sender_ephemeral_key": self.sender_ephemeral_key,
            "timestamp": self.timestamp.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "UpstreamMessage":
        type_str = data.get("type", "reply")
        try:
            msg_type = UpstreamMessageType(type_str)
        except ValueError:
            msg_type = UpstreamMessageType.reply

        return UpstreamMessage(
            id=data["id"],
            channel_id=data["channel_id"],
            type=msg_type,
            encrypted_payload=base64.b64decode(data["encrypted_payload"]),
            signature=data["signature"],
            sender_ephemeral_key=data["sender_ephemeral_key"],
            timestamp=datetime.fromisoformat(data["timestamp"]),
        )


# ── Poll Models ────────────────────────────────────────────────


@dataclass
class PollOption:
    """A poll option with its label.

    Matches the Dart app's PollOption class.
    """

    index: int
    label: str

    def to_dict(self) -> dict[str, Any]:
        return {"index": self.index, "label": self.label}

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "PollOption":
        return PollOption(index=data["index"], label=data["label"])


@dataclass
class Poll:
    """A poll definition -- created by the owner and broadcast as a chunk.

    Matches the Dart app's Poll class.
    """

    poll_id: str
    question: str
    options: list[PollOption]
    allow_multiple: bool = False
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    closes_at: Optional[datetime] = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "poll_id": self.poll_id,
            "question": self.question,
            "options": [o.to_dict() for o in self.options],
            "allow_multiple": self.allow_multiple,
            "created_at": self.created_at.isoformat(),
        }
        if self.closes_at is not None:
            data["closes_at"] = self.closes_at.isoformat()
        return data

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Poll":
        return Poll(
            poll_id=data["poll_id"],
            question=data["question"],
            options=[PollOption.from_dict(o) for o in data["options"]],
            allow_multiple=data.get("allow_multiple", False),
            created_at=datetime.fromisoformat(data["created_at"]),
            closes_at=datetime.fromisoformat(data["closes_at"])
            if data.get("closes_at")
            else None,
        )


@dataclass
class PollResults:
    """Aggregated poll results -- broadcast by the owner.

    Matches the Dart app's PollResults class.
    """

    poll_id: str
    vote_counts: dict[int, int]
    total_votes: int
    is_final: bool = False
    tallied_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "poll_id": self.poll_id,
            "vote_counts": {str(k): v for k, v in self.vote_counts.items()},
            "total_votes": self.total_votes,
            "is_final": self.is_final,
            "tallied_at": self.tallied_at.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "PollResults":
        raw_counts = data["vote_counts"]
        return PollResults(
            poll_id=data["poll_id"],
            vote_counts={int(k): v for k, v in raw_counts.items()},
            total_votes=data["total_votes"],
            is_final=data.get("is_final", False),
            tallied_at=datetime.fromisoformat(data["tallied_at"]),
        )


# ── Invite Link Encode/Decode ──────────────────────────────────


def encode_channel_link(manifest: ChannelManifest, encryption_key_private: str) -> str:
    """Encode a channel invite link from manifest + decryption key.

    WARNING: The invite link contains the channel decryption key.
    Anyone with this link can decrypt all channel content. Treat
    it as a secret credential and share only through secure channels.

    Format: zajel://channel/<base64url-encoded-json>
    Matches the Dart app's ChannelLinkService.encode().
    """
    payload = {
        "m": manifest.to_dict(),
        "k": encryption_key_private,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "version": 1,
    }
    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    encoded = base64.urlsafe_b64encode(json_bytes).decode().rstrip("=")
    return f"{CHANNEL_LINK_PREFIX}{encoded}"


def decode_channel_link(link: str) -> tuple[ChannelManifest, str]:
    """Decode a zajel://channel/<base64url> invite link.

    Returns:
        (manifest, encryption_key) tuple.

    Raises:
        ValueError: If the link format is invalid.
    """
    trimmed = link.strip()

    if not trimmed.startswith(CHANNEL_LINK_PREFIX):
        raise ValueError(
            f"Invalid channel link: must start with '{CHANNEL_LINK_PREFIX}'"
        )
    encoded = trimmed[len(CHANNEL_LINK_PREFIX):]

    # Restore base64url padding
    pad_len = (4 - len(encoded) % 4) % 4
    padded = encoded + "=" * pad_len

    try:
        json_bytes = base64.urlsafe_b64decode(padded)
        payload = json.loads(json_bytes.decode("utf-8"))
    except Exception as e:
        raise ValueError(f"Invalid channel link: {e}") from e

    # Check for expiration if present (issue-headless-08)
    expires_at = payload.get("expires_at")
    if expires_at:
        exp = datetime.fromisoformat(expires_at)
        if datetime.now(timezone.utc) > exp:
            raise ValueError("Channel invite link has expired")

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
    - Ed25519 keypair generation, signing, and verification
    - X25519 keypair generation for content encryption
    - Channel ID derivation (SHA-256 of owner public key)
    - HKDF-derived content key derivation
    - ChaCha20-Poly1305 encryption/decryption of chunk payloads
    - Chunk creation: encrypt, split, sign
    - Routing hash derivation (HMAC-SHA256)
    """

    # ── Key Generation ──────────────────────────────────────────

    @staticmethod
    def generate_signing_keypair() -> tuple[str, str]:
        """Generate an Ed25519 signing keypair.

        Returns:
            (public_key_b64, private_key_seed_b64) tuple.
        """
        private_key = Ed25519PrivateKey.generate()
        seed = private_key.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        )
        public_bytes = private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        return base64.b64encode(public_bytes).decode(), base64.b64encode(seed).decode()

    @staticmethod
    def generate_encryption_keypair() -> tuple[str, str]:
        """Generate an X25519 keypair for content encryption.

        Returns:
            (public_key_b64, private_key_b64) tuple.
        """
        private_key = X25519PrivateKey.generate()
        private_bytes = private_key.private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption()
        )
        public_bytes = private_key.public_key().public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        return base64.b64encode(public_bytes).decode(), base64.b64encode(private_bytes).decode()

    @staticmethod
    def derive_channel_id(public_key_b64: str) -> str:
        """Derive a channel ID from an Ed25519 public key.

        SHA-256 of the public key bytes, truncated to 16 bytes, hex-encoded.
        Matches the Dart app's deriveChannelId().
        """
        public_key_bytes = base64.b64decode(public_key_b64)
        digest = hashlib.sha256(public_key_bytes).digest()
        return digest[:16].hex()

    # ── Manifest Signing ────────────────────────────────────────

    @staticmethod
    def sign_manifest(
        manifest: ChannelManifest, private_key_seed_b64: str
    ) -> ChannelManifest:
        """Sign a manifest with the owner's Ed25519 private key.

        Returns a new manifest with the signature field populated.
        """
        signable = manifest.to_signable_json()
        signable_bytes = signable.encode("utf-8")

        seed = base64.b64decode(private_key_seed_b64)
        private_key = Ed25519PrivateKey.from_private_bytes(seed)
        signature = private_key.sign(signable_bytes)

        manifest.signature = base64.b64encode(signature).decode()
        return manifest

    # ── Chunk Signing ───────────────────────────────────────────

    @staticmethod
    def sign_chunk(
        encrypted_payload: bytes, private_key_seed_b64: str
    ) -> str:
        """Sign a chunk's encrypted payload with Ed25519.

        Returns the base64-encoded signature.
        """
        seed = base64.b64decode(private_key_seed_b64)
        private_key = Ed25519PrivateKey.from_private_bytes(seed)
        signature = private_key.sign(encrypted_payload)
        return base64.b64encode(signature).decode()

    # ── Chunk Creation ──────────────────────────────────────────

    @staticmethod
    def create_chunks(
        payload: ChunkPayload,
        encryption_key_private_b64: str,
        signing_key_private_b64: str,
        owner_public_key_b64: str,
        key_epoch: int,
        sequence: int,
        routing_hash: str,
    ) -> list[Chunk]:
        """Encrypt a payload, split into chunks, and sign each one.

        Matches the Dart app's ChannelService.splitIntoChunks().
        """
        encrypted_bytes = ChannelCryptoService.encrypt_payload(
            payload, encryption_key_private_b64, key_epoch
        )

        total_chunks = max(1, math.ceil(len(encrypted_bytes) / CHUNK_SIZE))
        chunks = []

        for i in range(total_chunks):
            start = i * CHUNK_SIZE
            end = min(start + CHUNK_SIZE, len(encrypted_bytes))
            chunk_data = encrypted_bytes[start:end]

            signature = ChannelCryptoService.sign_chunk(
                chunk_data, signing_key_private_b64
            )

            short_id = uuid.uuid4().hex[:16]
            chunk_id = f"ch_{short_id}_{i:03d}"

            chunks.append(Chunk(
                chunk_id=chunk_id,
                routing_hash=routing_hash,
                sequence=sequence,
                chunk_index=i,
                total_chunks=total_chunks,
                size=len(chunk_data),
                signature=signature,
                author_pubkey=owner_public_key_b64,
                encrypted_payload=chunk_data,
            ))

        return chunks

    # ── Routing Hash ────────────────────────────────────────────

    @staticmethod
    def derive_routing_hash(channel_secret_b64: str) -> str:
        """Derive a routing hash for the current hourly epoch.

        HMAC-SHA256(channel_secret, "epoch:hourly:<epoch>"), truncated to 16 bytes.
        Matches the Dart app's RoutingHashService.
        """
        secret_bytes = base64.b64decode(channel_secret_b64)
        epoch_ms = int(time.time() * 1000)
        hourly_epoch = epoch_ms // 3_600_000
        message = f"epoch:hourly:{hourly_epoch}".encode("utf-8")

        mac = hmac.new(secret_bytes, message, hashlib.sha256).digest()
        return mac[:16].hex()

    # ── Verification ────────────────────────────────────────────

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

    # ── Admin Management ───────────────────────────────────────

    @staticmethod
    def appoint_admin(
        channel: "OwnedChannel",
        admin_public_key: str,
        admin_label: str,
    ) -> "OwnedChannel":
        """Appoint a new admin by adding their Ed25519 public key to the manifest.

        Only the channel owner can appoint admins. Returns the updated channel
        with a re-signed manifest.

        Matches the Dart app's AdminManagementService.appointAdmin().

        Raises:
            ValueError: If the admin key is the owner key or already appointed.
        """
        manifest = channel.manifest

        if admin_public_key == manifest.owner_key:
            raise ValueError("Cannot appoint the owner as an admin")

        if any(a.key == admin_public_key for a in manifest.admin_keys):
            raise ValueError("Admin with this public key is already appointed")

        updated_admins = list(manifest.admin_keys) + [
            AdminKey(key=admin_public_key, label=admin_label)
        ]

        manifest.admin_keys = updated_admins
        manifest.signature = ""
        ChannelCryptoService.sign_manifest(manifest, channel.signing_key_private)
        return channel

    @staticmethod
    def remove_admin(
        channel: "OwnedChannel",
        admin_public_key: str,
    ) -> "OwnedChannel":
        """Remove an admin and rotate the encryption key.

        When an admin is removed, the encryption key is rotated so the removed
        admin cannot decrypt future content.

        Matches the Dart app's AdminManagementService.removeAdmin().

        Raises:
            ValueError: If the admin key is not in the manifest.
        """
        manifest = channel.manifest

        if not any(a.key == admin_public_key for a in manifest.admin_keys):
            raise ValueError("Admin with this public key is not in the manifest")

        # Remove the admin
        manifest.admin_keys = [
            a for a in manifest.admin_keys if a.key != admin_public_key
        ]

        # Rotate encryption key so the removed admin cannot decrypt new content
        enc_pub, enc_priv = ChannelCryptoService.generate_encryption_keypair()
        manifest.current_encrypt_key = enc_pub
        manifest.key_epoch += 1
        manifest.signature = ""

        ChannelCryptoService.sign_manifest(manifest, channel.signing_key_private)

        channel.encryption_key_private = enc_priv
        channel.encryption_key_public = enc_pub
        return channel

    @staticmethod
    def is_authorized_admin(manifest: ChannelManifest, public_key: str) -> bool:
        """Check if a given public key belongs to an authorized admin."""
        return any(a.key == public_key for a in manifest.admin_keys)

    @staticmethod
    def is_authorized_publisher(manifest: ChannelManifest, public_key: str) -> bool:
        """Check if a key is authorized to publish (owner or admin)."""
        return (
            public_key == manifest.owner_key
            or ChannelCryptoService.is_authorized_admin(manifest, public_key)
        )

    # ── Key Epoch Rotation ─────────────────────────────────────

    @staticmethod
    def rotate_encryption_key(channel: "OwnedChannel") -> "OwnedChannel":
        """Rotate the channel encryption key.

        Generates a new X25519 encryption keypair, increments the key epoch,
        and re-signs the manifest. Previous key holders cannot decrypt
        content encrypted with the new key.

        Matches the Dart app's AdminManagementService.rotateEncryptionKeyForRemoval().
        """
        enc_pub, enc_priv = ChannelCryptoService.generate_encryption_keypair()

        channel.manifest.current_encrypt_key = enc_pub
        channel.manifest.key_epoch += 1
        channel.manifest.signature = ""

        ChannelCryptoService.sign_manifest(
            channel.manifest, channel.signing_key_private
        )

        channel.encryption_key_private = enc_priv
        channel.encryption_key_public = enc_pub
        return channel

    # ── Upstream Message Encryption/Decryption ─────────────────

    @staticmethod
    def encrypt_upstream(
        payload: "UpstreamPayload",
        owner_encrypt_pub_b64: str,
        channel_id: str,
        msg_type: "UpstreamMessageType",
    ) -> "UpstreamMessage":
        """Encrypt an upstream payload for the channel owner.

        Uses X25519 ephemeral key exchange + HKDF + ChaCha20-Poly1305.
        Signs with an ephemeral Ed25519 key.

        Matches the Dart app's UpstreamService._sendUpstream().
        """
        from cryptography.hazmat.primitives.asymmetric.x25519 import (
            X25519PrivateKey as X25519Priv,
        )

        payload_bytes = payload.to_bytes()

        # Generate ephemeral X25519 keypair for this message
        ephemeral_x25519 = X25519Priv.generate()
        ephemeral_x25519_pub = ephemeral_x25519.public_key()

        # Derive shared secret with the owner's encryption public key
        from cryptography.hazmat.primitives.asymmetric.x25519 import (
            X25519PublicKey as X25519Pub,
        )

        owner_pub_bytes = base64.b64decode(owner_encrypt_pub_b64)
        owner_pub_key = X25519Pub.from_public_bytes(owner_pub_bytes)
        shared_secret = ephemeral_x25519.exchange(owner_pub_key)

        # Derive encryption key using HKDF
        content_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=None,
            info=b"zajel_upstream_message",
        ).derive(shared_secret)

        # Encrypt the payload with ChaCha20-Poly1305
        nonce = os.urandom(NONCE_SIZE)
        aead = ChaCha20Poly1305(content_key)
        ciphertext_with_mac = aead.encrypt(nonce, payload_bytes, None)

        # Combine: nonce (12) + ciphertext + mac (16)
        encrypted_bytes = nonce + ciphertext_with_mac

        # Generate ephemeral Ed25519 key for signing
        signing_key = Ed25519PrivateKey.generate()
        signing_pub = signing_key.public_key()
        signature = signing_key.sign(encrypted_bytes)

        message_id = f"up_{uuid.uuid4().hex[:8]}"

        # Store the ephemeral X25519 public key in the message for the owner
        ephemeral_x25519_pub_bytes = ephemeral_x25519_pub.public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )

        msg = UpstreamMessage(
            id=message_id,
            channel_id=channel_id,
            type=msg_type,
            encrypted_payload=encrypted_bytes,
            signature=base64.b64encode(signature).decode(),
            sender_ephemeral_key=base64.b64encode(
                signing_pub.public_bytes(Encoding.Raw, PublicFormat.Raw)
            ).decode(),
            timestamp=datetime.now(timezone.utc),
        )

        # Attach the X25519 ephemeral public key as extra data for the WS envelope
        msg._ephemeral_x25519_pub_b64 = base64.b64encode(  # type: ignore[attr-defined]
            ephemeral_x25519_pub_bytes
        ).decode()

        return msg

    @staticmethod
    def decrypt_upstream(
        message: "UpstreamMessage",
        encryption_private_key_b64: str,
        ephemeral_x25519_pub_b64: str,
    ) -> "UpstreamPayload":
        """Decrypt an upstream message as the channel owner.

        Matches the Dart app's UpstreamService.decryptUpstreamMessage().
        """
        from cryptography.hazmat.primitives.asymmetric.x25519 import (
            X25519PrivateKey as X25519Priv,
            X25519PublicKey as X25519Pub,
        )

        # Verify the Ed25519 signature
        try:
            sig_bytes = base64.b64decode(message.signature)
            sender_pub_bytes = base64.b64decode(message.sender_ephemeral_key)
            sender_pub = Ed25519PublicKey.from_public_bytes(sender_pub_bytes)
            sender_pub.verify(sig_bytes, message.encrypted_payload)
        except Exception as e:
            raise ValueError(f"Upstream message signature invalid: {e}") from e

        # Reconstruct the shared secret
        owner_priv_bytes = base64.b64decode(encryption_private_key_b64)
        owner_priv = X25519Priv.from_private_bytes(owner_priv_bytes)

        eph_pub_bytes = base64.b64decode(ephemeral_x25519_pub_b64)
        eph_pub = X25519Pub.from_public_bytes(eph_pub_bytes)

        shared_secret = owner_priv.exchange(eph_pub)

        # Derive the same encryption key
        content_key = HKDF(
            algorithm=SHA256(),
            length=32,
            salt=None,
            info=b"zajel_upstream_message",
        ).derive(shared_secret)

        # Decrypt
        encrypted = message.encrypted_payload
        if len(encrypted) < NONCE_SIZE + MAC_SIZE:
            raise ValueError("Encrypted upstream payload too short")

        nonce = encrypted[:NONCE_SIZE]
        ciphertext_with_mac = encrypted[NONCE_SIZE:]

        aead = ChaCha20Poly1305(content_key)
        try:
            plaintext = aead.decrypt(nonce, ciphertext_with_mac, None)
        except Exception as e:
            raise ValueError(
                f"Failed to decrypt upstream message: {e}"
            ) from e

        return UpstreamPayload.from_bytes(plaintext)

    # ── Poll Helpers ───────────────────────────────────────────

    @staticmethod
    def create_poll_chunks(
        poll: "Poll",
        channel: "OwnedChannel",
        sequence: int,
        routing_hash: str,
    ) -> list["Chunk"]:
        """Create encrypted chunks for a poll broadcast.

        Matches the Dart app's PollService.createPoll().
        """
        poll_json = json.dumps(poll.to_dict(), separators=(",", ":"))
        payload = ChunkPayload(
            content_type="poll",
            payload=poll_json.encode("utf-8"),
            metadata={"poll_id": poll.poll_id},
        )

        return ChannelCryptoService.create_chunks(
            payload=payload,
            encryption_key_private_b64=channel.encryption_key_private,
            signing_key_private_b64=channel.signing_key_private,
            owner_public_key_b64=channel.manifest.owner_key,
            key_epoch=channel.manifest.key_epoch,
            sequence=sequence,
            routing_hash=routing_hash,
        )

    @staticmethod
    def create_poll_results_chunks(
        results: "PollResults",
        poll: "Poll",
        channel: "OwnedChannel",
        sequence: int,
        routing_hash: str,
        is_final: bool = False,
    ) -> list["Chunk"]:
        """Create encrypted chunks for poll results broadcast.

        Matches the Dart app's PollService.tallyAndBroadcast().
        """
        results_json = json.dumps(results.to_dict(), separators=(",", ":"))
        payload = ChunkPayload(
            content_type="poll",
            payload=results_json.encode("utf-8"),
            metadata={
                "poll_id": poll.poll_id,
                "is_results": True,
                "is_final": is_final,
            },
        )

        return ChannelCryptoService.create_chunks(
            payload=payload,
            encryption_key_private_b64=channel.encryption_key_private,
            signing_key_private_b64=channel.signing_key_private,
            owner_public_key_b64=channel.manifest.owner_key,
            key_epoch=channel.manifest.key_epoch,
            sequence=sequence,
            routing_hash=routing_hash,
        )


# ── Poll Vote Tracking ─────────────────────────────────────────


class PollTracker:
    """In-memory vote tracking for polls (owner-side only).

    Matches the Dart app's PollService vote tracking.
    """

    def __init__(self):
        self._votes_by_poll: dict[str, dict[str, int]] = {}

    def init_poll(self, poll_id: str) -> None:
        """Initialize vote tracking for a poll."""
        self._votes_by_poll[poll_id] = {}

    def record_vote(
        self, poll_id: str, option_index: int, sender_key: str
    ) -> bool:
        """Record a vote. Returns True if recorded (False if duplicate)."""
        votes = self._votes_by_poll.get(poll_id)
        if votes is None:
            return False
        if sender_key in votes:
            return False
        votes[sender_key] = option_index
        return True

    def tally(self, poll: "Poll") -> "PollResults":
        """Tally votes for a poll and return results."""
        votes = self._votes_by_poll.get(poll.poll_id, {})

        vote_counts: dict[int, int] = {}
        for option in poll.options:
            vote_counts[option.index] = 0
        for option_index in votes.values():
            vote_counts[option_index] = vote_counts.get(option_index, 0) + 1

        return PollResults(
            poll_id=poll.poll_id,
            vote_counts=vote_counts,
            total_votes=len(votes),
        )

    def get_vote_count(self, poll_id: str) -> int:
        """Get current vote count for a poll."""
        votes = self._votes_by_poll.get(poll_id)
        return len(votes) if votes else 0

    def clear_votes(self, poll_id: str) -> None:
        """Clear vote data for a poll."""
        self._votes_by_poll.pop(poll_id, None)


# ── Channel Storage (in-memory) ─────────────────────────────────


class ChannelStorage:
    """In-memory storage for subscribed and owned channels."""

    def __init__(self):
        self._channels: dict[str, SubscribedChannel] = {}
        self._owned: dict[str, OwnedChannel] = {}

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
        """Save a chunk for a channel, evicting oldest if over limit."""
        channel = self._channels.get(channel_id)
        if channel:
            channel.chunks[chunk.chunk_id] = chunk
            # Evict oldest chunks if over limit
            if len(channel.chunks) > MAX_CHUNKS_PER_CHANNEL:
                sorted_ids = sorted(
                    channel.chunks.keys(),
                    key=lambda cid: channel.chunks[cid].sequence,
                )
                excess = len(channel.chunks) - MAX_CHUNKS_PER_CHANNEL
                for old_id in sorted_ids[:excess]:
                    del channel.chunks[old_id]

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

    # ── Owned channel methods ───────────────────────────────

    def save_owned(self, channel: OwnedChannel) -> None:
        """Save or update an owned channel."""
        self._owned[channel.channel_id] = channel

    def get_owned(self, channel_id: str) -> Optional[OwnedChannel]:
        """Get an owned channel by ID."""
        return self._owned.get(channel_id)

    def get_all_owned(self) -> list[OwnedChannel]:
        """Get all owned channels."""
        return list(self._owned.values())
