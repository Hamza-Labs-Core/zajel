"""Group support for the headless client.

Handles:
- Group model (matching the Dart app's Group/GroupMember)
- Group message model (matching the Dart app's GroupMessage)
- Sender key-based encryption (ChaCha20-Poly1305)
- Group storage (in-memory)

Groups use full-mesh P2P (WebRTC data channels). Each member has a
sender key that all other members hold. Messages are encrypted once
and broadcast to all connected peers.
"""

import base64
import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

logger = logging.getLogger("zajel.groups")

NONCE_SIZE = 12
MAC_SIZE = 16
SENDER_KEY_SIZE = 32
MAX_GROUP_MEMBERS = 15
MAX_MESSAGES_PER_GROUP = 5000


# ── Models ──────────────────────────────────────────────────────


@dataclass
class GroupMember:
    """A member of a group."""

    device_id: str
    display_name: str
    public_key: str  # X25519 public key, base64
    joined_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "display_name": self.display_name,
            "public_key": self.public_key,
            "joined_at": self.joined_at.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "GroupMember":
        return GroupMember(
            device_id=data["device_id"],
            display_name=data["display_name"],
            public_key=data["public_key"],
            joined_at=datetime.fromisoformat(data["joined_at"]),
        )


@dataclass
class Group:
    """A group — small, full-mesh P2P."""

    id: str
    name: str
    self_device_id: str
    members: list[GroupMember] = field(default_factory=list)
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    created_by: str = ""

    @property
    def member_count(self) -> int:
        return len(self.members)

    @property
    def other_members(self) -> list[GroupMember]:
        return [m for m in self.members if m.device_id != self.self_device_id]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "self_device_id": self.self_device_id,
            "members": json.dumps([m.to_dict() for m in self.members]),
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "Group":
        members_raw = data["members"]
        if isinstance(members_raw, str):
            members_raw = json.loads(members_raw)
        return Group(
            id=data["id"],
            name=data["name"],
            self_device_id=data["self_device_id"],
            members=[GroupMember.from_dict(m) for m in members_raw],
            created_at=datetime.fromisoformat(data["created_at"]),
            created_by=data["created_by"],
        )


@dataclass
class GroupMessage:
    """A message within a group conversation."""

    group_id: str
    author_device_id: str
    sequence_number: int
    content: str
    message_type: str = "text"  # "text", "file", "image", "system"
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    is_outgoing: bool = False

    @property
    def id(self) -> str:
        return f"{self.author_device_id}:{self.sequence_number}"

    def to_bytes(self) -> bytes:
        """Serialize for encryption (matches Dart GroupMessage.toBytes)."""
        data = {
            "author_device_id": self.author_device_id,
            "sequence_number": self.sequence_number,
            "type": self.message_type,
            "content": self.content,
            "metadata": self.metadata,
            "timestamp": self.timestamp.isoformat(),
        }
        return json.dumps(data, separators=(",", ":")).encode("utf-8")

    @staticmethod
    def from_bytes(
        raw: bytes,
        group_id: str,
        is_outgoing: bool = False,
    ) -> "GroupMessage":
        """Deserialize from decrypted bytes."""
        data = json.loads(raw.decode("utf-8"))

        # Schema validation (issue-headless-30)
        required = ["author_device_id", "sequence_number", "content", "timestamp"]
        missing = [k for k in required if k not in data]
        if missing:
            raise ValueError(f"GroupMessage missing required fields: {missing}")
        if not isinstance(data["sequence_number"], int):
            raise ValueError("sequence_number must be int")

        return GroupMessage(
            group_id=group_id,
            author_device_id=data["author_device_id"],
            sequence_number=data["sequence_number"],
            message_type=data.get("type", "text"),
            content=data["content"],
            metadata=data.get("metadata", {}),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            is_outgoing=is_outgoing,
        )


# ── Group Crypto (Sender Keys) ─────────────────────────────────


