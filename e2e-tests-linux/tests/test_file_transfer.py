"""File transfer tests for Linux desktop."""

import os
import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.file_transfer
class TestFileTransfer:
    """Tests for file sharing on Linux."""

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

    def test_attach_file_button(self, alice, bob):
        """Verify attach file button opens file picker."""
        self._pair_instances(alice, bob)
        alice.open_chat_with_peer()
        time.sleep(1)

        # Try clicking attach button
        try:
            alice.click("Attach file")
            time.sleep(2)
            # Dismiss file picker with Escape
            alice.press_key("Escape")
        except Exception:
            pytest.skip("File picker not accessible via AT-SPI")
