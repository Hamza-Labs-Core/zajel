"""
E2E tests for messaging between the Flutter Windows app and headless client.

Tests sending and receiving messages where Alice (Flutter Windows app)
chats with Bob (headless client).
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.headless
@pytest.mark.messaging
class TestHeadlessMessaging:
    """Messaging tests using headless client as the peer."""

    def _pair_alice_with_headless_bob(self, alice, headless_bob):
        """Helper: pair Alice (Windows app) with Bob (headless) and open chat."""
        alice.navigate_to_connect()
        alice.get_pairing_code_from_connect_screen()
        alice.enter_peer_code(headless_bob.pairing_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        alice.go_back_to_home()
        time.sleep(3)

        assert alice.is_peer_connected(), "Pairing with headless client must succeed"

        alice.open_chat_with_peer()
        time.sleep(2)

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_send_message_to_headless(self, alice, headless_bob):
        """Alice sends a message → headless Bob receives it."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        alice.send_message("Hello from Windows Alice!")
        time.sleep(3)

        assert alice.has_message("Hello from Windows Alice!")

        msg = headless_bob.receive_message(timeout=15)
        assert msg.content == "Hello from Windows Alice!"

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_receive_message_from_headless(self, alice, headless_bob):
        """Headless Bob sends a message → Alice sees it in the UI."""
        self._pair_alice_with_headless_bob(alice, headless_bob)

        peer_id = headless_bob.connected_peer.peer_id
        headless_bob.send_text(peer_id, "Hello from HeadlessBob!")

        time.sleep(5)

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

        msg1 = headless_bob.receive_message(timeout=15)
        assert msg1.content == "Message 1 from Alice"

        # Bob replies
        headless_bob.send_text(peer_id, "Reply 1 from Bob")
        time.sleep(5)

        assert alice.has_message("Reply 1 from Bob")