class GroupCryptoService:
    """Sender key-based encryption for group messaging.

    Each member generates a symmetric sender key and distributes it
    to all other members. Messages are encrypted once with the
    sender's key and broadcast to all.
    """

    def __init__(self):
        # {group_id: {device_id: key_bytes (bytearray for zeroization)}}
        self._sender_keys: dict[str, dict[str, bytearray]] = {}

    @staticmethod
    def _zeroize(key: bytearray) -> None:
        """Overwrite key material with zeros."""
        for i in range(len(key)):
            key[i] = 0

    def generate_sender_key(self) -> str:
        """Generate a new random sender key (32 bytes, base64-encoded)."""
        key_bytes = os.urandom(SENDER_KEY_SIZE)
        return base64.b64encode(key_bytes).decode()

    def set_sender_key(
        self, group_id: str, device_id: str, sender_key_b64: str
    ) -> None:
        """Store a sender key for a member in a group."""
        key_bytes = bytearray(base64.b64decode(sender_key_b64))
        if len(key_bytes) != SENDER_KEY_SIZE:
            raise ValueError(
                f"Invalid sender key length: expected {SENDER_KEY_SIZE}, "
                f"got {len(key_bytes)}"
            )
        if group_id not in self._sender_keys:
            self._sender_keys[group_id] = {}
        self._sender_keys[group_id][device_id] = key_bytes

    def get_sender_key(
        self, group_id: str, device_id: str
    ) -> Optional[bytearray]:
        """Get a sender key for a member."""
        return self._sender_keys.get(group_id, {}).get(device_id)

    def has_sender_key(self, group_id: str, device_id: str) -> bool:
        """Check if we have a sender key for a member."""
        return device_id in self._sender_keys.get(group_id, {})

    def remove_sender_key(self, group_id: str, device_id: str) -> None:
        """Remove a member's sender key, zeroizing key material."""
        if group_id in self._sender_keys:
            key = self._sender_keys[group_id].pop(device_id, None)
            if key is not None:
                self._zeroize(key)

    def clear_group_keys(self, group_id: str) -> None:
        """Remove all sender keys for a group, zeroizing key material."""
        keys = self._sender_keys.pop(group_id, {})
        for key_bytes in keys.values():
            self._zeroize(key_bytes)

    def encrypt(
        self, plaintext: bytes, group_id: str, self_device_id: str
    ) -> bytes:
        """Encrypt a message with our sender key.

        Returns: nonce (12) + ciphertext + MAC (16).
        """
        key = self.get_sender_key(group_id, self_device_id)
        if key is None:
            raise RuntimeError(
                f"No sender key for {self_device_id} in group {group_id}"
            )

        nonce = os.urandom(NONCE_SIZE)
        aead = ChaCha20Poly1305(key)
        ciphertext = aead.encrypt(nonce, plaintext, None)
        return nonce + ciphertext

    def decrypt(
        self, encrypted: bytes, group_id: str, author_device_id: str
    ) -> bytes:
        """Decrypt a message with the author's sender key.

        Expects: nonce (12) + ciphertext + MAC (16).
        """
        if len(encrypted) < NONCE_SIZE + MAC_SIZE:
            raise ValueError("Encrypted message too short")

        key = self.get_sender_key(group_id, author_device_id)
        if key is None:
            raise RuntimeError(
                f"No sender key for {author_device_id} in group {group_id}"
            )

        nonce = encrypted[:NONCE_SIZE]
        ciphertext_with_mac = encrypted[NONCE_SIZE:]

        aead = ChaCha20Poly1305(key)
        return aead.decrypt(nonce, ciphertext_with_mac, None)


# ── Group Storage (in-memory) ──────────────────────────────────


