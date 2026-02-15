"""Dead drop support for the headless client.

Handles:
- Dead drop model (matching the Dart app's DeadDrop/LiveMatch/RendezvousResult)
- Dead drop encryption/decryption using session keys
- Connection info model (matching Dart app's ConnectionInfo)

Dead drops allow peers to leave encrypted connection information at
meeting points when the other peer is offline. When the peer comes
online, it checks meeting points and finds dead drops left by others.
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from .crypto import CryptoService

logger = logging.getLogger("zajel.dead_drop")


# ── Models ──────────────────────────────────────────────────────


@dataclass
class ConnectionInfo:
    """Connection information stored in a dead drop.

    Matches the Dart app's ConnectionInfo JSON format with keys:
    pubkey, relay, sourceId, ip, port, fallbackRelays, timestamp.
    """

    public_key: str
    relay_id: Optional[str] = None
    source_id: Optional[str] = None
    ip: Optional[str] = None
    port: Optional[int] = None
    fallback_relays: list[str] = field(default_factory=list)
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Serialize to dict matching Dart ConnectionInfo.toJson()."""
        d: dict[str, Any] = {"pubkey": self.public_key}
        if self.relay_id is not None:
            d["relay"] = self.relay_id
        if self.source_id is not None:
            d["sourceId"] = self.source_id
        if self.ip is not None:
            d["ip"] = self.ip
        if self.port is not None:
            d["port"] = self.port
        d["fallbackRelays"] = self.fallback_relays
        d["timestamp"] = self.timestamp.isoformat()
        return d

    def to_json(self) -> str:
        """Serialize to JSON string."""
        return json.dumps(self.to_dict())

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "ConnectionInfo":
        """Deserialize from dict matching Dart ConnectionInfo.fromJson()."""
        return ConnectionInfo(
            public_key=data["pubkey"],
            relay_id=data.get("relay"),
            source_id=data.get("sourceId"),
            ip=data.get("ip"),
            port=data.get("port"),
            fallback_relays=data.get("fallbackRelays", []),
            timestamp=datetime.fromisoformat(data["timestamp"]),
        )

    @staticmethod
    def from_json(json_str: str) -> "ConnectionInfo":
        """Deserialize from JSON string."""
        return ConnectionInfo.from_dict(json.loads(json_str))


@dataclass
class DeadDrop:
    """An encrypted dead drop received from the signaling server.

    Matches the Dart app's DeadDrop model.
    """

    encrypted_payload: str
    relay_id: str
    meeting_point: str
    peer_id: Optional[str] = None
    retrieved_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "peerId": self.peer_id,
            "encryptedPayload": self.encrypted_payload,
            "relayId": self.relay_id,
            "meetingPoint": self.meeting_point,
            "retrievedAt": self.retrieved_at.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "DeadDrop":
        return DeadDrop(
            peer_id=data.get("peerId"),
            encrypted_payload=data["encryptedPayload"],
            relay_id=data["relayId"],
            meeting_point=data["meetingPoint"],
            retrieved_at=(
                datetime.fromisoformat(data["retrievedAt"])
                if data.get("retrievedAt")
                else datetime.now(timezone.utc)
            ),
        )


@dataclass
class LiveMatch:
    """A live match notification from the signaling server.

    Matches the Dart app's LiveMatch model.
    """

    relay_id: str
    meeting_point: str
    peer_id: Optional[str] = None
    connection_hints: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "peerId": self.peer_id,
            "relayId": self.relay_id,
            "meetingPoint": self.meeting_point,
            "connectionHints": self.connection_hints,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "LiveMatch":
        return LiveMatch(
            peer_id=data.get("peerId"),
            relay_id=data["relayId"],
            meeting_point=data["meetingPoint"],
            connection_hints=data.get("connectionHints"),
        )


@dataclass
class RendezvousResult:
    """Result of a rendezvous registration.

    Matches the Dart app's RendezvousResult model.
    """

    live_matches: list[LiveMatch] = field(default_factory=list)
    dead_drops: list[DeadDrop] = field(default_factory=list)
    success: bool = True
    error: Optional[str] = None

    @property
    def has_matches(self) -> bool:
        return bool(self.live_matches) or bool(self.dead_drops)

    @property
    def total_matches(self) -> int:
        return len(self.live_matches) + len(self.dead_drops)

    def to_dict(self) -> dict[str, Any]:
        return {
            "liveMatches": [m.to_dict() for m in self.live_matches],
            "deadDrops": [d.to_dict() for d in self.dead_drops],
            "success": self.success,
            "error": self.error,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> "RendezvousResult":
        return RendezvousResult(
            live_matches=[
                LiveMatch.from_dict(m)
                for m in data.get("liveMatches", [])
            ],
            dead_drops=[
                DeadDrop.from_dict(d)
                for d in data.get("deadDrops", [])
            ],
            success=data.get("success", True),
            error=data.get("error"),
        )


# ── Dead Drop Encryption / Decryption ──────────────────────────


def create_dead_drop(
    crypto: CryptoService,
    peer_id: str,
    connection_info: ConnectionInfo,
) -> str:
    """Encrypt connection info as a dead drop payload.

    Uses the session key shared with peer_id to encrypt the
    connection info JSON, matching the Dart app's createDeadDrop().

    Args:
        crypto: The CryptoService with an active session for peer_id.
        peer_id: The peer who will decrypt this dead drop.
        connection_info: Our connection info to encrypt.

    Returns:
        Base64-encoded encrypted payload (nonce || ciphertext || mac).

    Raises:
        RuntimeError: If no session key exists for peer_id.
    """
    plaintext = connection_info.to_json()
    return crypto.encrypt(peer_id, plaintext)


def decrypt_dead_drop(
    crypto: CryptoService,
    peer_id: str,
    encrypted_payload: str,
) -> ConnectionInfo:
    """Decrypt a dead drop payload from a peer.

    Uses the session key shared with peer_id to decrypt the
    encrypted payload and parse it as ConnectionInfo.

    Args:
        crypto: The CryptoService with an active session for peer_id.
        peer_id: The peer who encrypted this dead drop.
        encrypted_payload: Base64-encoded encrypted payload.

    Returns:
        The decrypted ConnectionInfo.

    Raises:
        RuntimeError: If no session key exists for peer_id.
        DeadDropDecryptionError: If decryption or parsing fails.
    """
    try:
        plaintext = crypto.decrypt(peer_id, encrypted_payload)
        return ConnectionInfo.from_json(plaintext)
    except RuntimeError:
        raise
    except Exception as e:
        raise DeadDropDecryptionError(
            f"Failed to decrypt dead drop from {peer_id}: {e}"
        ) from e


class DeadDropDecryptionError(Exception):
    """Raised when dead drop decryption fails."""

    pass
