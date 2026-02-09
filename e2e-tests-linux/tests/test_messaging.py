"""Messaging tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.messaging
class TestMessaging:
    """Tests for sending and receiving messages on Linux."""

    def _pair_instances(self, alice, bob):
        """Pair two instances."""
        alice.navigate_to_connect()
        code = alice.get_pairing_code_from_connect_screen()
        bob.navigate_to_connect()
        bob.enter_peer_code(code)

        connected = False
        for _ in range(6):
            time.sleep(P2P_CONNECTION_TIMEOUT)
            alice.go_back_to_home()
            bob.go_back_to_home()
            time.sleep(3)
            if alice.is_peer_connected() or bob.is_peer_connected():
                connected = True
                break
        assert connected

    def test_can_send_message(self, alice, bob):
        """Send a message from Alice to Bob."""
        self._pair_instances(alice, bob)

        alice.open_chat_with_peer()
        alice.send_message("Hello from Linux!")
        time.sleep(2)

        assert alice.has_message("Hello from Linux!"), \
            "Sent message should appear in sender's chat"

    def test_message_received(self, alice, bob):
        """Verify message received by the other instance."""
        self._pair_instances(alice, bob)

        alice.open_chat_with_peer()
        alice.send_message("Cross-instance msg")
        time.sleep(3)

        bob.open_chat_with_peer()
        time.sleep(2)

        assert bob.has_message("Cross-instance msg"), \
            "Message should appear on receiver's side"

    def test_bidirectional_messaging(self, alice, bob):
        """Both instances can send and receive messages."""
        self._pair_instances(alice, bob)

        alice.open_chat_with_peer()
        alice.send_message("From Alice")
        time.sleep(2)

        bob.open_chat_with_peer()
        bob.send_message("From Bob")
        time.sleep(2)

        assert alice.has_message("From Bob"), "Alice should see Bob's message"
        assert bob.has_message("From Alice"), "Bob should see Alice's message"