class GroupStorage:
    """In-memory storage for groups and messages."""

    def __init__(self):
        self._groups: dict[str, Group] = {}
        self._messages: dict[str, list[GroupMessage]] = {}  # group_id -> msgs
        self._sequence_counters: dict[str, dict[str, int]] = {}  # group_id -> {device_id -> seq}
        self._seen_message_ids: dict[str, set[str]] = {}  # group_id -> set of message IDs
        self._last_seen_sequence: dict[str, dict[str, int]] = {}  # group_id -> {device_id -> last_seq}

    def save_group(self, group: Group) -> None:
        """Save or update a group."""
        self._groups[group.id] = group
        if group.id not in self._messages:
            self._messages[group.id] = []
        if group.id not in self._sequence_counters:
            self._sequence_counters[group.id] = {}
        if group.id not in self._seen_message_ids:
            self._seen_message_ids[group.id] = set()
        if group.id not in self._last_seen_sequence:
            self._last_seen_sequence[group.id] = {}

    def get_group(self, group_id: str) -> Optional[Group]:
        """Get a group by ID."""
        return self._groups.get(group_id)

    def get_all_groups(self) -> list[Group]:
        """Get all groups."""
        return list(self._groups.values())

    def delete_group(self, group_id: str) -> None:
        """Remove a group and its messages."""
        self._groups.pop(group_id, None)
        self._messages.pop(group_id, None)
        self._sequence_counters.pop(group_id, None)
        self._seen_message_ids.pop(group_id, None)
        self._last_seen_sequence.pop(group_id, None)

    def save_message(self, message: GroupMessage) -> None:
        """Save a group message, evicting oldest if over limit."""
        if message.group_id not in self._messages:
            self._messages[message.group_id] = []
        self._messages[message.group_id].append(message)
        # Evict oldest messages if over limit
        msgs = self._messages[message.group_id]
        if len(msgs) > MAX_MESSAGES_PER_GROUP:
            self._messages[message.group_id] = msgs[-MAX_MESSAGES_PER_GROUP:]
        # Maintain seen message ID set for O(1) duplicate detection
        if message.group_id not in self._seen_message_ids:
            self._seen_message_ids[message.group_id] = set()
        self._seen_message_ids[message.group_id].add(message.id)

    def get_messages(
        self, group_id: str, limit: Optional[int] = None
    ) -> list[GroupMessage]:
        """Get messages for a group, ordered by timestamp."""
        msgs = self._messages.get(group_id, [])
        sorted_msgs = sorted(msgs, key=lambda m: m.timestamp)
        if limit:
            return sorted_msgs[-limit:]
        return sorted_msgs

    def get_next_sequence(self, group_id: str, device_id: str) -> int:
        """Get the next sequence number for a device in a group."""
        if group_id not in self._sequence_counters:
            self._sequence_counters[group_id] = {}
        counter = self._sequence_counters[group_id].get(device_id, 0) + 1
        self._sequence_counters[group_id][device_id] = counter
        return counter

    def is_duplicate(self, group_id: str, message_id: str) -> bool:
        """Check if a message has already been stored (O(1) set lookup)."""
        return message_id in self._seen_message_ids.get(group_id, set())

    def validate_sequence(self, group_id: str, author_device_id: str, sequence_number: int) -> bool:
        """Validate that a sequence number is reasonable (non-negative, not excessively ahead).

        Logs a warning if sequence gaps are detected.
        Returns False if the sequence number is invalid.
        """
        if sequence_number < 0:
            return False

        last_seen = self._last_seen_sequence.get(group_id, {}).get(author_device_id, 0)

        # Allow sequence numbers that are ahead by at most a reasonable gap
        MAX_SEQ_GAP = 100
        if sequence_number > last_seen + MAX_SEQ_GAP:
            logger.warning(
                "Sequence gap too large from %s in group %s: last=%d, received=%d",
                author_device_id, group_id[:8], last_seen, sequence_number,
            )
            return False

        # Update last seen
        if group_id not in self._last_seen_sequence:
            self._last_seen_sequence[group_id] = {}
        if sequence_number > last_seen:
            self._last_seen_sequence[group_id][author_device_id] = sequence_number

        return True
