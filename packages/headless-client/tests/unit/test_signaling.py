"""Tests for signaling client message parsing."""

import asyncio
import contextlib
import json
import time

import pytest
from zajel.signaling import (
    generate_pairing_code, PAIRING_CODE_CHARS, PAIRING_CODE_LENGTH,
    PairMatch, PairRequest, SignalingClient,
)


class TestPairingCode:
    def test_length(self):
        code = generate_pairing_code()
        assert len(code) == PAIRING_CODE_LENGTH

    def test_valid_characters(self):
        for _ in range(100):
            code = generate_pairing_code()
            for char in code:
                assert char in PAIRING_CODE_CHARS

    def test_no_ambiguous_characters(self):
        for _ in range(100):
            code = generate_pairing_code()
            assert "0" not in code
            assert "O" not in code
            assert "1" not in code
            assert "I" not in code

    def test_randomness(self):
        codes = {generate_pairing_code() for _ in range(100)}
        # Should generate mostly unique codes
        assert len(codes) > 90


class TestPairErrorFastFail:
    """wait_for_pair_match should fail fast when pair_error arrives."""

    @pytest.mark.asyncio
    async def test_pair_error_unblocks_wait(self):
        """pair_error event should cause wait_for_pair_match to raise immediately."""
        client = SignalingClient("ws://localhost:9999")

        # Simulate pair_error arriving after a short delay
        async def send_error():
            await asyncio.sleep(0.1)
            client._last_pair_error = "code not found"
            client._pair_error_event.set()

        asyncio.create_task(send_error())

        start = time.monotonic()
        with pytest.raises(RuntimeError, match="Pair error"):
            await client.wait_for_pair_match(timeout=30)
        elapsed = time.monotonic() - start

        # Should complete in well under 1 second (not wait 30s)
        assert elapsed < 2.0

    @pytest.mark.asyncio
    async def test_pair_match_still_works(self):
        """Normal pair_match should still be returned correctly."""
        client = SignalingClient("ws://localhost:9999")

        match = PairMatch(peer_code="ABC123", peer_public_key="key", is_initiator=True)
        async def send_match():
            await asyncio.sleep(0.1)
            await client._pair_matches.put(match)

        asyncio.create_task(send_match())
        result = await client.wait_for_pair_match(timeout=5)
        assert result.peer_code == "ABC123"

    @pytest.mark.asyncio
    async def test_pair_with_clears_error_state(self):
        """pair_with should clear the error event before sending."""
        client = SignalingClient("ws://localhost:9999")
        client._pair_error_event.set()
        client._last_pair_error = "stale error"

        # pair_with calls _send which will fail (no connection),
        # but the error event should be cleared first
        try:
            await client.pair_with("TARGET")
        except Exception:
            pass  # Expected: no connection

        assert not client._pair_error_event.is_set()


