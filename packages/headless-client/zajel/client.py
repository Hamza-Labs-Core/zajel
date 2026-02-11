"""Main Zajel headless client orchestrator.

Provides the high-level API for interacting with the Zajel protocol:
- Connect to signaling server
- Pair with peers
- Send/receive encrypted messages
- Make/receive voice/video calls
- Transfer files
- Hook into events
"""

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

from .crypto import CryptoService
from .file_transfer import FileTransferService, FileTransferProgress
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
        await self._signaling.pair_with(target_code, proposed_name=self.name)
        match = await self._signaling.wait_for_pair_match(timeout=120)
        return await self._establish_connection(match)

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

    # ── Internal ─────────────────────────────────────────────

    async def _auto_accept_pair(self, request: PairRequest) -> None:
        """Auto-accept incoming pair requests."""
        logger.info("Auto-accepting pair from %s", request.from_code)
        await self._signaling.respond_to_pair(request.from_code, accept=True)

    async def _establish_connection(self, match: PairMatch) -> ConnectedPeer:
        """Establish a WebRTC connection after pairing."""
        peer = ConnectedPeer(
            peer_id=match.peer_code,
            public_key=match.peer_public_key,
            is_initiator=match.is_initiator,
        )

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

        # Store peer
        self._connected_peers[match.peer_code] = peer

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

        elif msg["type"] == "encrypted_text":
            # Encrypted message — decrypt with first connected peer that has a key
            for peer_id in self._connected_peers:
                if self._crypto.has_session_key(peer_id):
                    try:
                        plaintext = self._crypto.decrypt(peer_id, msg["data"])
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
