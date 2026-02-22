"""WebSocket signaling client for the Zajel protocol.

Handles:
- Connection registration (pairing code + public key)
- Pairing flow (request, accept/reject, match)
- WebRTC signaling relay (offer, answer, ICE candidates)
- Call signaling (offer, answer, reject, hangup, ICE)
- Rendezvous registration for trusted peer reconnection
- Heartbeat keepalive
"""

import asyncio
import json
import logging
import secrets
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Optional

import websockets
from websockets.asyncio.client import ClientConnection

logger = logging.getLogger("zajel.signaling")

# Pairing code character set (same as Dart app)
PAIRING_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PAIRING_CODE_LENGTH = 6
HEARTBEAT_INTERVAL = 30  # seconds


def generate_pairing_code() -> str:
    """Generate a random 6-character pairing code."""
    return "".join(secrets.choice(PAIRING_CODE_CHARS) for _ in range(PAIRING_CODE_LENGTH))


@dataclass
class PairRequest:
    """Incoming pair request from another peer."""

    from_code: str
    from_public_key: str
    proposed_name: Optional[str] = None


@dataclass
class PairMatch:
    """Successful pair match."""

    peer_code: str
    peer_public_key: str
    is_initiator: bool


@dataclass
class WebRTCSignal:
    """WebRTC signaling message (offer, answer, or ICE candidate)."""

    signal_type: str  # "offer", "answer", "ice_candidate"
    from_code: str
    payload: dict


@dataclass
class CallSignal:
    """Call signaling message."""

    signal_type: str  # "call_offer", "call_answer", "call_reject", "call_hangup", "call_ice"
    from_code: str
    payload: dict


@dataclass
class RendezvousMatch:
    """A rendezvous match for trusted peer reconnection."""

    peer_id: str
    relay_id: Optional[str] = None
    meeting_point: Optional[str] = None


EventHandler = Callable[..., Coroutine[Any, Any, None]]


