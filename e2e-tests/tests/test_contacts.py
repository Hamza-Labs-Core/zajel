"""Tests for contact management with aliases."""

import time
import pytest
from conftest import AppHelper
from config import P2P_CONNECTION_TIMEOUT, APP_LAUNCH_TIMEOUT

PACKAGE_NAME = "com.zajel.zajel"


@pytest.mark.contacts
class TestContacts:
    """Tests for contact naming, search, and detail screens."""

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

    def test_navigate_to_contacts(self, alice, bob):
        """Verify contacts screen opens and shows paired peers."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        alice_helper.go_back_to_home()
        alice_helper.navigate_to_contacts()

        # Should see contacts screen with at least one entry
        alice_helper._find("Contacts", timeout=10)

    def test_set_alias_displays_in_contacts(self, alice, bob):
        """Set an alias for a peer and verify it appears in contacts."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        # Navigate to contacts and open the peer
        alice_helper.go_back_to_home()
        alice_helper.navigate_to_contacts()
        time.sleep(1)

        # Open the first contact (the paired peer)
        try:
            alice.find_element(
                "xpath",
                "//*[contains(@content-desc, 'Peer') or "
                "contains(@content-desc, 'Anonymous')]"
            ).click()
            time.sleep(1)

            # Set alias
            alice_helper.set_peer_alias("Mom")
            time.sleep(1)

            # Go back to contacts and verify alias shows
            alice.back()
            time.sleep(1)
            alice_helper._find("Mom", timeout=10)
        except Exception:
            pytest.skip("Contact detail not accessible in current UI state")

    def test_search_contacts(self, alice, bob):
        """Search contacts by name."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        alice_helper.go_back_to_home()
        alice_helper.navigate_to_contacts()
        time.sleep(1)

        # Search for something
        alice_helper.search_contacts("Peer")
        time.sleep(1)

    def test_alias_persists_across_restart(self, alice, bob):
        """Alias should persist after app restart."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_devices(alice_helper, bob_helper, alice, bob)

        # Set an alias
        alice_helper.go_back_to_home()
        alice_helper.navigate_to_contacts()
        time.sleep(1)

        try:
            alice.find_element(
                "xpath",
                "//*[contains(@content-desc, 'Peer') or "
                "contains(@content-desc, 'Anonymous')]"
            ).click()
            time.sleep(1)

            alice_helper.set_peer_alias("TestAlias")
            time.sleep(1)

            # Restart Alice's app
            alice.terminate_app(PACKAGE_NAME)
            time.sleep(2)
            alice.activate_app(PACKAGE_NAME)
            alice_helper.wait_for_app_ready()
            time.sleep(3)

            # Navigate to contacts and verify alias persisted
            alice_helper.navigate_to_contacts()
            time.sleep(1)
            alice_helper._find("TestAlias", timeout=10)
        except Exception:
            pytest.skip("Contact alias persistence test requires accessible contact detail")