class TestRedirectHandling:
    """Tests for DHT redirect connection handling."""

    @pytest.mark.asyncio
    async def test_registered_with_no_redirects(self):
        """registered message with no redirects should not create connections."""
        client = SignalingClient("ws://localhost:9999")
        client._public_key_b64 = "testkey123"

        await client._handle_message({"type": "registered"})

        assert client._registered.is_set()
        assert len(client._redirect_connections) == 0

    @pytest.mark.asyncio
    async def test_registered_with_empty_redirects(self):
        """registered message with empty redirects list should not connect."""
        client = SignalingClient("ws://localhost:9999")
        client._public_key_b64 = "testkey123"

        await client._handle_message({
            "type": "registered",
            "redirects": [],
        })

        assert client._registered.is_set()
        assert len(client._redirect_connections) == 0

    @pytest.mark.asyncio
    async def test_peer_to_ws_tracking_on_pair_incoming(self):
        """pair_incoming from a redirect should track the source websocket."""
        client = SignalingClient("ws://localhost:9999")

        # Create a mock websocket object
        mock_ws = object()

        await client._handle_message({
            "type": "pair_incoming",
            "fromCode": "PEER42",
            "fromPublicKey": "peerkey",
        }, source_ws=mock_ws)

        assert "PEER42" in client._peer_to_ws
        assert client._peer_to_ws["PEER42"] is mock_ws

    @pytest.mark.asyncio
    async def test_peer_to_ws_tracking_on_pair_matched(self):
        """pair_matched from a redirect should track the source websocket."""
        client = SignalingClient("ws://localhost:9999")
        mock_ws = object()

        await client._handle_message({
            "type": "pair_matched",
            "peerCode": "PEER99",
            "peerPublicKey": "peerkey",
            "isInitiator": True,
        }, source_ws=mock_ws)

        assert "PEER99" in client._peer_to_ws
        assert client._peer_to_ws["PEER99"] is mock_ws

    @pytest.mark.asyncio
    async def test_peer_to_ws_not_set_without_source(self):
        """Messages from the main connection (source_ws=None) should not add to map."""
        client = SignalingClient("ws://localhost:9999")

        await client._handle_message({
            "type": "pair_incoming",
            "fromCode": "PEER42",
            "fromPublicKey": "peerkey",
        })

        assert "PEER42" not in client._peer_to_ws

    @pytest.mark.asyncio
    async def test_send_to_peer_uses_tracked_ws(self):
        """_send_to_peer should use the tracked websocket for known peers."""
        client = SignalingClient("ws://localhost:9999")

        sent_on = []

        async def mock_send(msg, ws=None):
            sent_on.append(ws)

        client._send = mock_send

        mock_ws = object()
        client._peer_to_ws["PEER42"] = mock_ws

        await client._send_to_peer("PEER42", {"type": "test"})

        assert len(sent_on) == 1
        assert sent_on[0] is mock_ws

    @pytest.mark.asyncio
    async def test_send_to_peer_falls_back_to_main_ws(self):
        """_send_to_peer should fall back to main ws for unknown peers."""
        client = SignalingClient("ws://localhost:9999")
        main_ws = object()
        client._ws = main_ws

        sent_on = []

        async def mock_send(msg, ws=None):
            sent_on.append(ws)

        client._send = mock_send

        await client._send_to_peer("UNKNOWN", {"type": "test"})

        assert len(sent_on) == 1
        assert sent_on[0] is main_ws

    @pytest.mark.asyncio
    async def test_close_redirect_connections_clears_state(self):
        """_close_redirect_connections should clear all tracking state."""
        client = SignalingClient("ws://localhost:9999")
        client._peer_to_ws["PEER1"] = object()
        client._peer_to_ws["PEER2"] = object()

        await client._close_redirect_connections()

        assert len(client._redirect_connections) == 0
        assert len(client._peer_to_ws) == 0

    @pytest.mark.asyncio
    async def test_pair_with_tries_redirect_on_error(self):
        """pair_with should try redirect connections when main returns pair_error."""
        client = SignalingClient("ws://localhost:9999")
        main_ws = object()
        redirect_ws = object()
        client._ws = main_ws

        # Add a redirect connection
        noop_task = asyncio.create_task(asyncio.sleep(999))
        client._redirect_connections["ws://other:9000"] = (redirect_ws, noop_task)

        sent_messages = []

        async def mock_send(msg, ws=None):
            sent_messages.append((msg, ws))
            # Simulate pair_error on main, success on redirect
            if ws is None or ws is main_ws:
                client._last_pair_error = "code not found"
                client._pair_error_event.set()

        client._send = mock_send

        await client.pair_with("TARGET")
        noop_task.cancel()

        # Should have sent to main ws first, then redirect ws
        assert len(sent_messages) == 2
        assert sent_messages[0][1] is None or sent_messages[0][1] is main_ws
        assert sent_messages[1][1] is redirect_ws

    @pytest.mark.asyncio
    async def test_pair_with_stops_on_success(self):
        """pair_with should stop trying after a connection accepts."""
        client = SignalingClient("ws://localhost:9999")
        main_ws = object()
        redirect_ws = object()
        client._ws = main_ws

        noop_task = asyncio.create_task(asyncio.sleep(999))
        client._redirect_connections["ws://other:9000"] = (redirect_ws, noop_task)

        sent_messages = []

        async def mock_send(msg, ws=None):
            sent_messages.append((msg, ws))
            # Main server accepts (no pair_error) — don't set error event

        client._send = mock_send

        await client.pair_with("TARGET")
        noop_task.cancel()

        # Should only send to main (which accepted)
        assert len(sent_messages) == 1

    @pytest.mark.asyncio
    async def test_connect_to_redirect_waits_past_server_info(self):
        """connect_to_redirect must wait for 'registered' even when server sends
        'server_info' first.

        The VPS always sends server_info immediately on connection (before
        processing the register message).  If connect_to_redirect() treats the
        first message as the registration confirmation it will return before the
        server has stored the pairing code, causing subsequent pair_request
        messages to get "Not registered" errors.
        """
        client = SignalingClient("wss://localhost:9999")
        client._public_key_b64 = "dGVzdGtleQ=="  # valid base64 for "testkey"

        class FakeWs:
            """Simulates a VPS WebSocket that sends server_info before registered."""

            def __init__(self):
                self._messages = asyncio.Queue()
                # Queue server_info first, then registered — exactly what VPS does
                self._messages.put_nowait(json.dumps({
                    "type": "server_info",
                    "serverId": "vps-1",
                    "endpoint": "wss://65.21.54.26:8443",
                    "region": None,
                }))
                self._messages.put_nowait(json.dumps({
                    "type": "registered",
                    "pairingCode": client.pairing_code,
                    "serverId": "vps-1",
                }))

            async def send(self, data):
                pass  # swallow the register message

            async def recv(self):
                # Simulate network latency between messages
                await asyncio.sleep(0.01)
                return await self._messages.get()

            async def close(self):
                pass

            async def __aiter__(self):
                # Never yields — keeps receive loop alive until cancelled
                while True:
                    await asyncio.sleep(999)

        fake_ws = FakeWs()

        async def fake_connect(endpoint, **kwargs):
            return fake_ws

        # Patch websockets.connect used by connect_to_redirect
        import sys
        sig_module = sys.modules["zajel.signaling"]
        original_connect = sig_module.websockets.connect
        sig_module.websockets.connect = fake_connect

        try:
            await client.connect_to_redirect("wss://65.21.54.26:8443")
        finally:
            sig_module.websockets.connect = original_connect
            # Cancel the receive task to avoid ResourceWarning
            if "wss://65.21.54.26:8443" in client._redirect_connections:
                _, task = client._redirect_connections["wss://65.21.54.26:8443"]
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

        # The redirect connection must be registered AFTER receiving 'registered',
        # not after receiving 'server_info'. If the bug is present,
        # connect_to_redirect() returns as soon as server_info arrives and the
        # registration is NOT confirmed — meaning pair_request sent immediately
        # after will hit "Not registered" on the server.
        #
        # We verify this by checking that connect_to_redirect() correctly waited
        # for the 'registered' message: the FakeWs queues server_info then
        # registered, so if we only consumed server_info the registered
        # message would still be in the queue.
        remaining = fake_ws._messages.qsize()
        assert remaining == 0, (
            f"connect_to_redirect() exited after server_info without waiting for "
            f"'registered'. {remaining} message(s) still in queue. "
            "This is the race condition that causes 'Not registered' errors when "
            "pair_request is sent immediately after connect_to_redirect() returns."
        )


