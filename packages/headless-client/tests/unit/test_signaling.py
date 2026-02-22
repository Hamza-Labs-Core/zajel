"""Tests for signaling client message parsing."""

import asyncio
import time

import pytest
from zajel.signaling import (
    generate_pairing_code, PAIRING_CODE_CHARS, PAIRING_CODE_LENGTH,
    PairRequest, SignalingClient,
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
        from zajel.signaling import PairMatch
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
