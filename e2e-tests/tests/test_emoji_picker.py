"""Tests for the filtered emoji picker."""

import time
import pytest
from conftest import AppHelper
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.emoji
class TestEmojiPicker:
    """Tests for the filtered emoji picker in chat."""

    def _pair_devices(self, alice_helper, bob_helper, alice, bob):
        """Pair two devices."""
        alice_helper.wait_for_app_ready()
        bob_helper.wait_for_app_ready()

        alice_helper.navigate_to_connect()
        alice_code = alice_helper.get_pairing_code_from_connect_screen()

        bob_helper.navigate_to_connect()
        bob_helper.enter_peer_code(alice_code)

        connected = False
        for _ in range(6):
            time.sleep(P2P_CONNECTION_TIMEOUT)
            alice_helper.go_back_to_home()
            bob_helper.go_back_to_home()
            time.sleep(3)
            if alice_helper.is_peer_connected() or bob_helper.is_peer_connected():
                connected = True
                break

        assert connected, "Devices must be paired"

    def test_open_emoji_picker(self, alice, bob):
        """Open the emoji picker in chat screen."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        alice_helper.open_chat_with_peer()
        time.sleep(1)

        # Open emoji picker
        alice_helper.open_emoji_picker()

        # Close it with keyboard button
        alice_helper.close_emoji_picker()

    def test_send_emoji_in_message(self, alice, bob):
        """Send a message containing emoji (typed manually, not from picker)."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        alice_helper.open_chat_with_peer()
        time.sleep(1)

        # Send a text message with emoji character
        alice_helper.send_message("Hello! 😀")
        time.sleep(2)

        # Verify message appears
        assert alice_helper.has_message("Hello! 😀"), "Emoji message should appear in chat"
