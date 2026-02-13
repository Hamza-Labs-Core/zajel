"""
E2E tests for pairing between the Flutter app and headless client.

Tests the pairing flow where Alice (Flutter app on emulator) pairs with
Bob (headless client). This replaces dual-emulator pairing tests and avoids
the TURN relay requirement for P2P between emulators.

Flow:
1. Headless Bob connects to signaling server and gets a pairing code
2. Alice navigates to Connect screen on the emulator
3. Alice enters Bob's code → pairing completes
4. Both are connected via WebRTC data channel
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.headless
@pytest.mark.pairing
class TestHeadlessPairing:
    """Pairing tests using headless client as the peer."""

    @pytest.mark.single_device
    def test_app_pairs_with_headless_client(self, alice, app_helper, headless_bob):
        """Alice enters Bob's (headless) code → both connect."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Bob (headless) is already connected and has a pairing code
        bob_code = headless_bob.pairing_code
        assert bob_code is not None
        assert len(bob_code) == 6
        print(f"Headless Bob's pairing code: {bob_code}")

        # Alice navigates to Connect screen
        helper.navigate_to_connect()

        # Wait for signaling to connect (Alice's code appears)
        alice_code = helper.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")

        # Alice enters Bob's code
        helper.enter_peer_code(bob_code)

        # Wait for Bob (headless) to auto-accept and pair
        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Go back to home screen to check connection status
        helper.go_back_to_home()
        time.sleep(3)

        # Verify Alice shows a connected peer
        assert helper.is_peer_connected(), "Alice should show a connected peer"

    @pytest.mark.single_device
    def test_headless_pairs_with_app_code(self, alice, app_helper, headless_bob):
        """Bob (headless) enters Alice's code → both connect."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Alice navigates to Connect screen to get her code
        helper.navigate_to_connect()
        alice_code = helper.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")

        # Bob (headless) starts pairing in background (non-blocking)
        # because Alice needs to tap "Accept" on the connection request dialog
        import concurrent.futures
        future = headless_bob.pair_with_async(alice_code)

        # Wait for the Connection Request dialog to appear and tap Accept
        time.sleep(3)
        helper._find("Accept", timeout=15).click()

        # Wait for Bob's pair_with to complete
        future.result(timeout=60)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Go back to home screen to check connection status
        helper.go_back_to_home()
        time.sleep(3)

        assert helper.is_peer_connected(), "Alice should show a connected peer"

    @pytest.mark.single_device
    def test_pairing_codes_differ(self, alice, app_helper, headless_bob):
        """Alice and headless Bob should have different pairing codes."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_connect()
        alice_code = helper.get_pairing_code_from_connect_screen()

        bob_code = headless_bob.pairing_code

        assert alice_code != bob_code, "Codes must be unique"
        assert len(alice_code) == 6
        assert len(bob_code) == 6