class SignalingClient:
    """WebSocket-based signaling client for the Zajel protocol."""

    def __init__(self, url: str, pairing_code: Optional[str] = None):
        if not url.startswith(("ws://", "wss://")):
            raise ValueError(
                f"Invalid signaling URL: {url}. Must start with ws:// or wss://"
            )
        self.url = url
        self.pairing_code = pairing_code or generate_pairing_code()
        self._public_key_b64: Optional[str] = None
        self._ws: Optional[ClientConnection] = None
        self._heartbeat_task: Optional[asyncio.Task] = None
        self._receive_task: Optional[asyncio.Task] = None
        self._connected = asyncio.Event()
        self._registered = asyncio.Event()

        # Event queues
        self._pair_requests: asyncio.Queue[PairRequest] = asyncio.Queue()
        self._pair_matches: asyncio.Queue[PairMatch] = asyncio.Queue()
        self._pair_rejections: asyncio.Queue[str] = asyncio.Queue()
        self._webrtc_signals: asyncio.Queue[WebRTCSignal] = asyncio.Queue()
        self._call_signals: asyncio.Queue[CallSignal] = asyncio.Queue()
        self._rendezvous_matches: asyncio.Queue[RendezvousMatch] = asyncio.Queue()
        self._rendezvous_results: asyncio.Queue[dict] = asyncio.Queue()
        self._errors: asyncio.Queue[str] = asyncio.Queue()

        # Fast-fail event for pair_error (unblocks wait_for_pair_match)
        self._pair_error_event = asyncio.Event()
        self._last_pair_error: str = ""

        # Channel event queues
        self._chunk_pulls: asyncio.Queue[dict] = asyncio.Queue()
        self._chunk_available: asyncio.Queue[dict] = asyncio.Queue()
        self._chunk_data: asyncio.Queue[dict] = asyncio.Queue()

        # Redirect connections for cross-server pairing (mirrors Flutter app behavior)
        # Key: endpoint URL, Value: (websocket, receive_task)
        self._redirect_connections: dict[str, tuple[ClientConnection, asyncio.Task]] = {}
        # Maps a peer's code to the WebSocket that received the pairing event
        self._peer_to_ws: dict[str, ClientConnection] = {}

        # Callbacks
        self._on_pair_request: Optional[EventHandler] = None
        self._on_pair_match: Optional[EventHandler] = None
        self._on_webrtc_signal: Optional[EventHandler] = None
        self._on_call_signal: Optional[EventHandler] = None
        self._on_disconnect: Optional[EventHandler] = None
        self._on_rendezvous_result: Optional[EventHandler] = None
        self._on_chunk_pull: Optional[EventHandler] = None
        self._on_chunk_available: Optional[EventHandler] = None
        self._on_chunk_data: Optional[EventHandler] = None

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._connected.is_set()

    async def connect(self, public_key_b64: str) -> str:
        """Connect to the signaling server and register.

        Args:
            public_key_b64: Our X25519 public key (base64).

        Returns:
            Our pairing code.
        """
        if self.url.startswith("ws://"):
            logger.warning(
                "INSECURE: Using unencrypted WebSocket connection to %s. "
                "Signaling traffic (including public keys and pairing codes) "
                "will be visible to network observers. Use wss:// in production.",
                self.url,
            )
        elif not self.url.startswith("wss://"):
            raise ValueError(
                f"Invalid signaling URL scheme: {self.url}. "
                "Use wss:// for secure connections or ws:// for local development."
            )

        self._public_key_b64 = public_key_b64
        logger.info("Connecting to %s with code %s", self.url, self.pairing_code)
        self._ws = await websockets.connect(self.url)
        self._connected.set()

        # Start message receiver
        self._receive_task = asyncio.create_task(self._receive_loop())

        # Register and wait for server confirmation
        await self._send({
            "type": "register",
            "pairingCode": self.pairing_code,
            "publicKey": public_key_b64,
        })

        # Wait for 'registered' response so redirect tasks can be created
        try:
            await asyncio.wait_for(self._registered.wait(), timeout=10)
        except asyncio.TimeoutError:
            logger.warning("Timed out waiting for registered response from %s", self.url)

        # Start heartbeat
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        logger.info("Connected and registered as %s", self.pairing_code)
        return self.pairing_code

    async def disconnect(self) -> None:
        """Disconnect from the signaling server."""
        logger.info("Disconnecting from signaling server")
        await self._close_redirect_connections()
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None
        if self._ws:
            await self._ws.close()
            self._ws = None
        self._connected.clear()

    # ── Redirect connections (cross-server pairing) ────────

    async def connect_to_redirect(self, endpoint: str) -> None:
        """Connect to a redirect server and register our pairing code there.

        Called automatically when the server includes redirects in the
        registered response.  Can also be called explicitly to register
        on additional servers (e.g. when federation hasn't propagated yet).
        """
        if endpoint in self._redirect_connections:
            return  # Already connected
        try:
            ws = await websockets.connect(endpoint)
            await self._send({
                "type": "register",
                "pairingCode": self.pairing_code,
                "publicKey": self._public_key_b64,
            }, ws=ws)

            # Start receiving messages from this redirect connection
            task = asyncio.create_task(self._redirect_receive_loop(endpoint, ws))
            self._redirect_connections[endpoint] = (ws, task)
            logger.info("Registered on redirect server %s", endpoint)
        except Exception as e:
            logger.warning("Failed to connect to redirect %s: %s", endpoint, e)

    async def _redirect_receive_loop(self, endpoint: str, ws: ClientConnection) -> None:
        """Receive messages from a redirect server and route to main handlers."""
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    await self._handle_message(msg, source_ws=ws)
                except json.JSONDecodeError:
                    logger.warning("Non-JSON from redirect %s: %s", endpoint, raw[:100])
        except websockets.ConnectionClosed:
            logger.info("Redirect connection to %s closed", endpoint)
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.warning("Redirect receive error from %s: %s", endpoint, e)
        finally:
            self._redirect_connections.pop(endpoint, None)

    async def _close_redirect_connections(self) -> None:
        """Close all redirect connections."""
        for endpoint, (ws, task) in list(self._redirect_connections.items()):
            task.cancel()
            try:
                await ws.close()
            except Exception:
                pass
        self._redirect_connections.clear()
        self._peer_to_ws.clear()

    # ── Pairing ──────────────────────────────────────────────

    async def pair_with(self, target_code: str, proposed_name: Optional[str] = None) -> None:
        """Send a pair request to another peer."""
        self._pair_error_event.clear()
        msg: dict[str, Any] = {
            "type": "pair_request",
            "targetCode": target_code,
        }
        if proposed_name:
            msg["proposedName"] = proposed_name
        await self._send(msg)
        logger.info("Sent pair request to %s", target_code)

    async def respond_to_pair(self, target_code: str, accept: bool) -> None:
        """Accept or reject an incoming pair request."""
        await self._send_to_peer(target_code, {
            "type": "pair_response",
            "targetCode": target_code,
            "accepted": accept,
        })
        logger.info("Responded to pair from %s: %s", target_code, "accept" if accept else "reject")

    async def wait_for_pair_request(self, timeout: float = 60) -> PairRequest:
        """Wait for an incoming pair request."""
        return await asyncio.wait_for(self._pair_requests.get(), timeout=timeout)

    async def wait_for_pair_match(self, timeout: float = 60) -> PairMatch:
        """Wait for a pair match (after both sides accept).

        Also monitors for pair_error to fail fast instead of waiting for
        the full timeout when the target code doesn't exist on this server.
        """
        match_task = asyncio.create_task(self._pair_matches.get())
        error_task = asyncio.create_task(self._pair_error_event.wait())

        done, pending = await asyncio.wait(
            {match_task, error_task},
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()

        if not done:
            raise asyncio.TimeoutError("Timed out waiting for pair match")

        completed = done.pop()
        if completed is error_task:
            self._pair_error_event.clear()
            raise RuntimeError(f"Pair error: {self._last_pair_error}")

        return completed.result()

    # ── WebRTC Signaling ─────────────────────────────────────

    async def send_offer(self, target: str, sdp: str) -> None:
        """Send a WebRTC offer."""
        await self._send_to_peer(target, {
            "type": "offer",
            "target": target,
            "payload": {"type": "offer", "sdp": sdp},
        })

    async def send_answer(self, target: str, sdp: str) -> None:
        """Send a WebRTC answer."""
        await self._send_to_peer(target, {
            "type": "answer",
            "target": target,
            "payload": {"type": "answer", "sdp": sdp},
        })

    async def send_ice_candidate(self, target: str, candidate: dict) -> None:
        """Send an ICE candidate."""
        await self._send_to_peer(target, {
            "type": "ice_candidate",
            "target": target,
            "payload": candidate,
        })

    async def wait_for_webrtc_signal(self, timeout: float = 30) -> WebRTCSignal:
        """Wait for a WebRTC signal (offer, answer, or ICE)."""
        return await asyncio.wait_for(self._webrtc_signals.get(), timeout=timeout)

    # ── Call Signaling ───────────────────────────────────────

    async def send_call_offer(
        self, call_id: str, target: str, sdp: str, with_video: bool
    ) -> None:
        """Send a call offer."""
        await self._send({
            "type": "call_offer",
            "target": target,
            "payload": {
                "callId": call_id,
                "sdp": sdp,
                "withVideo": with_video,
            },
        })

    async def send_call_answer(self, call_id: str, target: str, sdp: str) -> None:
        """Send a call answer."""
        await self._send({
            "type": "call_answer",
            "target": target,
            "payload": {"callId": call_id, "sdp": sdp},
        })

    async def send_call_reject(
        self, call_id: str, target: str, reason: str = "declined"
    ) -> None:
        """Send a call rejection."""
        await self._send({
            "type": "call_reject",
            "target": target,
            "payload": {"callId": call_id, "reason": reason},
        })

    async def send_call_hangup(self, call_id: str, target: str) -> None:
        """Send a call hangup."""
        await self._send({
            "type": "call_hangup",
            "target": target,
            "payload": {"callId": call_id},
        })

    async def send_call_ice(self, call_id: str, target: str, candidate: str) -> None:
        """Send a call ICE candidate."""
        await self._send({
            "type": "call_ice",
            "target": target,
            "payload": {"callId": call_id, "candidate": candidate},
        })

    async def wait_for_call_signal(self, timeout: float = 30) -> CallSignal:
        """Wait for a call signal."""
        return await asyncio.wait_for(self._call_signals.get(), timeout=timeout)

    # ── Rendezvous ───────────────────────────────────────────

    async def register_rendezvous(
        self,
        peer_id: str,
        daily_points: list[str],
        hourly_tokens: list[str],
        dead_drops: Optional[dict] = None,
    ) -> None:
        """Register meeting points for trusted peer reconnection."""
        await self._send({
            "type": "register_rendezvous",
            "peerId": peer_id,
            "daily_points": daily_points,
            "hourly_tokens": hourly_tokens,
            "dead_drops": dead_drops or {},
        })

    async def wait_for_rendezvous_match(self, timeout: float = 60) -> RendezvousMatch:
        """Wait for a rendezvous match."""
        return await asyncio.wait_for(self._rendezvous_matches.get(), timeout=timeout)

    async def wait_for_rendezvous_result(self, timeout: float = 60) -> dict:
        """Wait for a full rendezvous result (includes dead drops and live matches)."""
        return await asyncio.wait_for(self._rendezvous_results.get(), timeout=timeout)

    # ── Channel Signaling ───────────────────────────────────

    async def send_channel_owner_register(self, channel_id: str) -> None:
        """Register as owner of a channel."""
        await self._send({
            "type": "channel-owner-register",
            "channelId": channel_id,
        })

    async def send_channel_subscribe(self, channel_id: str) -> None:
        """Subscribe to a channel."""
        await self._send({
            "type": "channel-subscribe",
            "channelId": channel_id,
        })

    async def send_chunk_announce(
        self, peer_id: str, channel_id: str, chunks: list[dict]
    ) -> None:
        """Announce that we have chunks available."""
        await self._send({
            "type": "chunk_announce",
            "peerId": peer_id,
            "channelId": channel_id,
            "chunks": chunks,
        })

    async def send_chunk_push(
        self, chunk_id: str, channel_id: str, data: dict
    ) -> None:
        """Push chunk data in response to a chunk_pull."""
        await self._send({
            "type": "chunk_push",
            "peerId": self.pairing_code,
            "chunkId": chunk_id,
            "channelId": channel_id,
            "data": data,
        })

    async def send_chunk_request(
        self, peer_id: str, chunk_id: str, channel_id: str
    ) -> None:
        """Request a chunk from the relay."""
        await self._send({
            "type": "chunk_request",
            "peerId": peer_id,
            "chunkId": chunk_id,
            "channelId": channel_id,
        })

    async def wait_for_chunk_pull(self, timeout: float = 30) -> dict:
        """Wait for a chunk_pull from the server."""
        return await asyncio.wait_for(self._chunk_pulls.get(), timeout=timeout)

    async def wait_for_chunk_available(self, timeout: float = 30) -> dict:
        """Wait for a chunk_available notification."""
        return await asyncio.wait_for(self._chunk_available.get(), timeout=timeout)

    async def wait_for_chunk_data(self, timeout: float = 30) -> dict:
        """Wait for chunk_data delivery."""
        return await asyncio.wait_for(self._chunk_data.get(), timeout=timeout)

    # ── Internal ─────────────────────────────────────────────

    async def send_raw(self, msg: dict) -> None:
        """Send a raw JSON message to the signaling server."""
        await self._send(msg)

    async def _send(self, msg: dict, ws: Optional[ClientConnection] = None) -> None:
        target_ws = ws or self._ws
        if target_ws is None:
            raise RuntimeError("Not connected")
        data = json.dumps(msg)
        logger.debug("TX: %s", data[:200])
        await target_ws.send(data)

    async def _send_to_peer(self, peer_code: str, msg: dict) -> None:
        """Send a message through the connection associated with the peer."""
        ws = self._peer_to_ws.get(peer_code, self._ws)
        await self._send(msg, ws=ws)

    async def _heartbeat_loop(self) -> None:
        try:
            while self._connected.is_set():
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                if self._ws:
                    await self._send({"type": "ping"})
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Heartbeat error: %s", e)

    async def _reconnect(self) -> None:
        """Reconnect to the signaling server and re-register."""
        if self._public_key_b64 is None:
            raise RuntimeError("Cannot reconnect: no stored public key")

        logger.info("Reconnecting to %s...", self.url)
        self._ws = await websockets.connect(self.url)
        self._connected.set()

        # Re-register with the same pairing code
        await self._send({
            "type": "register",
            "pairingCode": self.pairing_code,
            "publicKey": self._public_key_b64,
        })

        # Restart heartbeat
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        logger.info("Reconnected and re-registered as %s", self.pairing_code)

    async def _receive_loop(self) -> None:
        backoff = 1
        max_backoff = 60

        while True:
            try:
                async for raw in self._ws:
                    backoff = 1  # Reset on successful message
                    try:
                        msg = json.loads(raw)
                        await self._handle_message(msg)
                    except json.JSONDecodeError:
                        logger.warning("Non-JSON message: %s", raw[:100])
            except websockets.ConnectionClosed:
                logger.warning("WebSocket closed, reconnecting in %ds...", backoff)
            except asyncio.CancelledError:
                return  # Intentional shutdown
            except Exception as e:
                logger.error("Receive loop error: %s, reconnecting in %ds...", e, backoff)

            self._connected.clear()

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, max_backoff)

            try:
                await self._reconnect()
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.error("Reconnect failed: %s", e)
                continue

    async def _handle_message(self, msg: dict, source_ws: Optional[ClientConnection] = None) -> None:
        msg_type = msg.get("type", "")
        logger.debug("RX: %s", msg_type)

        try:
            match msg_type:
                case "registered":
                    self._registered.set()
                    # Handle redirects for cross-server pairing
                    redirects = msg.get("redirects", [])
                    if redirects and self._public_key_b64:
                        for redir in redirects:
                            endpoint = redir.get("endpoint", "")
                            if endpoint:
                                asyncio.create_task(
                                    self.connect_to_redirect(endpoint)
                                )

                case "pong":
                    pass  # Heartbeat response

                case "pair_incoming":
                    if not all(k in msg for k in ("fromCode", "fromPublicKey")):
                        logger.warning("Malformed pair_incoming: missing required fields")
                        return
                    from_code = msg["fromCode"]
                    # Track which connection this peer's event came from
                    if source_ws is not None:
                        self._peer_to_ws[from_code] = source_ws
                    req = PairRequest(
                        from_code=from_code,
                        from_public_key=msg["fromPublicKey"],
                        proposed_name=msg.get("proposedName"),
                    )
                    await self._pair_requests.put(req)
                    if self._on_pair_request:
                        await self._on_pair_request(req)

                case "pair_matched":
                    if not all(k in msg for k in ("peerCode", "peerPublicKey", "isInitiator")):
                        logger.warning("Malformed pair_matched: missing required fields")
                        return
                    peer_code = msg["peerCode"]
                    if source_ws is not None:
                        self._peer_to_ws[peer_code] = source_ws
                    pair_match = PairMatch(
                        peer_code=peer_code,
                        peer_public_key=msg["peerPublicKey"],
                        is_initiator=msg["isInitiator"],
                    )
                    await self._pair_matches.put(pair_match)
                    if self._on_pair_match:
                        await self._on_pair_match(pair_match)

                case "pair_rejected":
                    if "peerCode" not in msg:
                        logger.warning("Malformed pair_rejected: missing peerCode")
                        return
                    await self._pair_rejections.put(msg["peerCode"])

                case "pair_timeout":
                    logger.warning("Pair timeout for %s", msg.get("peerCode"))

                case "pair_error":
                    logger.error("Pair error: %s", msg.get("error"))
                    self._last_pair_error = msg.get("error", "unknown")
                    self._pair_error_event.set()
                    await self._errors.put(msg.get("error", "unknown"))

                case "offer" | "answer" | "ice_candidate":
                    if not all(k in msg for k in ("from", "payload")):
                        logger.warning("Malformed %s: missing required fields", msg_type)
                        return
                    from_code = msg["from"]
                    if source_ws is not None and from_code not in self._peer_to_ws:
                        self._peer_to_ws[from_code] = source_ws
                    signal = WebRTCSignal(
                        signal_type=msg_type,
                        from_code=from_code,
                        payload=msg["payload"],
                    )
                    await self._webrtc_signals.put(signal)
                    if self._on_webrtc_signal:
                        await self._on_webrtc_signal(signal)

                case "call_offer" | "call_answer" | "call_reject" | "call_hangup" | "call_ice":
                    if not all(k in msg for k in ("from", "payload")):
                        logger.warning("Malformed %s: missing required fields", msg_type)
                        return
                    signal = CallSignal(
                        signal_type=msg_type,
                        from_code=msg["from"],
                        payload=msg["payload"],
                    )
                    await self._call_signals.put(signal)
                    if self._on_call_signal:
                        await self._on_call_signal(signal)

                case "rendezvous_result":
                    for m in msg.get("liveMatches", []):
                        await self._rendezvous_matches.put(
                            RendezvousMatch(peer_id=m["peerId"], relay_id=m.get("relayId"))
                        )
                    # Queue the full result (including dead drops)
                    await self._rendezvous_results.put(msg)
                    if self._on_rendezvous_result:
                        await self._on_rendezvous_result(msg)

                case "rendezvous_partial":
                    local = msg.get("local", {})
                    for m in local.get("liveMatches", []):
                        await self._rendezvous_matches.put(
                            RendezvousMatch(peer_id=m["peerId"], relay_id=m.get("relayId"))
                        )
                    # Queue as rendezvous result too (including dead drops)
                    await self._rendezvous_results.put(local)
                    if self._on_rendezvous_result:
                        await self._on_rendezvous_result(local)

                case "rendezvous_match":
                    m = msg.get("match", msg)
                    await self._rendezvous_matches.put(
                        RendezvousMatch(
                            peer_id=m["peerId"],
                            relay_id=m.get("relayId"),
                            meeting_point=m.get("meetingPoint"),
                        )
                    )

                case "channel-owner-registered":
                    logger.info("Registered as channel owner: %s", msg.get("channelId"))

                case "channel-subscribed":
                    logger.info("Subscribed to channel: %s", msg.get("channelId"))

                case "chunk_announce_ack":
                    logger.debug("Chunk announce ack: %s chunks", msg.get("registered"))

                case "chunk_pull":
                    await self._chunk_pulls.put(msg)
                    if self._on_chunk_pull:
                        await self._on_chunk_pull(msg)

                case "chunk_available":
                    await self._chunk_available.put(msg)
                    if self._on_chunk_available:
                        await self._on_chunk_available(msg)

                case "chunk_data":
                    await self._chunk_data.put(msg)
                    if self._on_chunk_data:
                        await self._on_chunk_data(msg)

                case "chunk_pulling":
                    logger.debug("Chunk pulling: %s", msg.get("chunkId"))

                case "chunk_push_ack":
                    logger.debug("Chunk push ack: %s", msg.get("chunkId"))

                case "chunk_error":
                    logger.warning("Chunk error for %s: %s", msg.get("chunkId"), msg.get("error"))

                case "error":
                    logger.error("Server error: %s", msg.get("message"))
                    await self._errors.put(msg.get("message", "unknown"))

                case _:
                    logger.debug("Unhandled message type: %s", msg_type)
        except (KeyError, TypeError, ValueError) as e:
            logger.warning(
                "Error processing %s message: %s", msg_type, e
            )
