"""Main Zajel headless client orchestrator.

Provides the high-level API for interacting with the Zajel protocol:
- Connect to signaling server
- Pair with peers
- Send/receive encrypted messages
- Make/receive voice/video calls
- Transfer files
- Subscribe to channels and receive content
- Create/join groups and send/receive group messages
- Hook into events
"""

import asyncio
import base64
import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

from .channels import (
    ChannelCryptoService,
    ChannelManifest,
    ChannelRules,
    ChannelStorage,
    Chunk,
    ChunkPayload,
    OwnedChannel,
    SubscribedChannel,
    decode_channel_link,
    encode_channel_link,
    is_channel_link,
)
from .crypto import CryptoService
from .file_transfer import FileTransferService, FileTransferProgress
from .groups import (
    Group,
    GroupCryptoService,
    GroupMember,
    GroupMessage,
    GroupStorage,
)
from .hooks import EventEmitter
from .media.audio_source import SineWaveSource, FileAudioSource
from .media.video_source import ColorBarSource, FileVideoSource
from .media.media_recorder import MediaRecorder
from .peer_storage import PeerStorage, StoredPeer
from .protocol import (
    HandshakeMessage,
    MESSAGE_CHANNEL_LABEL,
    parse_channel_message,
)
from .signaling import (
    SignalingClient,
    PairMatch,
    PairRequest,
    WebRTCSignal,
    CallSignal,
)
from .webrtc import WebRTCService

logger = logging.getLogger("zajel")


@dataclass
class ConnectedPeer:
    """Information about a connected peer."""

    peer_id: str
    public_key: str
    display_name: Optional[str] = None
    is_initiator: bool = False


@dataclass
class ActiveCall:
    """Information about an active call."""

    call_id: str
    peer_id: str
    with_video: bool
    is_outgoing: bool
    recorder: Optional[MediaRecorder] = None

    async def record_audio(self, duration: float, output_path: Optional[str] = None) -> str:
        """Record incoming audio for a duration."""
        if self.recorder is None:
            raise RuntimeError("No recorder configured")
        return await self.recorder.record_duration(duration)

    async def hangup(self) -> None:
        """Hang up this call (handled by client)."""
        pass  # Wired by ZajelHeadlessClient


@dataclass
class ReceivedMessage:
    """A received text message."""

    peer_id: str
    content: str
    timestamp: float = 0


