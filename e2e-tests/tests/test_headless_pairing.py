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



@pytest.mark.headless
@pytest.mark.pairing
class TestHeadlessPairing:
    """Pairing tests using headless client as the peer."""

    @pytest.mark.single_device
    def test_app_pairs_with_headless_client(self, alice, app_helper, headless_bob):
        """Alice enters Bob's (headless) code → both connect.

        With multi-server bootstrap discovery, Bob has a pairing code on
        each server.  We try each code until the one matching Alice's
        server succeeds.
        """
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Bob (headless) is already connected — get codes for all servers
        bob_codes = headless_bob.pairing_codes
        for code in bob_codes:
            assert code is not None
            assert len(code) == 6
        print(f"Headless Bob's pairing codes: {bob_codes}")

        # Alice navigates to Connect screen
        helper.navigate_to_connect()

        # Wait for signaling to connect (Alice's code appears)
        alice_code = helper.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")

        # Try each of Bob's codes — only the one on Alice's server will work
        for i, bob_code in enumerate(bob_codes):
            print(f"Trying Bob's code {i+1}/{len(bob_codes)}: {bob_code}")
            helper.enter_peer_code(bob_code)

            # Poll until connected or timeout
            if helper.wait_for_peer_connected(timeout=60):
                print(f"Pairing succeeded with code {bob_code}")
                break

            # Not connected — try the next code on the next server
            if i < len(bob_codes) - 1:
                print(f"Code {bob_code} not on Alice's server, trying next...")
                helper.navigate_to_connect()
                time.sleep(2)

        # Verify Alice shows a connected peer
        assert helper.is_peer_connected(), "Alice should show a connected peer"

    @pytest.mark.single_device
    def test_headless_pairs_with_app_code(self, alice, app_helper, headless_bob):
        """Bob (headless) enters Alice's code → both connect.

        The app is built with E2E_TEST=true, so it auto-accepts incoming
        pair requests — no manual "Accept" tap is needed.
        """
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Alice navigates to Connect screen to get her code
        helper.navigate_to_connect()
        alice_code = helper.get_pairing_code_from_connect_screen()
        print(f"Alice's pairing code: {alice_code}")

        # Bob (headless) pairs with Alice's code.
        # The app auto-accepts in E2E mode, so this completes without UI interaction.
        headless_bob.pair_with(alice_code)

        # Poll until connected or timeout
        assert helper.wait_for_peer_connected(timeout=60), "Alice should show a connected peer"

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
