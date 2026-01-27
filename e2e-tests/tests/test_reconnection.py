"""
E2E tests for peer reconnection via meeting points.

Tests the automatic reconnection flow for trusted peers:
1. Devices pair and become trusted peers
2. App is restarted on both devices
3. Devices should automatically reconnect via meeting points
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.reconnection
@pytest.mark.slow
class TestReconnection:
    """Test suite for meeting point reconnection."""

    def _pair_and_trust(self, alice, bob, app_helper):
        """Pair devices and establish trust."""
        alice_helper = app_helper(alice)
        bob_helper = app_helper(bob)

        alice_helper.wait_for_app_ready()
        bob_helper.wait_for_app_ready()

        alice_helper.enable_external_connections()
        bob_helper.enable_external_connections()

        time.sleep(3)

        alice_code = alice_helper.get_pairing_code()
        bob_helper.enter_peer_code(alice_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Verify initial connection
        assert alice_helper.is_peer_connected() or bob_helper.is_peer_connected()

        return alice_helper, bob_helper

    def test_devices_reconnect_after_restart(self, device_pair, app_helper):
        """Test that trusted peers reconnect after app restart."""
        alice, bob = device_pair["alice"], device_pair["bob"]

        # 1. Pair devices
        alice_helper, bob_helper = self._pair_and_trust(alice, bob, app_helper)

        # 2. Restart both apps
        package_name = "com.zajel.app"  # Adjust to actual package name

        alice.terminate_app(package_name)
        bob.terminate_app(package_name)

        time.sleep(2)

        alice.activate_app(package_name)
        bob.activate_app(package_name)

        # 3. Wait for apps to initialize and reconnect
        alice_helper.wait_for_app_ready()
        bob_helper.wait_for_app_ready()

        # Enable external connections again (may be needed)
        alice_helper.enable_external_connections()
        bob_helper.enable_external_connections()

        # 4. Wait for meeting point discovery
        # Meeting points are registered every 30 minutes with overlap
        # In test, this should happen on app start
        time.sleep(60)  # Wait for reconnection

        # 5. Verify reconnection
        # Either device should show the other as connected
        reconnected = alice_helper.is_peer_connected() or bob_helper.is_peer_connected()

        # Note: This may fail if meeting point discovery takes too long
        # or if the server doesn't support meeting points
        assert reconnected, "Devices should reconnect via meeting points"

    def test_reconnection_with_dead_drop(self, device_pair, app_helper):
        """Test reconnection when one device comes online after the other."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        package_name = "com.zajel.app"

        # 1. Pair devices
        alice_helper, bob_helper = self._pair_and_trust(alice, bob, app_helper)

        # 2. Close both apps
        alice.terminate_app(package_name)
        bob.terminate_app(package_name)

        time.sleep(2)

        # 3. Alice comes online first
        alice.activate_app(package_name)
        alice_helper.wait_for_app_ready()
        alice_helper.enable_external_connections()

        # Wait for Alice to register meeting points
        time.sleep(30)

        # 4. Bob comes online later (should find Alice's dead drop)
        bob.activate_app(package_name)
        bob_helper.wait_for_app_ready()
        bob_helper.enable_external_connections()

        # 5. Wait for dead drop discovery
        time.sleep(30)

        # 6. Verify reconnection
        reconnected = alice_helper.is_peer_connected() or bob_helper.is_peer_connected()
        assert reconnected, "Bob should reconnect via Alice's dead drop"

    def test_live_match_reconnection(self, device_pair, app_helper):
        """Test reconnection when both devices come online simultaneously."""
        alice, bob = device_pair["alice"], device_pair["bob"]
        package_name = "com.zajel.app"

        # 1. Pair devices
        alice_helper, bob_helper = self._pair_and_trust(alice, bob, app_helper)

        # 2. Close both apps
        alice.terminate_app(package_name)
        bob.terminate_app(package_name)

        time.sleep(2)

        # 3. Both come online at the same time
        alice.activate_app(package_name)
        bob.activate_app(package_name)

        alice_helper.wait_for_app_ready()
        bob_helper.wait_for_app_ready()

        alice_helper.enable_external_connections()
        bob_helper.enable_external_connections()

        # 4. Wait for live match
        time.sleep(60)

        # 5. Verify reconnection
        reconnected = alice_helper.is_peer_connected() or bob_helper.is_peer_connected()
        assert reconnected, "Devices should reconnect via live match"
