"""Tests for typing indicators and delivery receipts."""

import asyncio
import json

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from zajel.client import ZajelHeadlessClient, ConnectedPeer, ReceivedMessage


# ── Helpers ────────────────────────────────────────────────────


def _make_client() -> ZajelHeadlessClient:
    """Create a client with mocked internal services for unit testing."""
    with patch("zajel.client.SignalingClient"), \
         patch("zajel.client.WebRTCService"), \
         patch("zajel.client.CryptoService"), \
         patch("zajel.client.PeerStorage"):
        client = ZajelHeadlessClient(
            signaling_url="wss://test.example.com/ws",
            name="TestBot",
        )
    # Replace services with mocks that have the right async signatures
    client._crypto = MagicMock()
    client._crypto.has_session_key = MagicMock(return_value=True)
    client._crypto.encrypt = MagicMock(return_value="encrypted_data")
    client._crypto.decrypt = MagicMock(return_value="hello")
    client._webrtc = MagicMock()
    client._webrtc.send_message = AsyncMock()
    client._events = MagicMock()
    client._events.emit = AsyncMock(return_value=[])
    return client


def _add_peer(client: ZajelHeadlessClient, peer_id: str = "peer_abc") -> None:
    """Register a connected peer in the client."""
    client._connected_peers[peer_id] = ConnectedPeer(
        peer_id=peer_id,
        public_key="fake_pub_key",
        display_name="TestPeer",
    )


def _simulate_encrypted_message(
    client: ZajelHeadlessClient, plaintext: str, peer_id: str = "peer_abc"
) -> None:
    """Simulate receiving an encrypted message that decrypts to plaintext.

    Sets up the crypto mock, peer ID, and event loop, then calls
    _on_message_channel_data with raw ciphertext (non-JSON triggers
    encrypted_text path in parse_channel_message).
    """
    client._webrtc_peer_id = peer_id
    client._crypto.decrypt.return_value = plaintext
    client._crypto.has_session_key.return_value = True
    # _on_message_channel_data checks self._loop for task creation
    client._loop = asyncio.get_event_loop()
    # Raw non-JSON string is treated as encrypted_text by parse_channel_message
    client._on_message_channel_data("some_base64_ciphertext")


# ── Typing indicator: sending ──────────────────────────────────


class TestSendTypingIndicator:
    async def test_send_typing_indicator_true(self):
        client = _make_client()
        _add_peer(client)
        await client.send_typing_indicator("peer_abc", True)
        client._crypto.encrypt.assert_called_once_with("peer_abc", "typ:1")
        client._webrtc.send_message.assert_awaited_once_with("encrypted_data")

    async def test_send_typing_indicator_false(self):
        client = _make_client()
        _add_peer(client)
        await client.send_typing_indicator("peer_abc", False)
        client._crypto.encrypt.assert_called_once_with("peer_abc", "typ:0")
        client._webrtc.send_message.assert_awaited_once_with("encrypted_data")

    async def test_send_typing_indicator_not_connected(self):
        """Should silently return when peer is not connected."""
        client = _make_client()
        # Do NOT add peer
        await client.send_typing_indicator("unknown_peer", True)
        client._crypto.encrypt.assert_not_called()
        client._webrtc.send_message.assert_not_awaited()

    async def test_send_typing_indicator_no_session_key(self):
        """Should silently return when no session key exists."""
        client = _make_client()
        _add_peer(client)
        client._crypto.has_session_key.return_value = False
        await client.send_typing_indicator("peer_abc", True)
        client._crypto.encrypt.assert_not_called()
        client._webrtc.send_message.assert_not_awaited()

    async def test_send_typing_indicator_exception_swallowed(self):
        """Exceptions should be caught and not propagated."""
        client = _make_client()
        _add_peer(client)
        client._webrtc.send_message = AsyncMock(
            side_effect=RuntimeError("network down")
        )
        # Should NOT raise
        await client.send_typing_indicator("peer_abc", True)


# ── Typing indicator: receiving ────────────────────────────────


class TestReceiveTypingIndicator:
    async def test_receive_typing_indicator_start(self):
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "typ:1")
        assert client._typing_states["peer_abc"] is True

    async def test_receive_typing_indicator_stop(self):
        client = _make_client()
        _add_peer(client)
        # First start, then stop
        _simulate_encrypted_message(client, "typ:1")
        assert client._typing_states["peer_abc"] is True
        _simulate_encrypted_message(client, "typ:0")
        assert client._typing_states["peer_abc"] is False

    async def test_is_peer_typing_default_false(self):
        client = _make_client()
        assert client.is_peer_typing("unknown_peer") is False

    async def test_typing_state_tracked(self):
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "typ:1")
        assert client.is_peer_typing("peer_abc") is True
        _simulate_encrypted_message(client, "typ:0")
        assert client.is_peer_typing("peer_abc") is False

    async def test_typing_prefix_not_queued_as_message(self):
        """typ: messages should NOT appear in the regular message queue."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "typ:1")
        assert client._message_queue.empty()

    async def test_typing_emits_event(self):
        """Receiving a typing indicator should emit a 'typing' event."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "typ:1")
        # Allow the created task to run
        await asyncio.sleep(0)
        client._events.emit.assert_called_with("typing", "peer_abc", True)


# ── Read receipt: sending ──────────────────────────────────────