class TestEnsureRegistered:
    """Tests for the ensure_registered recovery mechanism."""

    @pytest.mark.asyncio
    async def test_ensure_registered_sends_register_and_waits(self):
        """ensure_registered should re-send register and wait for confirmation."""
        client = SignalingClient("ws://localhost:9999")
        client._public_key_b64 = "dGVzdGtleQ=="
        client.pairing_code = "TESTCODE"

        sent_messages = []

        async def mock_send(msg, ws=None):
            sent_messages.append(msg)
            # Simulate server responding with 'registered' after a short delay
            if msg.get("type") == "register":
                await asyncio.sleep(0.01)
                client._registered.set()

        client._send = mock_send
        # Mark as connected so _send doesn't complain
        client._connected.set()

        await client.ensure_registered()

        assert len(sent_messages) == 1
        assert sent_messages[0]["type"] == "register"
        assert sent_messages[0]["pairingCode"] == "TESTCODE"
        assert client._registered.is_set()


class TestChunkRequestMeta:
    """Tests for chunk_request_meta signaling support."""

    @pytest.mark.asyncio
    async def test_send_chunk_request_meta(self):
        """send_chunk_request_meta should send the correct message format."""
        client = SignalingClient("ws://localhost:9999")

        sent_messages = []

        async def mock_send(msg, ws=None):
            sent_messages.append(msg)

        client._send = mock_send

        await client.send_chunk_request_meta(
            peer_id="PEER42",
            routing_hash="abc123",
            sequence=5,
            chunk_index=2,
        )

        assert len(sent_messages) == 1
        msg = sent_messages[0]
        assert msg["type"] == "chunk_request_meta"
        assert msg["peerId"] == "PEER42"
        assert msg["routingHash"] == "abc123"
        assert msg["sequence"] == 5
        assert msg["chunkIndex"] == 2

    @pytest.mark.asyncio
    async def test_chunk_request_meta_response_arrives_as_chunk_data(self):
        """Server responds to chunk_request_meta with chunk_data (same as chunk_request)."""
        client = SignalingClient("ws://localhost:9999")

        # The server sends back a chunk_data message
        await client._handle_message({
            "type": "chunk_data",
            "chunkId": "chunk-abc",
            "channelId": "chan-1",
            "data": {"payload": "encrypted-data"},
        })

        # Should be available via wait_for_chunk_data (non-blocking since already queued)
        result = await asyncio.wait_for(client._chunk_data.get(), timeout=1)
        assert result["chunkId"] == "chunk-abc"
        assert result["data"]["payload"] == "encrypted-data"


