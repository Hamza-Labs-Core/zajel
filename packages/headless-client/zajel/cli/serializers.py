"""Convert headless client dataclasses to JSON-safe dicts for CLI output.

Each serializer produces a plain dict that can be passed to json.dumps().
Private keys are intentionally excluded from serialized output.
"""

from typing import Any, Optional


def serialize_connected_peer(peer) -> dict[str, Any]:
    """Serialize a ConnectedPeer."""
    return {
        "peer_id": peer.peer_id,
        "public_key": peer.public_key,
        "display_name": peer.display_name,
        "is_initiator": peer.is_initiator,
    }


def serialize_received_message(msg) -> dict[str, Any]:
    """Serialize a ReceivedMessage."""
    return {
        "peer_id": msg.peer_id,
        "content": msg.content,
        "timestamp": msg.timestamp,
    }


def serialize_owned_channel(channel) -> dict[str, Any]:
    """Serialize an OwnedChannel (excludes private keys)."""
    return {
        "channel_id": channel.channel_id,
        "name": channel.manifest.name,
        "description": channel.manifest.description,
        "sequence": channel.sequence,
    }


def serialize_subscribed_channel(channel) -> dict[str, Any]:
    """Serialize a SubscribedChannel."""
    return {
        "channel_id": channel.channel_id,
        "name": channel.manifest.name,
        "description": channel.manifest.description,
        "subscribed_at": channel.subscribed_at.isoformat(),
    }


def serialize_channel_content(channel_id: str, payload) -> dict[str, Any]:
    """Serialize a (channel_id, ChunkPayload) tuple."""
    import base64
    return {
        "channel_id": channel_id,
        "content_type": payload.content_type,
        "payload": payload.payload.decode("utf-8", errors="replace"),
        "metadata": payload.metadata,
        "reply_to": payload.reply_to,
        "author": payload.author,
        "timestamp": payload.timestamp.isoformat(),
    }


def serialize_group(group) -> dict[str, Any]:
    """Serialize a Group."""
    return {
        "id": group.id,
        "name": group.name,
        "member_count": group.member_count,
        "members": [serialize_group_member(m) for m in group.members],
        "created_at": group.created_at.isoformat(),
        "created_by": group.created_by,
    }


def serialize_group_member(member) -> dict[str, Any]:
    """Serialize a GroupMember."""
    return {
        "device_id": member.device_id,
        "display_name": member.display_name,
        "public_key": member.public_key,
        "joined_at": member.joined_at.isoformat(),
    }


def serialize_group_message(msg) -> dict[str, Any]:
    """Serialize a GroupMessage."""
    return {
        "id": msg.id,
        "group_id": msg.group_id,
        "author_device_id": msg.author_device_id,
        "content": msg.content,
        "message_type": msg.message_type,
        "timestamp": msg.timestamp.isoformat(),
        "is_outgoing": msg.is_outgoing,
    }


def serialize_file_transfer(progress) -> dict[str, Any]:
    """Serialize a FileTransferProgress."""
    return {
        "file_id": progress.file_id,
        "file_name": progress.file_name,
        "total_size": progress.total_size,
        "received_chunks": progress.received_chunks,
        "total_chunks": progress.total_chunks,
        "bytes_received": progress.bytes_received,
        "completed": progress.completed,
        "file_path": progress.file_path,
        "sha256": progress.sha256,
    }


def serialize_stored_peer(peer) -> dict[str, Any]:
    """Serialize a StoredPeer."""
    return {
        "peer_id": peer.peer_id,
        "display_name": peer.display_name,
        "public_key": peer.public_key,
        "is_blocked": peer.is_blocked,
        "trusted_at": peer.trusted_at.isoformat() if peer.trusted_at else None,
        "last_seen": peer.last_seen.isoformat() if peer.last_seen else None,
        "alias": peer.alias,
    }
