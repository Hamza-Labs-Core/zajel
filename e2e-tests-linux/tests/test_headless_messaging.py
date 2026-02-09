"""
E2E tests for messaging between the Flutter Linux app and headless client.

Tests sending and receiving messages where Alice (Flutter Linux app)
chats with Bob (headless client). The headless client can verify received
messages programmatically and send messages that Alice sees in the UI.
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.headless
@pytest.mark.messaging
class TestHeadlessMessaging:
    """Messaging tests using headless client as the peer."""

    def _pair_alice_with_headless_bob(self, alice, headless_bob):
        """Helper: pair Alice (Linux app) with Bob (headless) and open chat."""
        # Alice navigates to Connect screen
        alice.navigate_to_connect()
        alice.get_pairing_code_from_connect_screen()

        # Alice enters Bob's (headless) code
        alice.enter_peer_code(headless_bob.pairing_code)

        # Wait for pairing and WebRTC connection
        time.sleep(P2P_CONNECTION_TIMEOUT)

        alice.go_back_to_home()
        time.sleep(3)

        assert alice.is_peer_connected(), "Pairing with headless client must succeed"

        # Alice opens chat with the connected peer
        alice.open_chat_with_peer()
        time.sleep(2)

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_send_message_to_headless(self, alice, headless_bob):
        """Alice sends a message → headless Bob receives it."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        # Alice sends a message
        alice.send_message("Hello from Linux Alice!")
        time.sleep(3)

        # Verify Alice sees her own message
        assert alice.has_message("Hello from Linux Alice!")

        # Bob (headless) should receive the message
        msg = headless_bob.receive_message(timeout=15)
        assert msg.content == "Hello from Linux Alice!"

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_receive_message_from_headless(self, alice, headless_bob):
        """Headless Bob sends a message → Alice sees it in the UI."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        # Bob (headless) sends a message
        peer_id = headless_bob.connected_peer.peer_id
        headless_bob.send_text(peer_id, "Hello from HeadlessBob!")

        # Wait for message to arrive and render
        time.sleep(5)

        # Alice should see Bob's message in the chat
        assert alice.has_message("Hello from HeadlessBob!")

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_bidirectional_messaging(self, alice, headless_bob):
        """Alice and headless Bob exchange messages bidirectionally."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        peer_id = headless_bob.connected_peer.peer_id

        # Alice sends first message
        alice.send_message("Message 1 from Alice")
        time.sleep(3)

        # Bob receives and replies
        msg1 = headless_bob.receive_message(timeout=15)
        assert msg1.content == "Message 1 from Alice"

        headless_bob.send_text(peer_id, "Reply 1 from Bob")
        time.sleep(5)

        # Alice sees Bob's reply
        assert alice.has_message("Reply 1 from Bob")

        # Alice sends another
        alice.send_message("Message 2 from Alice")
        time.sleep(3)

        msg2 = headless_bob.receive_message(timeout=15)
        assert msg2.content == "Message 2 from Alice"

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_long_message(self, alice, headless_bob):
        """Headless Bob sends a long message → Alice receives it intact."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        peer_id = headless_bob.connected_peer.peer_id
        long_text = "A" * 500

        headless_bob.send_text(peer_id, long_text)
        time.sleep(5)

        # Alice should see the message (check for a distinctive substring)
        assert alice.has_message("AAAAA")
