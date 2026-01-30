"""
E2E tests for messaging functionality.

Tests sending and receiving messages between connected devices.
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.messaging
class TestMessaging:
    """Test suite for messaging between paired devices."""

    def _pair_devices(self, alice, bob, app_helper):
        """Helper to pair two devices via the Connect screen."""
        alice_helper = app_helper(alice)
        bob_helper = app_helper(bob)

        alice_helper.wait_for_app_ready()
        bob_helper.wait_for_app_ready()

        # Alice opens Connect screen and gets her code
        alice_helper.navigate_to_connect()
        alice_code = alice_helper.get_pairing_code_from_connect_screen()

        # Bob opens Connect screen and enters Alice's code
        bob_helper.navigate_to_connect()
        bob_helper.enter_peer_code(alice_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Go back to home screens
        alice_helper.go_back_to_home()
        bob_helper.go_back_to_home()
        time.sleep(3)

        return alice_helper, bob_helper

    @pytest.mark.slow
    def test_can_send_message_after_pairing(self, device_pair, app_helper):
        """Test sending a message after devices are paired."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        alice_helper, bob_helper = self._pair_devices(alice, bob, app_helper)

        # Verify connected
        assert alice_helper.is_peer_connected() or bob_helper.is_peer_connected()

        # Alice opens chat with the connected peer
        alice_helper.open_chat_with_peer()
        time.sleep(2)

        # Alice sends a message
        alice_helper.send_message("Hello from Alice!")
        time.sleep(3)

        # Verify Alice can see her sent message
        assert alice_helper.has_message("Hello from Alice!")

    @pytest.mark.slow
    def test_message_received_on_other_device(self, device_pair, app_helper):
        """Test that sent message is received on the other device."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        alice_helper, bob_helper = self._pair_devices(alice, bob, app_helper)

        assert alice_helper.is_peer_connected() or bob_helper.is_peer_connected()

        # Alice opens chat and sends a message
        alice_helper.open_chat_with_peer()
        time.sleep(2)
        alice_helper.send_message("Can you see this?")
        time.sleep(5)

        # Bob opens chat with Alice
        bob_helper.open_chat_with_peer()
        time.sleep(2)

        # Bob should see Alice's message
        assert bob_helper.has_message("Can you see this?")

    @pytest.mark.slow
    def test_bidirectional_messaging(self, device_pair, app_helper):
        """Test that both devices can send and receive messages."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        alice_helper, bob_helper = self._pair_devices(alice, bob, app_helper)

        assert alice_helper.is_peer_connected() or bob_helper.is_peer_connected()

        # Alice opens chat and sends message
        alice_helper.open_chat_with_peer()
        time.sleep(2)
        alice_helper.send_message("Hello Bob!")
        time.sleep(3)

        # Bob opens chat and verifies Alice's message, then replies
        bob_helper.open_chat_with_peer()
        time.sleep(2)
        assert bob_helper.has_message("Hello Bob!")

        bob_helper.send_message("Hi Alice!")
        time.sleep(3)

        # Alice should see Bob's reply
        assert alice_helper.has_message("Hi Alice!")
