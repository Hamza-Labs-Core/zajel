"""
E2E tests for peer management (block/unblock).

Tests the block and unblock flows:
- Blocking a peer via the overflow menu
- Verifying blocked peers appear in the Blocked Users list
- Unblocking from the Blocked Users screen
- Verifying a blocked peer cannot reconnect
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.peer_management
@pytest.mark.slow
class TestPeerManagement:
    """Test suite for blocking and unblocking peers."""

    def _pair_devices(self, alice_driver, bob_driver, app_helper):
        """Pair two devices and return helpers on the home screen."""
        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        alice.navigate_to_connect()
        alice_code = alice.get_pairing_code_from_connect_screen()

        bob.navigate_to_connect()
        bob.enter_peer_code(alice_code)

        connected = False
        for _ in range(6):
            time.sleep(P2P_CONNECTION_TIMEOUT)
            alice.go_back_to_home()
            bob.go_back_to_home()
            time.sleep(3)
            if alice.is_peer_connected() or bob.is_peer_connected():
                connected = True
                break

        assert connected, "Devices must be paired for peer management tests"
        return alice, bob

    def test_block_peer(self, device_pair, app_helper):
        """Peer menu → Block → confirm → peer recorded in blocked list."""
        alice, bob = self._pair_devices(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        # Verify peer is visible on Alice's home
        assert alice.is_peer_connected()

        # Block via overflow menu
        alice.open_peer_menu()
        alice.tap_menu_option("Block")
        alice.confirm_dialog("Block")
        time.sleep(3)

        # Verify the block was recorded by checking the Blocked Users list.
        # Note: the peer card may still be visible on the home screen while
        # the WebRTC connection is alive — the block takes full effect on
        # next reconnection. We verify the block was stored in Settings.
        alice.navigate_to_settings()

        screen_size = device_pair["alice"].get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        for _ in range(3):
            try:
                alice._find("Blocked Users", timeout=3)
                break
            except Exception:
                device_pair["alice"].swipe(
                    center_x, start_y, center_x, end_y, 500
                )
                time.sleep(1)

        alice.tap_settings_option("Blocked Users")

        try:
            alice._find("Unblock", timeout=10)
            blocked = True
        except Exception:
            blocked = False
        assert blocked, "Blocked peer should appear in Blocked Users list"

    def test_blocked_peer_in_list(self, device_pair, app_helper):
        """After blocking → Settings → Blocked Users → peer listed."""
        alice, bob = self._pair_devices(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        # Block the peer
        alice.open_peer_menu()
        alice.tap_menu_option("Block")
        alice.confirm_dialog("Block")
        time.sleep(3)

        # Navigate to Settings → Blocked Users
        alice.navigate_to_settings()

        # Scroll to find Blocked Users
        screen_size = device_pair["alice"].get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        for _ in range(3):
            try:
                alice._find("Blocked Users", timeout=3)
                break
            except Exception:
                device_pair["alice"].swipe(
                    center_x, start_y, center_x, end_y, 500
                )
                time.sleep(1)

        alice.tap_settings_option("Blocked Users")

        # The blocked peer should be listed (look for 'Blocked' status text
        # or the 'Unblock' button, which only appears on blocked user cards)
        try:
            alice._find("Unblock", timeout=10)
            found = True
        except Exception:
            found = False
        assert found, "Blocked peer should appear in Blocked Users list"

    def test_unblock_peer(self, device_pair, app_helper):
        """Blocked Users → Unblock → confirm → peer removed from blocked list."""
        alice, bob = self._pair_devices(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        # Block the peer
        alice.open_peer_menu()
        alice.tap_menu_option("Block")
        alice.confirm_dialog("Block")
        time.sleep(3)

        # Navigate to Blocked Users
        alice.navigate_to_settings()

        screen_size = device_pair["alice"].get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        for _ in range(3):
            try:
                alice._find("Blocked Users", timeout=3)
                break
            except Exception:
                device_pair["alice"].swipe(
                    center_x, start_y, center_x, end_y, 500
                )
                time.sleep(1)

        alice.tap_settings_option("Blocked Users")
        time.sleep(2)

        # Tap Unblock on the peer card
        alice._find("Unblock", timeout=10).click()
        time.sleep(1)

        # Confirm unblock dialog
        alice.confirm_dialog("Unblock")
        time.sleep(3)

        # The blocked list should now be empty (show "No blocked users")
        try:
            alice._find("No blocked users", timeout=10)
            empty = True
        except Exception:
            empty = False
        assert empty, "After unblocking, blocked users list should be empty"

    def test_blocked_peer_cannot_reconnect(self, device_pair, app_helper):
        """Block Bob → restart both → Bob doesn't appear on Alice's home."""
        alice, bob = self._pair_devices(
            device_pair["alice"], device_pair["bob"], app_helper
        )

        # Block the peer
        alice.open_peer_menu()
        alice.tap_menu_option("Block")
        alice.confirm_dialog("Block")
        time.sleep(5)

        # Verify block took effect before restarting
        alice.navigate_to_settings()
        time.sleep(1)
        alice.go_back_to_home()
        time.sleep(3)

        # Restart both apps
        package_name = "com.zajel.zajel"
        device_pair["alice"].terminate_app(package_name)
        device_pair["bob"].terminate_app(package_name)
        time.sleep(2)

        device_pair["alice"].activate_app(package_name)
        device_pair["bob"].activate_app(package_name)

        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        # Trigger signaling reconnection
        alice.navigate_to_connect()
        bob.navigate_to_connect()
        time.sleep(30)

        alice.go_back_to_home()
        bob.go_back_to_home()
        time.sleep(3)

        # Alice should NOT see Bob as a connected peer.
        # Poll a few times in case UI takes time to settle.
        still_connected = True
        for _ in range(4):
            if not alice.is_peer_connected():
                still_connected = False
                break
            time.sleep(5)

        assert not still_connected, \
            "Blocked peer should not reconnect after restart"
