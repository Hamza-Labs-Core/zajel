"""
E2E tests for messaging between the Flutter app and headless client.

Tests sending and receiving messages where Alice (Flutter app on emulator)
chats with Bob (headless client). The headless client can verify received
messages programmatically and send messages that Alice sees in the UI.
"""

import time
import pytest



@pytest.mark.headless
@pytest.mark.messaging
class TestHeadlessMessaging:
    """Messaging tests using headless client as the peer."""

    def _pair_alice_with_headless_bob(self, alice, app_helper, headless_bob):
        """Helper: pair Alice (emulator) with Bob (headless) and open chat."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Alice navigates to Connect screen
        helper.navigate_to_connect()
        helper.get_pairing_code_from_connect_screen()

        # Alice enters Bob's (headless) code
        helper.enter_peer_code(headless_bob.pairing_code)

        # Poll until connected or timeout
        assert helper.wait_for_peer_connected(timeout=60), "Pairing with headless client must succeed"

        # Alice opens chat with the connected peer
        helper.open_chat_with_peer()
        time.sleep(2)

        return helper

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_send_message_to_headless(self, alice, app_helper, headless_bob):
        """Alice sends a message → headless Bob receives it."""
        helper = self._pair_alice_with_headless_bob(alice, app_helper, headless_bob)

        # Alice sends a message
        helper.send_message("Hello from Alice!")
        time.sleep(3)

        # Verify Alice sees her own message
        assert helper.has_message("Hello from Alice!")

        # Bob (headless) should receive the message
        msg = headless_bob.receive_message(timeout=15)
        assert msg.content == "Hello from Alice!"

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_receive_message_from_headless(self, alice, app_helper, headless_bob):
        """Headless Bob sends a message → Alice sees it in the UI."""
        helper = self._pair_alice_with_headless_bob(alice, app_helper, headless_bob)

        # Bob (headless) sends a message
        peer_id = headless_bob.connected_peer.peer_id
        headless_bob.send_text(peer_id, "Hello from HeadlessBob!")

        # Wait for message to arrive and render
        time.sleep(5)

        # Alice should see Bob's message in the chat
        assert helper.has_message("Hello from HeadlessBob!")

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_bidirectional_messaging(self, alice, app_helper, headless_bob):
        """Alice and headless Bob exchange messages bidirectionally."""
        helper = self._pair_alice_with_headless_bob(alice, app_helper, headless_bob)

        peer_id = headless_bob.connected_peer.peer_id

        # Alice sends first message
        helper.send_message("Message 1 from Alice")
        time.sleep(3)

        # Bob receives and replies
        msg1 = headless_bob.receive_message(timeout=15)
        assert msg1.content == "Message 1 from Alice"

        headless_bob.send_text(peer_id, "Reply 1 from Bob")
        time.sleep(5)

        # Alice sees Bob's reply
        assert helper.has_message("Reply 1 from Bob")

        # Alice sends another
        helper.send_message("Message 2 from Alice")
        time.sleep(3)

        msg2 = headless_bob.receive_message(timeout=15)
        assert msg2.content == "Message 2 from Alice"

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_long_message(self, alice, app_helper, headless_bob):
        """Headless Bob sends a long message → Alice receives it intact."""
        helper = self._pair_alice_with_headless_bob(alice, app_helper, headless_bob)

        peer_id = headless_bob.connected_peer.peer_id
        long_text = "A" * 500  # 500 characters

        headless_bob.send_text(peer_id, long_text)
        time.sleep(5)

        # Alice should see the message (check for a distinctive substring)
        assert helper.has_message("AAAAA")
