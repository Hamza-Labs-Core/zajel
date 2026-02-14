"""WebRTC service using aiortc for peer-to-peer connections.

Handles:
- Peer connection creation with STUN/TURN
- Data channel setup (message + file channels)
- Audio/video tracks for calls
- ICE candidate exchange
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Optional

from aiortc import (
    RTCConfiguration,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
    MediaStreamTrack,
)
from aiortc.contrib.media import MediaRelay
from aiortc.sdp import candidate_from_sdp

from .protocol import MESSAGE_CHANNEL_LABEL, FILE_CHANNEL_LABEL

logger = logging.getLogger("zajel.webrtc")

# NOTE: This STUN URL is also defined in:
#   - e2e-tests/conftest.py (headless_bob fixture)
#   - packages/app/lib/core/constants.dart (defaultIceServers)
# Keep all three in sync when changing.
DEFAULT_ICE_SERVERS = [
    RTCIceServer(urls=["stun:stun.l.google.com:19302"]),
]

EventHandler = Callable[..., Coroutine[Any, Any, None]]


@dataclass
class DataChannelPair:
    """The two data channels used for communication."""

    message_channel: Any = None  # RTCDataChannel
    file_channel: Any = None  # RTCDataChannel


class WebRTCService:
    """Manages WebRTC peer connections for data and media."""

    def __init__(
        self,
        ice_servers: Optional[list[RTCIceServer]] = None,
        force_relay: bool = False,
    ):
        self._ice_servers = ice_servers or DEFAULT_ICE_SERVERS
        self._force_relay = force_relay

        # Log configured ICE servers (URLs only, not credentials)
        for server in self._ice_servers:
            urls = server.urls if isinstance(server.urls, list) else [server.urls]
            logger.info("ICE server configured: %s", ", ".join(urls))

        self._pc: Optional[RTCPeerConnection] = None
        self._channels = DataChannelPair()
        self._relay = MediaRelay()

        # Event callbacks
        self.on_message_channel_message: Optional[Callable[[str], None]] = None
        self.on_file_channel_message: Optional[Callable[[str], None]] = None
        self.on_ice_candidate: Optional[Callable[[dict], Coroutine]] = None
        self.on_connection_state_change: Optional[Callable[[str], None]] = None
        self.on_remote_track: Optional[Callable[[MediaStreamTrack], None]] = None

        # State
        self._message_channel_open = asyncio.Event()
        self._file_channel_open = asyncio.Event()
        self._connected = asyncio.Event()
        self._ice_candidates: list[dict] = []

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set()

    @property
    def message_channel(self):
        return self._channels.message_channel

    @property
    def file_channel(self):
        return self._channels.file_channel

    async def create_connection(self, is_initiator: bool) -> RTCPeerConnection:
        """Create a new WebRTC peer connection.

        Args:
            is_initiator: Whether this peer initiates the connection.

        Returns:
            The created RTCPeerConnection.
        """
        if self._force_relay:
            logger.info(
                "force_relay=True but aiortc does not support iceTransportPolicy; "
                "TURN relay candidates will be used as fallback when direct candidates fail"
            )
        config = RTCConfiguration(iceServers=self._ice_servers)
        self._pc = RTCPeerConnection(configuration=config)

        # Set up event handlers
        @self._pc.on("icecandidate")
        async def on_ice(candidate):
            if candidate and self.on_ice_candidate:
                candidate_dict = {
                    "candidate": candidate.candidate,
                    "sdpMid": candidate.sdpMid,
                    "sdpMLineIndex": candidate.sdpMLineIndex,
                }
                await self.on_ice_candidate(candidate_dict)

        @self._pc.on("connectionstatechange")
        async def on_state():
            state = self._pc.connectionState
            logger.info("Connection state: %s", state)
            if state == "connected":
                self._connected.set()
            elif state in ("failed", "closed"):
                self._connected.clear()
            if self.on_connection_state_change:
                self.on_connection_state_change(state)

        @self._pc.on("track")
        def on_track(track):
            logger.info("Received remote track: %s", track.kind)
            if self.on_remote_track:
                self.on_remote_track(track)

        @self._pc.on("datachannel")
        def on_datachannel(channel):
            logger.info("Received data channel: %s", channel.label)
            self._setup_channel(channel)

        # Initiator creates data channels
        if is_initiator:
            msg_ch = self._pc.createDataChannel(
                MESSAGE_CHANNEL_LABEL, ordered=True
            )
            file_ch = self._pc.createDataChannel(
                FILE_CHANNEL_LABEL, ordered=True
            )
            self._setup_channel(msg_ch)
            self._setup_channel(file_ch)

        logger.info("Created peer connection (initiator=%s)", is_initiator)
        return self._pc

    async def create_offer(self) -> str:
        """Create an SDP offer."""
        if self._pc is None:
            raise RuntimeError("No peer connection")
        offer = await self._pc.createOffer()
        await self._pc.setLocalDescription(offer)
        return self._pc.localDescription.sdp

    async def create_answer(self) -> str:
        """Create an SDP answer."""
        if self._pc is None:
            raise RuntimeError("No peer connection")
        answer = await self._pc.createAnswer()
        await self._pc.setLocalDescription(answer)
        return self._pc.localDescription.sdp

    async def set_remote_description(self, sdp: str, sdp_type: str) -> None:
        """Set the remote SDP description."""
        if self._pc is None:
            raise RuntimeError("No peer connection")
        desc = RTCSessionDescription(sdp=sdp, type=sdp_type)
        await self._pc.setRemoteDescription(desc)

    async def add_ice_candidate(self, candidate_dict: dict) -> None:
        """Add a remote ICE candidate."""
        if self._pc is None:
            self._ice_candidates.append(candidate_dict)
            return

        candidate_str = candidate_dict.get("candidate", "")
        if not candidate_str:
            return

        try:
            candidate = candidate_from_sdp(candidate_str)
            candidate.sdpMid = candidate_dict.get("sdpMid", "0")
            candidate.sdpMLineIndex = candidate_dict.get("sdpMLineIndex", 0)
            await self._pc.addIceCandidate(candidate)
        except Exception as e:
            logger.debug("ICE candidate add error (non-fatal): %s", e)

    async def send_message(self, data: str) -> None:
        """Send data on the message channel."""
        await self._message_channel_open.wait()
        if self._channels.message_channel:
            self._channels.message_channel.send(data)

    async def send_file_data(self, data: str) -> None:
        """Send data on the file channel."""
        await self._file_channel_open.wait()
        if self._channels.file_channel:
            self._channels.file_channel.send(data)

    async def wait_for_message_channel(self, timeout: float = 30) -> None:
        """Wait for the message data channel to open."""
        await asyncio.wait_for(self._message_channel_open.wait(), timeout=timeout)

    async def wait_for_connection(self, timeout: float = 30) -> None:
        """Wait for the WebRTC connection to be established."""
        await asyncio.wait_for(self._connected.wait(), timeout=timeout)

    def add_track(self, track: MediaStreamTrack) -> None:
        """Add a media track to the connection."""
        if self._pc is None:
            raise RuntimeError("No peer connection")
        self._pc.addTrack(track)

    async def close(self) -> None:
        """Close the peer connection and release resources."""
        if self._pc:
            await self._pc.close()
            self._pc = None
        self._channels = DataChannelPair()
        self._message_channel_open.clear()
        self._file_channel_open.clear()
        self._connected.clear()
        logger.info("WebRTC connection closed")

    def _setup_channel(self, channel) -> None:
        """Configure event handlers for a data channel."""
        if channel.label == MESSAGE_CHANNEL_LABEL:
            self._channels.message_channel = channel

            @channel.on("open")
            def on_open():
                logger.info("Message channel opened")
                self._message_channel_open.set()

            @channel.on("message")
            def on_message(data):
                if self.on_message_channel_message:
                    self.on_message_channel_message(data)

            # For responder: channel may already be open when datachannel event fires
            if channel.readyState == "open":
                logger.info("Message channel already open on setup")
                self._message_channel_open.set()

        elif channel.label == FILE_CHANNEL_LABEL:
            self._channels.file_channel = channel

            @channel.on("open")
            def on_open():
                logger.info("File channel opened")
                self._file_channel_open.set()

            @channel.on("message")
            def on_message(data):
                if self.on_file_channel_message:
                    self.on_file_channel_message(data)

            # For responder: channel may already be open when datachannel event fires
            if channel.readyState == "open":
                logger.info("File channel already open on setup")
                self._file_channel_open.set()