class TestSendReadReceipt:
    async def test_send_read_receipt(self):
        client = _make_client()
        _add_peer(client)
        await client.send_read_receipt("peer_abc")
        client._crypto.encrypt.assert_called_once_with("peer_abc", "rcpt:r")
        client._webrtc.send_message.assert_awaited_once_with("encrypted_data")

    async def test_send_read_receipt_not_connected(self):
        """Should silently return when peer is not connected."""
        client = _make_client()
        await client.send_read_receipt("unknown_peer")
        client._crypto.encrypt.assert_not_called()
        client._webrtc.send_message.assert_not_awaited()

    async def test_send_read_receipt_no_session_key(self):
        """Should silently return when no session key exists."""
        client = _make_client()
        _add_peer(client)
        client._crypto.has_session_key.return_value = False
        await client.send_read_receipt("peer_abc")
        client._crypto.encrypt.assert_not_called()
        client._webrtc.send_message.assert_not_awaited()

    async def test_send_read_receipt_exception_swallowed(self):
        """Exceptions should be caught and not propagated."""
        client = _make_client()
        _add_peer(client)
        client._webrtc.send_message = AsyncMock(
            side_effect=RuntimeError("network down")
        )
        await client.send_read_receipt("peer_abc")


# ── Delivery receipt: receiving ────────────────────────────────


class TestReceiveReceipt:
    async def test_receive_delivery_receipt(self):
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "rcpt:d")
        peer_id, receipt_type = client._receipt_queue.get_nowait()
        assert peer_id == "peer_abc"
        assert receipt_type == "d"

    async def test_receive_read_receipt(self):
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "rcpt:r")
        peer_id, receipt_type = client._receipt_queue.get_nowait()
        assert peer_id == "peer_abc"
        assert receipt_type == "r"

    async def test_receipt_prefix_not_queued_as_message(self):
        """rcpt: messages should NOT appear in the regular message queue."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "rcpt:d")
        assert client._message_queue.empty()

    async def test_receipt_emits_event(self):
        """Receiving a receipt should emit a 'receipt' event."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "rcpt:d")
        await asyncio.sleep(0)
        client._events.emit.assert_called_with("receipt", "peer_abc", "d")

    async def test_receipt_queue_multiple(self):
        """Multiple receipts should queue in order."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "rcpt:d")
        _simulate_encrypted_message(client, "rcpt:r")
        p1, t1 = client._receipt_queue.get_nowait()
        p2, t2 = client._receipt_queue.get_nowait()
        assert t1 == "d"
        assert t2 == "r"

    async def test_wait_for_receipt(self):
        client = _make_client()
        _add_peer(client)
        # Pre-populate the queue
        client._receipt_queue.put_nowait(("peer_abc", "d"))
        peer_id, receipt_type = await client.wait_for_receipt(timeout=1)
        assert peer_id == "peer_abc"
        assert receipt_type == "d"

    async def test_wait_for_receipt_timeout(self):
        client = _make_client()
        with pytest.raises(asyncio.TimeoutError):
            await client.wait_for_receipt(timeout=0.05)


# ── Auto delivery receipt on message receive ───────────────────


class TestAutoDeliveryReceipt:
    async def test_auto_delivery_receipt_on_message(self):
        """When a regular text message is received, rcpt:d should be sent back."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "Hello, World!")

        # The message should be queued normally
        msg = client._message_queue.get_nowait()
        assert msg.content == "Hello, World!"

        # The auto delivery receipt is fired as a task; let the event loop tick
        await asyncio.sleep(0)

        # Verify encrypt was called with rcpt:d
        encrypt_calls = client._crypto.encrypt.call_args_list
        rcpt_calls = [c for c in encrypt_calls if c[0][1] == "rcpt:d"]
        assert len(rcpt_calls) == 1
        assert rcpt_calls[0][0] == ("peer_abc", "rcpt:d")

    async def test_auto_delivery_receipt_does_not_affect_queue(self):
        """The auto delivery receipt should not add anything to the receipt queue."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "Hello!")
        await asyncio.sleep(0)
        # Receipt queue should be empty — auto rcpt:d goes OUT, not IN
        assert client._receipt_queue.empty()


# ── Protocol prefix isolation ──────────────────────────────────


class TestPrefixIsolation:
    async def test_typing_prefix_not_queued_as_message(self):
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "typ:1")
        assert client._message_queue.empty()

    async def test_receipt_prefix_not_queued_as_message(self):
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "rcpt:d")
        assert client._message_queue.empty()

    async def test_regular_message_still_works(self):
        """Non-prefixed messages should still be queued normally."""
        client = _make_client()
        _add_peer(client)
        _simulate_encrypted_message(client, "Just a normal message")
        msg = client._message_queue.get_nowait()
        assert msg.content == "Just a normal message"

    async def test_ginv_prefix_still_works(self):
        """ginv: prefix should not be intercepted by typ:/rcpt: handlers."""
        client = _make_client()
        _add_peer(client)
        client._handle_group_invitation = MagicMock()
        _simulate_encrypted_message(client, "ginv:some_invitation_data")
        client._handle_group_invitation.assert_called_once_with(
            "peer_abc", "some_invitation_data"
        )
        # Should NOT be in message queue or receipt queue
        assert client._message_queue.empty()
        assert client._receipt_queue.empty()
