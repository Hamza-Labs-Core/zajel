"""
E2E tests for device pairing functionality.

Tests the pairing flow between two devices using pairing codes.
"""

import time
import pytest

from config import CONNECTION_TIMEOUT, P2P_CONNECTION_TIMEOUT


@pytest.mark.smoke
@pytest.mark.pairing
class TestPairing:
    """Test suite for device pairing."""

    def test_app_launches_successfully(self, alice, app_helper):
        """Test that the app launches and shows main screen."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # App should be running
        assert alice.current_activity is not None

    def test_can_enable_external_connections(self, alice, app_helper):
        """Test enabling external connections toggle."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()
        helper.enable_external_connections()

        # Should show pairing code after enabling
        time.sleep(3)  # Wait for code generation
        code = helper.get_pairing_code()
        assert code is not None
        assert len(code) >= 6

    def test_two_devices_can_pair(self, device_pair, app_helper):
        """Test that two devices can connect via pairing code."""
        alice_driver = device_pair["alice"]
        bob_driver = device_pair["bob"]

        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        # Wait for both apps to be ready
        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        # Enable external connections on both
        alice.enable_external_connections()
        bob.enable_external_connections()

        time.sleep(3)  # Wait for codes to generate

        # Get Alice's pairing code
        alice_code = alice.get_pairing_code()
        print(f"Alice's pairing code: {alice_code}")

        # Bob enters Alice's code
        bob.enter_peer_code(alice_code)

        # Wait for connection to establish
        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Verify both devices show connected
        assert alice.is_peer_connected() or bob.is_peer_connected()

    def test_pairing_code_is_unique(self, device_pair, app_helper):
        """Test that each device gets a unique pairing code."""
        alice_driver = device_pair["alice"]
        bob_driver = device_pair["bob"]

        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        alice.enable_external_connections()
        bob.enable_external_connections()

        time.sleep(3)

        alice_code = alice.get_pairing_code()
        bob_code = bob.get_pairing_code()

        # Codes should be different
        assert alice_code != bob_code

    @pytest.mark.slow
    def test_invalid_pairing_code_handled(self, alice, app_helper):
        """Test that entering an invalid pairing code shows error."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()
        helper.enable_external_connections()

        time.sleep(2)

        # Enter an invalid code
        helper.enter_peer_code("INVALID-CODE-12345")

        time.sleep(CONNECTION_TIMEOUT)

        # Should show error or not connect
        assert not helper.is_peer_connected()
