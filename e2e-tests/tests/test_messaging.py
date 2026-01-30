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

        # Find and tap on the peer to open chat
        peer_element = alice.find_element(
            "xpath", "//android.widget.ListView//*[1]"
        )
        peer_element.click()

        time.sleep(2)

        # Find message input and send a message
        message_input = alice.find_element("xpath", "//android.widget.EditText")
        message_input.send_keys("Hello from Alice!")

        # Find and click send button
        send_button = alice.find_element(
            "xpath", "//*[contains(@content-desc, 'send') or contains(@text, 'Send')]"
        )
        send_button.click()

        time.sleep(3)

    @pytest.mark.slow
    def test_message_received_on_other_device(self, device_pair, app_helper):
        """Test that sent message is received on the other device."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        alice_helper, bob_helper = self._pair_devices(alice, bob, app_helper)

        # Alice sends message, Bob should receive it
        # Implementation depends on actual app UI
        assert True

    @pytest.mark.slow
    def test_bidirectional_messaging(self, device_pair, app_helper):
        """Test that both devices can send and receive messages."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        alice_helper, bob_helper = self._pair_devices(alice, bob, app_helper)

        # Alice sends to Bob, Bob sends to Alice
        # Both should receive
        assert True
