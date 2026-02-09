"""
E2E tests for device pairing functionality.

Tests the pairing flow between two devices using pairing codes.

App flow:
1. App launches → Home screen ("Zajel" title)
2. Tap "Connect" FAB → Connect screen (auto-connects to signaling server)
3. "My Code" tab shows QR code + 6-char pairing code
4. TextField at bottom allows entering another device's code
5. After pairing, home screen shows peer with "Connected" status
"""

import time
import pytest

from config import CONNECTION_TIMEOUT, P2P_CONNECTION_TIMEOUT


@pytest.mark.smoke
@pytest.mark.pairing
class TestPairing:
    """Test suite for device pairing."""

    @pytest.mark.single_device
    def test_app_launches_successfully(self, alice, app_helper):
        """Test that the app launches and shows the home screen."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # App should be running and showing home screen
        assert alice.current_activity is not None

    @pytest.mark.single_device
    def test_can_get_pairing_code(self, alice, app_helper):
        """Test navigating to Connect screen and getting a pairing code."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Connect screen (triggers signaling connection)
        helper.navigate_to_connect()

        # Get the pairing code from the Connect screen
        code = helper.get_pairing_code_from_connect_screen()
        assert code is not None
        assert len(code) == 6
        assert code.isalnum()

    def test_two_devices_can_pair(self, device_pair, app_helper):
        """Test that two devices can connect via pairing code."""
        alice_driver = device_pair["alice"]
        bob_driver = device_pair["bob"]

        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        # Wait for both apps to be ready
        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        # Alice navigates to Connect screen (auto-connects to signaling)
        alice.navigate_to_connect()
        # Get Alice's pairing code
        alice_code = alice.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")
        assert len(alice_code) == 6

        # Bob navigates to Connect screen
        bob.navigate_to_connect()
        # Bob enters Alice's code
        bob.enter_peer_code(alice_code)

        # Wait for connection to establish
        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Go back to home screens to check connection status
        alice.go_back_to_home()
        bob.go_back_to_home()
        time.sleep(3)

        # Verify at least one device shows connected
        assert alice.is_peer_connected() or bob.is_peer_connected()

    def test_pairing_code_is_unique(self, device_pair, app_helper):
        """Test that each device gets a unique pairing code."""
        alice_driver = device_pair["alice"]
        bob_driver = device_pair["bob"]

        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        # Both navigate to Connect screen to get their codes
        alice.navigate_to_connect()
        alice_code = alice.get_pairing_code_from_connect_screen()

        bob.navigate_to_connect()
        bob_code = bob.get_pairing_code_from_connect_screen()

        # Codes should be different
        assert alice_code != bob_code

    @pytest.mark.slow
    @pytest.mark.single_device
    def test_invalid_pairing_code_handled(self, alice, app_helper):
        """Test that entering an invalid pairing code shows error."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to Connect screen
        helper.navigate_to_connect()

        # Wait for signaling to connect (code to appear)
        helper.get_pairing_code_from_connect_screen()

        # Enter an invalid code
        helper.enter_peer_code("ZZZZZZ")

        time.sleep(CONNECTION_TIMEOUT)

        # Go back to home and check - should not show any connected peer
        helper.go_back_to_home()
        time.sleep(2)
        assert not helper.is_peer_connected()
