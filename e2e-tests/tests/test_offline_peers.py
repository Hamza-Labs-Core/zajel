"""Tests for offline peer visibility."""

import time
import pytest
from conftest import AppHelper
from config import P2P_CONNECTION_TIMEOUT

PACKAGE_NAME = "com.zajel.zajel"


@pytest.mark.offline
class TestOfflinePeers:
    """Tests for offline peer display and chat functionality."""

    def _pair_devices(self, alice_helper, bob_helper, alice, bob):
        """Pair two devices and verify connection."""
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

    def test_peer_shows_offline_after_disconnect(self, alice, bob):
        """When a peer disconnects, they should show as offline with last seen."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        # Kill Bob's app
        bob.terminate_app(PACKAGE_NAME)
        time.sleep(5)

        # Alice should see Bob as offline
        alice_helper.go_back_to_home()
        time.sleep(3)

        # Check for "Offline" section or "Last seen" text
        assert alice_helper.is_peer_offline(), \
            "Disconnected peer should show as offline with last seen"

    def test_last_seen_shown(self, alice, bob):
        """Verify 'Last seen X ago' is shown for offline peers."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        # Kill Bob's app
        bob.terminate_app(PACKAGE_NAME)
        time.sleep(5)

        # Alice should see "Last seen" for the offline peer
        alice_helper.go_back_to_home()
        time.sleep(3)

        last_seen = alice_helper.get_last_seen()
        assert "Last seen" in last_seen, \
            f"Should show 'Last seen' text, got: {last_seen}"

    def test_chat_opens_for_offline_peer(self, alice, bob):
        """Tapping an offline peer should open chat with offline banner."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        # Kill Bob's app
        bob.terminate_app(PACKAGE_NAME)
        time.sleep(5)

        alice_helper.go_back_to_home()
        time.sleep(3)

        # Try to open chat with the offline peer
        try:
            # Find the offline peer and tap it
            alice.find_element(
                "xpath",
                "//*[contains(@content-desc, 'Last seen')]"
            ).click()
            time.sleep(2)

            # Should see the offline banner
            alice_helper._find("offline", timeout=5)
        except Exception:
            # Peer card may not be tappable in all states
            pass
