"""
E2E tests for pairing between the Flutter Windows app and headless client.

Tests the pairing flow where Alice (Flutter Windows app) pairs with
Bob (headless client). The headless client connects to the same signaling
server as the app, replacing a second device.
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.headless
@pytest.mark.pairing
class TestHeadlessPairing:
    """Pairing tests using headless client as the peer."""

    @pytest.mark.single_device
    def test_app_pairs_with_headless_client(self, alice, headless_bob):
        """Alice enters Bob's (headless) code → both connect."""
        bob_code = headless_bob.pairing_code
        assert bob_code is not None
        assert len(bob_code) == 6
        print(f"Headless Bob's pairing code: {bob_code}")

        # Alice navigates to Connect screen
        alice.navigate_to_connect()

        # Wait for signaling to connect (Alice's code appears)
        alice_code = alice.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")

        # Alice enters Bob's code
        alice.enter_peer_code(bob_code)

        # Wait for Bob (headless) to auto-accept and pair
        time.sleep(P2P_CONNECTION_TIMEOUT)

        # Go back to home screen to check connection status
        alice.go_back_to_home()
        time.sleep(3)

        assert alice.is_peer_connected(), "Alice should show a connected peer"

    @pytest.mark.single_device
    def test_headless_pairs_with_app_code(self, alice, headless_bob):
        """Bob (headless) enters Alice's code → both connect."""
        alice.navigate_to_connect()
        alice_code = alice.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")

        # Bob (headless) pairs with Alice's code
        headless_bob.pair_with(alice_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        alice.go_back_to_home()
        time.sleep(3)

        assert alice.is_peer_connected(), "Alice should show a connected peer"