class TestDeviceLinkingStubs:
    """Tests for device linking stub message handlers."""

    @pytest.mark.asyncio
    async def test_link_request_does_not_crash(self):
        """link_request message should be handled without error."""
        client = SignalingClient("ws://localhost:9999")
        await client._handle_message({
            "type": "link_request",
            "linkCode": "ABC123",
            "deviceId": "device-uuid",
        })
        # No exception = success

    @pytest.mark.asyncio
    async def test_link_response_does_not_crash(self):
        """link_response message should be handled without error."""
        client = SignalingClient("ws://localhost:9999")
        await client._handle_message({
            "type": "link_response",
            "linkCode": "ABC123",
            "accepted": True,
        })

    @pytest.mark.asyncio
    async def test_link_matched_does_not_crash(self):
        """link_matched message should be handled without error."""
        client = SignalingClient("ws://localhost:9999")
        await client._handle_message({
            "type": "link_matched",
            "linkCode": "ABC123",
            "peerCode": "XYZ789",
        })

    @pytest.mark.asyncio
    async def test_link_rejected_does_not_crash(self):
        """link_rejected message should be handled without error."""
        client = SignalingClient("ws://localhost:9999")
        await client._handle_message({
            "type": "link_rejected",
            "linkCode": "ABC123",
        })

    @pytest.mark.asyncio
    async def test_link_timeout_does_not_crash(self):
        """link_timeout message should be handled without error."""
        client = SignalingClient("ws://localhost:9999")
        await client._handle_message({
            "type": "link_timeout",
            "linkCode": "ABC123",
        })

    @pytest.mark.asyncio
    async def test_link_messages_with_missing_fields(self):
        """Device linking messages should not crash even with missing fields."""
        client = SignalingClient("ws://localhost:9999")

        # Each message type with minimal/empty fields
        for msg_type in ["link_request", "link_response", "link_matched",
                         "link_rejected", "link_timeout"]:
            await client._handle_message({"type": msg_type})
            # No exception = success
