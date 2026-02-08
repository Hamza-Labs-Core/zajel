"""Contact management tests for Linux desktop."""

import time
import pytest
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.contacts
class TestContacts:
    """Tests for contact naming and management on Linux."""

    def _pair_instances(self, alice, bob):
        """Pair two instances."""
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

    def test_navigate_to_contacts(self, alice, bob):
        """Open contacts screen."""
        self._pair_instances(alice, bob)
        alice.go_back_to_home()
        alice.navigate_to_contacts()
        alice.find_by_name("Contacts", timeout=10)

    def test_search_contacts(self, alice, bob):
        """Search in contacts."""
        self._pair_instances(alice, bob)
        alice.go_back_to_home()
        alice.navigate_to_contacts()
        alice.search_contacts("Peer")
        time.sleep(1)
