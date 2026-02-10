"""Emoji picker tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.emoji
class TestEmojiPicker:
    """Tests for the filtered emoji picker on Linux."""

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

    def test_open_and_close_picker(self, alice, bob):
        """Open and close the emoji picker."""
        self._pair_instances(alice, bob)
        alice.open_chat_with_peer()
        time.sleep(1)

        alice.open_emoji_picker()
        alice.close_emoji_picker()