class ZajelHeadlessClient:
    """High-level headless client for the Zajel P2P protocol.

    Usage:
        async with ZajelHeadlessClient(
            signaling_url="wss://signal.example.com/ws",
            name="TestBot",
            auto_accept_pairs=True,
        ) as client:
            code = await client.connect()
            peer = await client.pair_with("ABC123")
            await client.send_text(peer.peer_id, "Hello!")
            msg = await client.receive_message(timeout=10)
    """

    def __init__(
        self,
        signaling_url: str,
        name: str = "HeadlessBot",
        log_level: str = "INFO",
        auto_accept_pairs: bool = False,
        media_dir: str = "./test_media",
        receive_dir: str = "./received_files",
        db_path: str = "zajel_headless.db",
        ice_servers: Optional[list[dict[str, Any]]] = None,
    ):
        self.signaling_url = signaling_url
        self.name = name
        self.auto_accept_pairs = auto_accept_pairs
        self.media_dir = Path(media_dir)
        self.receive_dir = Path(receive_dir)

        # Configure logging
        logging.basicConfig(
            level=getattr(logging, log_level.upper(), logging.INFO),
            format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        )

        # Convert ice_servers dicts to RTCIceServer objects if provided
        rtc_ice_servers = None
        if ice_servers:
            from aiortc import RTCIceServer
            rtc_ice_servers = []
            skipped_count = 0
            input_had_turn = False
            converted_turn_count = 0
            for i, s in enumerate(ice_servers):
                # Detect whether this entry contains TURN/TURNS URLs
                entry_urls = []
                if isinstance(s, dict):
                    urls_value = s.get("urls") or s.get("url") or []
                    if isinstance(urls_value, str):
                        entry_urls = [urls_value]
                    elif isinstance(urls_value, list):
                        entry_urls = urls_value
                entry_is_turn = any(
                    u.startswith("turn:") or u.startswith("turns:")
                    for u in entry_urls
                )
                if entry_is_turn:
                    input_had_turn = True

                try:
                    if isinstance(s, dict):
                        rtc_ice_servers.append(RTCIceServer(**s))
                    else:
                        rtc_ice_servers.append(s)
                    if entry_is_turn:
                        converted_turn_count += 1
                except (TypeError, ValueError) as e:
                    skipped_count += 1
                    logger.warning(
                        "Skipping invalid ICE server entry at index %d: %s (error: %s)",
                        i, s, e,
                    )

            # Summary log after conversion
            total_input = len(ice_servers)
            success_count = len(rtc_ice_servers)
            logger.info(
                "ICE server conversion: %d/%d servers added successfully, %d skipped",
                success_count, total_input, skipped_count,
            )

            # If user provided servers but ALL failed to convert, this is an error
            if success_count == 0:
                logger.error(
                    "All %d provided ICE server(s) failed to convert. "
                    "WebRTC will fall back to STUN-only, which may cause "
                    "connectivity failures behind NAT. Check your ICE server "
                    "configuration.",
                    total_input,
                )

            # If TURN servers were expected but none made it through, raise
            if input_had_turn and converted_turn_count == 0:
                raise ValueError(
                    "TURN servers were provided in ice_servers configuration but "
                    "none converted successfully. Without TURN relay, peers behind "
                    "symmetric NAT will be unable to connect. Fix the TURN server "
                    "entries and retry."
                )

        # Core services
        self._crypto = CryptoService()
        self._signaling = SignalingClient(signaling_url)
        self._webrtc = WebRTCService(ice_servers=rtc_ice_servers)
        self._storage = PeerStorage(db_path)
        self._events = EventEmitter()

        # State
        self._connected_peers: dict[str, ConnectedPeer] = {}
        self._active_call: Optional[ActiveCall] = None
        self._message_queue: asyncio.Queue[ReceivedMessage] = asyncio.Queue()
        self._file_transfer: Optional[FileTransferService] = None
        self._tasks: list[asyncio.Task] = []
        self._pairing_code: Optional[str] = None

        # Channel state
        self._channel_storage = ChannelStorage()
        self._channel_crypto = ChannelCryptoService()
        self._channel_content_queue: asyncio.Queue[tuple[str, ChunkPayload]] = (
            asyncio.Queue()
        )

        # Group state
        self._group_storage = GroupStorage()
        self._group_crypto = GroupCryptoService()
        self._group_message_queue: asyncio.Queue[GroupMessage] = asyncio.Queue()
        self._group_invitation_queue: asyncio.Queue[Group] = asyncio.Queue()

    async def __aenter__(self) -> "ZajelHeadlessClient":
        return self

    async def __aexit__(self, *args) -> None:
        await self.disconnect()

    @property
    def pairing_code(self) -> Optional[str]:
        return self._pairing_code

    @property
    def crypto(self) -> CryptoService:
        return self._crypto

    def on(self, event: str) -> Callable:
        """Decorator to register an event handler.

        Events: message, call_incoming, peer_connected, peer_disconnected, file_received
        """
        return self._events.on(event)

    # ── Connection ───────────────────────────────────────────

    async def connect(self) -> str:
        """Connect to the signaling server.

        Returns:
            Our pairing code.
        """
        self._crypto.initialize()
        self._storage.initialize()

        self._pairing_code = await self._signaling.connect(
            self._crypto.public_key_base64
        )

        # Set up auto-accept if configured
        if self.auto_accept_pairs:
            self._signaling._on_pair_request = self._auto_accept_pair
            self._signaling._on_pair_match = self._auto_establish_connection

        # Set up channel callbacks
        self._signaling._on_chunk_pull = self._handle_chunk_pull
        self._signaling._on_chunk_available = self._handle_chunk_available
        self._signaling._on_chunk_data = self._handle_chunk_data

        # Start WebRTC signal handler
        self._tasks.append(asyncio.create_task(self._webrtc_signal_loop()))

        logger.info("Connected as %s (code: %s)", self.name, self._pairing_code)
        return self._pairing_code

    async def disconnect(self) -> None:
        """Disconnect from all peers and the signaling server."""
        for task in self._tasks:
            task.cancel()
        self._tasks.clear()

        if self._active_call and self._active_call.recorder:
            await self._active_call.recorder.stop()

        await self._webrtc.close()
        await self._signaling.disconnect()
        self._storage.close()
        self._connected_peers.clear()
        logger.info("Disconnected")

    # ── Pairing ──────────────────────────────────────────────

    async def pair_with(self, target_code: str) -> ConnectedPeer:
        """Initiate pairing with another peer.

        Args:
            target_code: The target peer's pairing code.

        Returns:
            The connected peer info.
        """
        # Disable auto-establish to avoid double WebRTC setup
        saved_callback = self._signaling._on_pair_match
        self._signaling._on_pair_match = None
        try:
            await self._signaling.pair_with(target_code, proposed_name=self.name)
            match = await self._signaling.wait_for_pair_match(timeout=120)
            return await self._establish_connection(match)
        finally:
            self._signaling._on_pair_match = saved_callback

    async def wait_for_pair(self, timeout: float = 60) -> ConnectedPeer:
        """Wait for an incoming pair request (auto_accept_pairs must be True).

        Returns:
            The connected peer info.
        """
        match = await self._signaling.wait_for_pair_match(timeout=timeout)
        return await self._establish_connection(match)

    async def accept_pair(self, request: PairRequest) -> None:
        """Accept an incoming pair request."""
        await self._signaling.respond_to_pair(request.from_code, accept=True)

    async def reject_pair(self, request: PairRequest) -> None:
        """Reject an incoming pair request."""
        await self._signaling.respond_to_pair(request.from_code, accept=False)

    async def wait_for_pair_request(self, timeout: float = 60) -> PairRequest:
        """Wait for an incoming pair request."""
        return await self._signaling.wait_for_pair_request(timeout=timeout)

    # ── Messaging ────────────────────────────────────────────

    async def send_text(self, peer_id: str, content: str) -> None:
        """Send an encrypted text message to a peer."""
        if peer_id not in self._connected_peers:
            raise RuntimeError(f"Not connected to peer {peer_id}")

        encrypted = self._crypto.encrypt(peer_id, content)
        await self._webrtc.send_message(encrypted)
        logger.info("Sent message to %s: %s", peer_id, content[:50])

    async def receive_message(self, timeout: float = 30) -> ReceivedMessage:
        """Wait for a text message from any peer."""
        return await asyncio.wait_for(self._message_queue.get(), timeout=timeout)

    # ── Calls ────────────────────────────────────────────────

    async def call(
        self,
        peer_id: str,
        audio: Optional[str] = None,
        video: Optional[str] = None,
    ) -> ActiveCall:
        """Start a call to a peer.

        Args:
            peer_id: The peer to call.
            audio: Path to audio file to stream, or None for sine wave.
            video: Path to video file to stream, or None for no video.

        Returns:
            The active call object.
        """
        call_id = str(uuid.uuid4())
        with_video = video is not None

        # Create audio track
        if audio:
            audio_path = self.media_dir / audio if not Path(audio).is_absolute() else Path(audio)
            audio_track = FileAudioSource(str(audio_path))
        else:
            audio_track = SineWaveSource(frequency=440)

        self._webrtc.add_track(audio_track)

        # Create video track if needed
        if video:
            video_path = self.media_dir / video if not Path(video).is_absolute() else Path(video)
            video_track = FileVideoSource(str(video_path))
            self._webrtc.add_track(video_track)

        # Create offer and send via signaling
        sdp = await self._webrtc.create_offer()
        await self._signaling.send_call_offer(call_id, peer_id, sdp, with_video)

        call = ActiveCall(
            call_id=call_id,
            peer_id=peer_id,
            with_video=with_video,
            is_outgoing=True,
        )
        self._active_call = call

        # Wire hangup
        async def hangup():
            await self._hangup_call()

        call.hangup = hangup

        return call

    async def wait_for_call(self, timeout: float = 30) -> ActiveCall:
        """Wait for an incoming call."""
        signal = await self._signaling.wait_for_call_signal(timeout=timeout)
        if signal.signal_type != "call_offer":
            raise RuntimeError(f"Expected call_offer, got {signal.signal_type}")

        call = ActiveCall(
            call_id=signal.payload["callId"],
            peer_id=signal.from_code,
            with_video=signal.payload.get("withVideo", False),
            is_outgoing=False,
        )

        # Set remote description
        await self._webrtc.set_remote_description(
            signal.payload["sdp"], "offer"
        )

        self._active_call = call
        await self._events.emit(
            "call_incoming",
            call.peer_id,
            call.call_id,
            call.with_video,
        )

        return call

    async def accept_call(
        self,
        call: Optional[ActiveCall] = None,
        audio: Optional[str] = None,
        video: Optional[str] = None,
    ) -> None:
        """Accept an incoming call."""
        call = call or self._active_call
        if call is None:
            raise RuntimeError("No active call to accept")

        # Add audio track
        if audio:
            audio_path = self.media_dir / audio if not Path(audio).is_absolute() else Path(audio)
            audio_track = FileAudioSource(str(audio_path))
        else:
            audio_track = SineWaveSource(frequency=440)
        self._webrtc.add_track(audio_track)

        # Add video track if requested
        if video:
            video_path = self.media_dir / video if not Path(video).is_absolute() else Path(video)
            video_track = FileVideoSource(str(video_path))
            self._webrtc.add_track(video_track)

        sdp = await self._webrtc.create_answer()
        await self._signaling.send_call_answer(call.call_id, call.peer_id, sdp)

    async def reject_call(self, call: Optional[ActiveCall] = None) -> None:
        """Reject an incoming call."""
        call = call or self._active_call
        if call is None:
            return
        await self._signaling.send_call_reject(call.call_id, call.peer_id)
        self._active_call = None

    async def _hangup_call(self) -> None:
        """End the current call."""
        if self._active_call:
            await self._signaling.send_call_hangup(
                self._active_call.call_id, self._active_call.peer_id
            )
            self._active_call = None

    # ── File Transfer ────────────────────────────────────────

    async def send_file(self, peer_id: str, file_path: str) -> str:
        """Send a file to a peer.

        Returns:
            The file ID.
        """
        if self._file_transfer is None:
            raise RuntimeError("File transfer not initialized (not connected)")
        return await self._file_transfer.send_file(peer_id, file_path)

    async def receive_file(self, timeout: float = 60) -> FileTransferProgress:
        """Wait for a file transfer to complete."""
        if self._file_transfer is None:
            raise RuntimeError("File transfer not initialized (not connected)")
        return await self._file_transfer.wait_for_file(timeout=timeout)

    # ── Peer Management ──────────────────────────────────────

    async def block_peer(self, peer_id: str) -> None:
        """Block a peer."""
        self._storage.block_peer(peer_id)
        if peer_id in self._connected_peers:
            del self._connected_peers[peer_id]

    async def unblock_peer(self, peer_id: str) -> None:
        """Unblock a peer."""
        self._storage.unblock_peer(peer_id)

    async def get_trusted_peers(self) -> list[StoredPeer]:
        """Get all trusted peers."""
        return self._storage.get_all_peers()

    def get_connected_peers(self) -> dict:
        """Return all connected peers."""
        return dict(self._connected_peers)

    # ── Channels ─────────────────────────────────────────────

    async def create_channel(
        self, name: str, description: str = ""
    ) -> OwnedChannel:
        """Create a new channel owned by this client.

        Generates Ed25519 signing and X25519 encryption keypairs,
        creates and signs the manifest, registers as owner with the
        signaling server, and returns the OwnedChannel.
        """
        pub, priv = self._channel_crypto.generate_signing_keypair()
        enc_pub, enc_priv = self._channel_crypto.generate_encryption_keypair()
        channel_id = self._channel_crypto.derive_channel_id(pub)

        manifest = ChannelManifest(
            channel_id=channel_id,
            name=name,
            description=description,
            owner_key=pub,
            current_encrypt_key=enc_pub,
        )
        manifest = self._channel_crypto.sign_manifest(manifest, priv)

        channel = OwnedChannel(
            channel_id=channel_id,
            manifest=manifest,
            signing_key_private=priv,
            encryption_key_private=enc_priv,
            encryption_key_public=enc_pub,
        )
        self._channel_storage.save_owned(channel)

        # Register as owner with signaling server
        if self._signaling.is_connected:
            await self._signaling.send_channel_owner_register(channel_id)

        logger.info("Created channel %s (%s)", name, channel_id[:16])
        return channel

    def get_channel_invite_link(self, channel_id: str) -> str:
        """Generate an invite link for an owned channel."""
        channel = self._channel_storage.get_owned(channel_id)
        if channel is None:
            raise RuntimeError(f"Owned channel not found: {channel_id}")
        return encode_channel_link(channel.manifest, channel.encryption_key_private)

    async def publish_channel_message(
        self, channel_id: str, text: str
    ) -> list[Chunk]:
        """Publish a text message to an owned channel.

        Encrypts, chunks, signs, announces via signaling, and stores
        the chunks for responding to chunk_pull requests.
        """
        channel = self._channel_storage.get_owned(channel_id)
        if channel is None:
            raise RuntimeError(f"Owned channel not found: {channel_id}")

        # Enforce content type rules (Plan 09 content safety)
        allowed = channel.manifest.rules.allowed_types
        if allowed and "text" not in allowed:
            raise RuntimeError(
                f"Channel does not allow 'text' content (allowed: {allowed})"
            )

        channel.sequence += 1
        sequence = channel.sequence

        routing_hash = self._channel_crypto.derive_routing_hash(
            channel.encryption_key_private
        )

        payload = ChunkPayload(
            content_type="text",
            payload=text.encode("utf-8"),
        )

        chunks = self._channel_crypto.create_chunks(
            payload=payload,
            encryption_key_private_b64=channel.encryption_key_private,
            signing_key_private_b64=channel.signing_key_private,
            owner_public_key_b64=channel.manifest.owner_key,
            key_epoch=channel.manifest.key_epoch,
            sequence=sequence,
            routing_hash=routing_hash,
        )

        # Store chunks locally for chunk_pull responses
        for chunk in chunks:
            channel.chunks[chunk.chunk_id] = chunk

        # Announce and push chunks to the signaling server
        if self._signaling.is_connected:
            chunk_list = [
                {"chunkId": c.chunk_id, "routingHash": c.routing_hash}
                for c in chunks
            ]
            await self._signaling.send_chunk_announce(
                self._pairing_code or "",
                channel_id,
                chunk_list,
            )
            # Proactively push chunk data so VPS caches it for late subscribers
            for chunk in chunks:
                await self._signaling.send_chunk_push(
                    chunk.chunk_id, channel_id, chunk.to_dict()
                )

        logger.info(
            "Published message to channel %s (seq %d, %d chunks)",
            channel_id[:16], sequence, len(chunks),
        )
        return chunks

    async def _handle_chunk_pull(self, msg: dict) -> None:
        """Handle chunk_pull from the server — respond with chunk_push."""
        chunk_id = msg.get("chunkId", "")
        channel_id = msg.get("channelId", "")

        # Search all owned channels for the requested chunk
        for ch in self._channel_storage.get_all_owned():
            chunk = ch.chunks.get(chunk_id)
            if chunk:
                await self._signaling.send_chunk_push(
                    chunk_id, channel_id, chunk.to_dict()
                )
                logger.debug("Pushed chunk %s for channel %s", chunk_id, channel_id[:16])
                return

        logger.warning("Chunk pull for unknown chunk %s", chunk_id)

    async def _handle_chunk_available(self, msg: dict) -> None:
        """Handle chunk_available — request the chunks from the relay."""
        channel_id = msg.get("channelId", "")
        chunk_ids = msg.get("chunkIds", [])
        peer_id = self._pairing_code or ""

        channel = self._channel_storage.get_channel(channel_id)
        if channel is None:
            return  # Not subscribed to this channel

        for chunk_id in chunk_ids:
            # Skip chunks we already have
            if chunk_id in channel.chunks:
                continue
            await self._signaling.send_chunk_request(peer_id, chunk_id, channel_id)

    async def _handle_chunk_data(self, msg: dict) -> None:
        """Handle chunk_data — process received chunk."""
        channel_id = msg.get("channelId", "")
        chunk_data = msg.get("data")

        if not chunk_data or not channel_id:
            return

        # If data is a dict, use it directly; otherwise parse it
        if isinstance(chunk_data, str):
            chunk_data = json.loads(chunk_data)

        await self.receive_channel_chunk(channel_id, chunk_data)

    async def subscribe_channel(self, invite_link: str) -> SubscribedChannel:
        """Subscribe to a channel by decoding a zajel:// invite link.

        Decodes the link, verifies the manifest signature, and stores
        the channel subscription locally.

        Args:
            invite_link: A zajel://channel/<base64url> invite link.

        Returns:
            The subscribed channel.

        Raises:
            ValueError: If the link is invalid or the manifest signature
                is not valid.
        """
        manifest, encryption_key = decode_channel_link(invite_link)

        # Verify the manifest signature
        if not self._channel_crypto.verify_manifest(manifest):
            raise ValueError("Channel manifest signature is invalid")

        channel = SubscribedChannel(
            channel_id=manifest.channel_id,
            manifest=manifest,
            encryption_key=encryption_key,
        )
        self._channel_storage.save_channel(channel)

        # Register subscription with signaling server
        if self._signaling.is_connected:
            await self._signaling.send_channel_subscribe(manifest.channel_id)

        logger.info(
            "Subscribed to channel %s (%s)",
            manifest.name,
            manifest.channel_id[:16],
        )
        return channel

    async def get_subscribed_channels(self) -> list[SubscribedChannel]:
        """Get all subscribed channels."""
        return self._channel_storage.get_all_channels()

    async def get_channel(self, channel_id: str) -> Optional[SubscribedChannel]:
        """Get a subscribed channel by ID."""
        return self._channel_storage.get_channel(channel_id)

    async def unsubscribe_channel(self, channel_id: str) -> None:
        """Unsubscribe from a channel."""
        self._channel_storage.delete_channel(channel_id)
        logger.info("Unsubscribed from channel %s", channel_id[:16])

    async def receive_channel_chunk(
        self, channel_id: str, chunk_data: dict
    ) -> Optional[ChunkPayload]:
        """Process an incoming chunk for a subscribed channel.

        Verifies the chunk signature, checks the author is authorized,
        stores the chunk, and if the message is complete, decrypts and
        returns the payload.

        Args:
            channel_id: The channel ID.
            chunk_data: The chunk data dict (from server relay).

        Returns:
            The decrypted ChunkPayload if the full message is assembled,
            or None if still waiting for more chunks.
        """
        channel = self._channel_storage.get_channel(channel_id)
        if channel is None:
            raise RuntimeError(f"Not subscribed to channel {channel_id}")

        chunk = Chunk.from_dict(chunk_data)

        # Verify signature
        if not self._channel_crypto.verify_chunk_signature(chunk):
            logger.warning(
                "Chunk %s has invalid signature, discarding",
                chunk.chunk_id,
            )
            return None

        # Verify author is in manifest (owner or admin)
        manifest = channel.manifest
        is_owner = chunk.author_pubkey == manifest.owner_key
        is_admin = any(
            a.key == chunk.author_pubkey for a in manifest.admin_keys
        )
        if not is_owner and not is_admin:
            logger.warning(
                "Chunk %s author not authorized in manifest, discarding",
                chunk.chunk_id,
            )
            return None

        # Store chunk
        self._channel_storage.save_chunk(channel_id, chunk)

        # Check if we have all chunks for this sequence
        chunks = self._channel_storage.get_chunks_by_sequence(
            channel_id, chunk.sequence
        )
        if len(chunks) < chunk.total_chunks:
            return None  # Still waiting for more chunks

        # Reassemble and decrypt
        sorted_chunks = sorted(chunks, key=lambda c: c.chunk_index)
        combined = b""
        for c in sorted_chunks:
            combined += c.encrypted_payload

        payload = self._channel_crypto.decrypt_payload(
            combined,
            channel.encryption_key,
            manifest.key_epoch,
        )

        # Enforce content type rules from manifest (Plan 09 content safety)
        allowed = manifest.rules.allowed_types
        if allowed and payload.content_type not in allowed:
            logger.warning(
                "Chunk %s content type '%s' not in allowed_types %s, discarding",
                chunk.chunk_id,
                payload.content_type,
                allowed,
            )
            return None

        # Emit event and queue
        self._channel_content_queue.put_nowait((channel_id, payload))
        await self._events.emit(
            "channel_content", channel_id, payload
        )

        logger.info(
            "Received channel content: %s (seq %d, type %s)",
            manifest.name,
            chunk.sequence,
            payload.content_type,
        )
        return payload

    async def receive_channel_content(
        self, timeout: float = 30
    ) -> tuple[str, ChunkPayload]:
        """Wait for channel content from any subscribed channel.

        Returns:
            (channel_id, payload) tuple.
        """
        return await asyncio.wait_for(
            self._channel_content_queue.get(), timeout=timeout
        )

    # ── Groups ──────────────────────────────────────────────

    async def create_group(self, name: str) -> Group:
        """Create a new group.

        The client becomes the first member and generates a sender key.

        Args:
            name: The group name.

        Returns:
            The created Group.
        """
        group_id = str(uuid.uuid4())
        device_id = self._pairing_code or "headless"

        self_member = GroupMember(
            device_id=device_id,
            display_name=self.name,
            public_key=self._crypto.public_key_base64,
        )

        group = Group(
            id=group_id,
            name=name,
            self_device_id=device_id,
            members=[self_member],
            created_by=device_id,
        )

        # Generate our sender key
        sender_key = self._group_crypto.generate_sender_key()
        self._group_crypto.set_sender_key(group_id, device_id, sender_key)

        self._group_storage.save_group(group)

        logger.info("Created group %s (%s)", name, group_id[:8])
        return group

    async def get_groups(self) -> list[Group]:
        """Get all groups."""
        return self._group_storage.get_all_groups()

    async def get_group(self, group_id: str) -> Optional[Group]:
        """Get a group by ID."""
        return self._group_storage.get_group(group_id)

    async def add_group_member(
        self,
        group_id: str,
        member: GroupMember,
        sender_key: str,
    ) -> Group:
        """Add a member to a group.

        Args:
            group_id: The group ID.
            member: The new member.
            sender_key: The member's sender key (base64).

        Returns:
            The updated Group.
        """
        group = self._group_storage.get_group(group_id)
        if group is None:
            raise RuntimeError(f"Group not found: {group_id}")

        if len(group.members) >= 15:
            raise RuntimeError("Group is full (max 15 members)")

        if any(m.device_id == member.device_id for m in group.members):
            raise RuntimeError(
                f"Member {member.device_id} already in group"
            )

        # Store sender key
        self._group_crypto.set_sender_key(
            group_id, member.device_id, sender_key
        )

        # Update group
        group.members.append(member)
        self._group_storage.save_group(group)

        logger.info(
            "Added %s to group %s",
            member.display_name,
            group.name,
        )
        return group

    async def send_group_message(
        self, group_id: str, content: str
    ) -> GroupMessage:
        """Send a message to a group.

        Encrypts with our sender key. The caller is responsible for
        broadcasting the encrypted bytes to connected peers.

        Args:
            group_id: The group ID.
            content: The message text.

        Returns:
            The GroupMessage that was sent.
        """
        group = self._group_storage.get_group(group_id)
        if group is None:
            raise RuntimeError(f"Group not found: {group_id}")

        device_id = group.self_device_id
        seq = self._group_storage.get_next_sequence(group_id, device_id)

        message = GroupMessage(
            group_id=group_id,
            author_device_id=device_id,
            sequence_number=seq,
            content=content,
            is_outgoing=True,
        )

        # Encrypt with our sender key
        plaintext_bytes = message.to_bytes()
        encrypted = self._group_crypto.encrypt(
            plaintext_bytes, group_id, device_id
        )

        # Store locally
        self._group_storage.save_message(message)

        # Broadcast to all connected peers who are members of this group.
        # Uses the grp: prefix protocol matching the Flutter app's
        # WebRtcP2PAdapter: grp:<base64(encrypted_bytes)>
        payload = f"grp:{base64.b64encode(encrypted).decode('ascii')}"
        sent_count = 0
        for member in group.other_members:
            peer_id = member.device_id
            if peer_id in self._connected_peers and self._crypto.has_session_key(peer_id):
                try:
                    cipher = self._crypto.encrypt(peer_id, payload)
                    await self._webrtc.send_message(cipher)
                    sent_count += 1
                    logger.debug(
                        "Broadcast group message to %s in '%s'",
                        peer_id, group.name,
                    )
                except Exception as e:
                    logger.error(
                        "Failed to broadcast group message to %s: %s",
                        peer_id, e,
                    )

        logger.info(
            "Sent group message to '%s' (%d/%d peers): %s",
            group.name, sent_count, len(group.other_members), content[:50],
        )
        return message

    async def receive_group_message(
        self,
        group_id: str,
        author_device_id: str,
        encrypted_bytes: bytes,
    ) -> Optional[GroupMessage]:
        """Receive and decrypt a group message.

        Args:
            group_id: The group ID.
            author_device_id: The sender's device ID.
            encrypted_bytes: The encrypted message bytes.

        Returns:
            The decrypted GroupMessage, or None if duplicate.
        """
        group = self._group_storage.get_group(group_id)
        if group is None:
            raise RuntimeError(f"Group not found: {group_id}")

        # Decrypt with the author's sender key
        plaintext = self._group_crypto.decrypt(
            encrypted_bytes, group_id, author_device_id
        )

        message = GroupMessage.from_bytes(
            plaintext, group_id=group_id, is_outgoing=False
        )

        # Check for duplicate
        if self._group_storage.is_duplicate(group_id, message.id):
            return None

        # Verify author matches
        if message.author_device_id != author_device_id:
            raise RuntimeError(
                f"Author mismatch: encrypted by {author_device_id} "
                f"but claims to be from {message.author_device_id}"
            )

        # Store and emit
        self._group_storage.save_message(message)
        self._group_message_queue.put_nowait(message)
        await self._events.emit(
            "group_message", group_id, message
        )

        logger.info(
            "Received group message from %s in %s",
            author_device_id,
            group.name,
        )
        return message

    async def wait_for_group_message(
        self, timeout: float = 30
    ) -> GroupMessage:
        """Wait for a group message from any group."""
        return await asyncio.wait_for(
            self._group_message_queue.get(), timeout=timeout
        )

    async def get_group_messages(
        self, group_id: str, limit: Optional[int] = None
    ) -> list[GroupMessage]:
        """Get stored messages for a group."""
        return self._group_storage.get_messages(group_id, limit=limit)

    async def leave_group(self, group_id: str) -> None:
        """Leave a group."""
        self._group_crypto.clear_group_keys(group_id)
        self._group_storage.delete_group(group_id)
        logger.info("Left group %s", group_id[:8])

    async def wait_for_group_invitation(
        self, timeout: float = 30
    ) -> Group:
        """Wait for an incoming group invitation.

        Returns the Group object created from the invitation payload.
        The invitation is auto-accepted when received.
        """
        return await asyncio.wait_for(
            self._group_invitation_queue.get(), timeout=timeout
        )

    def _handle_group_invitation(
        self, from_peer_id: str, payload: str
    ) -> None:
        """Handle incoming group invitation (ginv: protocol).

        Parses the invitation JSON, creates the group locally, imports
        all sender keys, and stores the invitee's own sender key.

        The invitation format matches the Dart GroupInvitationService:
        {
            "groupId": "uuid",
            "groupName": "Family Chat",
            "createdBy": "alice-device",
            "createdAt": "2026-02-01T12:00:00.000Z",
            "members": [{"device_id": "...", "display_name": "...", ...}],
            "senderKeys": {"alice-device": "base64-key", ...},
            "inviteeSenderKey": "base64-key",
            "inviterDeviceId": "alice-device"
        }
        """
        try:
            data = json.loads(payload)

            group_id = data["groupId"]
            group_name = data["groupName"]
            created_by = data["createdBy"]
            created_at = data["createdAt"]
            members_json = data["members"]
            sender_keys = data["senderKeys"]
            invitee_sender_key = data["inviteeSenderKey"]

            # Check if we already have this group
            existing = self._group_storage.get_group(group_id)
            if existing is not None:
                logger.info(
                    "Already in group '%s', ignoring invitation", group_name
                )
                return

            # Parse members from Dart-format JSON
            from datetime import datetime
            members = []
            for m in members_json:
                members.append(GroupMember(
                    device_id=m["device_id"],
                    display_name=m["display_name"],
                    public_key=m["public_key"],
                    joined_at=datetime.fromisoformat(m.get("joined_at", created_at)),
                ))

            # Create the group locally with self_device_id = our pairing code
            group = Group(
                id=group_id,
                name=group_name,
                self_device_id=self._pairing_code,
                members=members,
                created_at=datetime.fromisoformat(created_at),
                created_by=created_by,
            )

            # Import all existing members' sender keys
            for device_id, key_b64 in sender_keys.items():
                self._group_crypto.set_sender_key(
                    group_id, device_id, key_b64
                )

            # Set our own sender key
            self._group_crypto.set_sender_key(
                group_id, self._pairing_code, invitee_sender_key
            )

            # Persist group
            self._group_storage.save_group(group)

            # Queue for test assertion
            self._group_invitation_queue.put_nowait(group)

            logger.info(
                "Accepted group invitation for '%s' from %s "
                "(members: %d, sender keys: %d)",
                group_name,
                from_peer_id,
                len(members),
                len(sender_keys) + 1,  # +1 for invitee key
            )

        except Exception as e:
            logger.error(
                "Failed to handle group invitation from %s: %s",
                from_peer_id,
                e,
            )

    def _handle_group_data(
        self, from_peer_id: str, payload_b64: str
    ) -> None:
        """Handle incoming group message data (grp: protocol).

        The payload is base64-encoded encrypted bytes. We try decrypting
        with each group where from_peer_id is a member.
        """
        try:
            encrypted_bytes = base64.b64decode(payload_b64)
        except Exception as e:
            logger.error("Failed to decode group data from %s: %s", from_peer_id, e)
            return

        # Try each group where from_peer_id is a member
        for group in self._group_storage.get_all_groups():
            for member in group.members:
                if member.device_id == from_peer_id:
                    try:
                        message = self._receive_group_message_sync(
                            group, from_peer_id, encrypted_bytes
                        )
                        if message:
                            logger.info(
                                "Received group message from %s in '%s': %s",
                                from_peer_id,
                                group.name,
                                message.content[:50],
                            )
                        return
                    except Exception as e:
                        logger.debug(
                            "Group decrypt failed for %s in %s: %s",
                            from_peer_id,
                            group.id,
                            e,
                        )

        logger.warning(
            "Could not decrypt group data from %s (not a member of any group)",
            from_peer_id,
        )

    def _receive_group_message_sync(
        self, group: "Group", author_device_id: str, encrypted_bytes: bytes
    ) -> Optional["GroupMessage"]:
        """Synchronous group message receive (called from sync callback)."""
        # Decrypt with the author's sender key
        plaintext = self._group_crypto.decrypt(
            encrypted_bytes, group.id, author_device_id
        )

        message = GroupMessage.from_bytes(
            plaintext, group_id=group.id, is_outgoing=False
        )

        # Check for duplicate
        if self._group_storage.is_duplicate(group.id, message.id):
            return None

        # Verify author matches
        if message.author_device_id != author_device_id:
            raise RuntimeError(
                f"Author mismatch: encrypted by {author_device_id} "
                f"but claims to be from {message.author_device_id}"
            )

        # Store and emit
        self._group_storage.save_message(message)
        self._group_message_queue.put_nowait(message)
        asyncio.get_event_loop().create_task(
            self._events.emit("group_message", group.id, message)
        )
        return message

    # ── Internal ─────────────────────────────────────────────

    async def _auto_accept_pair(self, request: PairRequest) -> None:
        """Auto-accept incoming pair requests."""
        logger.info("Auto-accepting pair from %s", request.from_code)
        await self._signaling.respond_to_pair(request.from_code, accept=True)

    async def _auto_establish_connection(self, match: PairMatch) -> None:
        """Auto-establish WebRTC after pair match (called from _on_pair_match callback)."""
        logger.info("Auto-establishing connection with %s (initiator=%s)", match.peer_code, match.is_initiator)
        self._tasks.append(asyncio.create_task(self._establish_connection(match)))

    async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
        """Establish a WebRTC connection after pairing."""
        peer = ConnectedPeer(
            peer_id=match.peer_code,
            public_key=match.peer_public_key,
            is_initiator=match.is_initiator,
        )

        # Store peer early so incoming handshake messages can find it
        # (the app sends its handshake as soon as the data channel opens,
        # which can arrive before we finish _establish_connection)
        self._connected_peers[match.peer_code] = peer

        # Create WebRTC connection
        await self._webrtc.create_connection(match.is_initiator)

        # Set up data channel handlers
        self._webrtc.on_message_channel_message = self._on_message_channel_data
        self._webrtc.on_file_channel_message = self._on_file_channel_data

        # Set up ICE candidate handler
        async def on_ice(candidate_dict):
            await self._signaling.send_ice_candidate(
                match.peer_code, candidate_dict
            )
        self._webrtc.on_ice_candidate = on_ice

        if match.is_initiator:
            # Create and send offer
            sdp = await self._webrtc.create_offer()
            await self._signaling.send_offer(match.peer_code, sdp)

            # Wait for answer
            signal = await self._signaling.wait_for_webrtc_signal(timeout=30)
            if signal.signal_type == "answer":
                await self._webrtc.set_remote_description(
                    signal.payload["sdp"], "answer"
                )
        else:
            # Wait for offer
            signal = await self._signaling.wait_for_webrtc_signal(timeout=30)
            if signal.signal_type == "offer":
                await self._webrtc.set_remote_description(
                    signal.payload["sdp"], "offer"
                )
                sdp = await self._webrtc.create_answer()
                await self._signaling.send_answer(match.peer_code, sdp)

        # Process ICE candidates in background
        self._tasks.append(asyncio.create_task(self._ice_candidate_loop(match.peer_code)))

        # Wait for data channel
        await self._webrtc.wait_for_message_channel(timeout=30)

        # Send handshake (key exchange)
        handshake = HandshakeMessage(public_key=self._crypto.public_key_base64)
        await self._webrtc.send_message(handshake.to_json())

        # Initialize file transfer service
        self._file_transfer = FileTransferService(
            crypto=self._crypto,
            send_fn=lambda data: self._webrtc._channels.file_channel.send(data)
            if self._webrtc._channels.file_channel
            else None,
            receive_dir=str(self.receive_dir),
        )

        # Save to storage
        from datetime import datetime
        self._storage.save_peer(StoredPeer(
            peer_id=match.peer_code,
            display_name=peer.display_name or match.peer_code,
            public_key=match.peer_public_key,
            trusted_at=datetime.utcnow(),
            last_seen=datetime.utcnow(),
        ))

        await self._events.emit("peer_connected", peer.peer_id, peer.public_key)
        logger.info("Connected to peer %s", match.peer_code)
        return peer

    async def _ice_candidate_loop(self, peer_code: str) -> None:
        """Process ICE candidates from the signaling server."""
        try:
            while self._signaling.is_connected:
                try:
                    signal = await asyncio.wait_for(
                        self._signaling.wait_for_webrtc_signal(timeout=5), timeout=5
                    )
                    if signal.signal_type == "ice_candidate":
                        await self._webrtc.add_ice_candidate(signal.payload)
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            pass

    async def _webrtc_signal_loop(self) -> None:
        """Background loop to process WebRTC signals."""
        try:
            while self._signaling.is_connected:
                await asyncio.sleep(0.1)
        except asyncio.CancelledError:
            pass

    def _on_message_channel_data(self, data: str) -> None:
        """Handle data from the message channel."""
        msg = parse_channel_message(data)

        if msg["type"] == "handshake":
            # Key exchange
            peer_pub_key = msg["publicKey"]
            # Find which peer this is from
            for peer_id, peer in self._connected_peers.items():
                if not self._crypto.has_session_key(peer_id):
                    self._crypto.perform_key_exchange(peer_id, peer_pub_key)
                    logger.info("Key exchange completed with %s", peer_id)
                    break
            else:
                logger.warning("No peer found for handshake")

        elif msg["type"] == "encrypted_text":
            # Encrypted message — decrypt with first connected peer that has a key
            for peer_id in self._connected_peers:
                if self._crypto.has_session_key(peer_id):
                    try:
                        plaintext = self._crypto.decrypt(peer_id, msg["data"])

                        # Check for group invitation prefix
                        if plaintext.startswith("ginv:"):
                            self._handle_group_invitation(
                                peer_id, plaintext[5:]
                            )
                            break

                        # Check for group message prefix
                        if plaintext.startswith("grp:"):
                            self._handle_group_data(
                                peer_id, plaintext[4:]
                            )
                            break

                        received = ReceivedMessage(
                            peer_id=peer_id, content=plaintext
                        )
                        self._message_queue.put_nowait(received)
                        asyncio.get_event_loop().create_task(
                            self._events.emit("message", peer_id, plaintext, "text")
                        )
                        break
                    except Exception as e:
                        logger.debug("Decrypt failed for %s: %s", peer_id, e)

    def _on_file_channel_data(self, data: str) -> None:
        """Handle data from the file channel."""
        # File channel messages are encrypted — decrypt first
        for peer_id in self._connected_peers:
            if self._crypto.has_session_key(peer_id):
                try:
                    plaintext = self._crypto.decrypt(peer_id, data)
                    msg = json.loads(plaintext)
                    if self._file_transfer:
                        self._file_transfer.handle_file_message(peer_id, msg)
                    break
                except Exception as e:
                    logger.debug("File channel decrypt failed for %s: %s", peer_id, e)
