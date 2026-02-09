"""Pairing tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.pairing
class TestPairing:
    """Tests for pairing two Linux app instances."""

    def test_app_launches_successfully(self, alice):
        """Verify app launches and shows home screen."""
        alice.find_by_name("Zajel", timeout=10)

    def test_can_get_pairing_code(self, alice):
        """Navigate to Connect screen and retrieve pairing code."""
        alice.navigate_to_connect()
        code = alice.get_pairing_code_from_connect_screen()
        assert len(code) == 6, f"Pairing code should be 6 chars, got '{code}'"
        assert code.isalnum(), f"Pairing code should be alphanumeric, got '{code}'"

    def test_two_instances_can_pair(self, alice, bob):
        """Two Linux app instances can pair via pairing code exchange."""
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

        assert connected, "Instances must be paired"
