"""Peer management tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.peer_management
class TestPeerManagement:
    """Tests for blocking/unblocking peers on Linux."""

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

    def test_block_peer(self, alice, bob):
        """Block a peer from the home screen."""
        self._pair_instances(alice, bob)
        alice.go_back_to_home()

        # Open overflow menu on peer card
        # Note: AT-SPI exposes menu buttons differently from Android
        alice.click("Show menu")
        time.sleep(0.5)
        alice.click("Block")
        time.sleep(0.5)
        alice.confirm_dialog("Block")
        time.sleep(1)

    def test_blocked_list(self, alice, bob):
        """Verify blocked peer appears in blocked list."""
        self._pair_instances(alice, bob)
        alice.go_back_to_home()

        alice.click("Show menu")
        time.sleep(0.5)
        alice.click("Block")
        time.sleep(0.5)
        alice.confirm_dialog("Block")
        time.sleep(1)

        alice.navigate_to_blocked_list()
        alice.find_by_name("Blocked", timeout=10)
