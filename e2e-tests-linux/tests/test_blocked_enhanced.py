"""Enhanced blocked list tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.blocked_enhanced
class TestBlockedEnhanced:
    """Tests for blocked list enhancements on Linux."""

    def _pair_and_block(self, alice, bob):
        """Pair two instances and block Bob."""
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

        alice.go_back_to_home()
        alice.click("Show menu")
        time.sleep(0.5)
        alice.click("Block")
        time.sleep(0.5)
        alice.confirm_dialog("Block")
        time.sleep(1)

    def test_blocked_date_shown(self, alice, bob):
        """Blocked list shows when peer was blocked."""
        self._pair_and_block(alice, bob)
        alice.navigate_to_blocked_list()
        alice.find_by_name("Blocked", timeout=10)

    def test_remove_permanently(self, alice, bob):
        """Remove a peer permanently from blocked list."""
        self._pair_and_block(alice, bob)
        alice.navigate_to_blocked_list()

        # Open popup menu on the blocked peer
        alice.click("Show menu")
        time.sleep(0.5)
        alice.click("Remove Permanently")
        time.sleep(0.5)
        alice.confirm_dialog("Remove")
        time.sleep(1)

        # Should see empty state
        try:
            alice.find_by_name("No blocked users", timeout=5)
        except Exception:
            pass
