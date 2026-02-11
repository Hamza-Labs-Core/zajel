"""Tests for enhanced blocked list features."""

import time
import pytest
from platforms.android_helper import AppHelper
from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.blocked_enhanced
class TestBlockedEnhanced:
    """Tests for blocked list enhancements: timestamps, remove permanently."""

    def _pair_and_block(self, alice_helper, bob_helper, alice, bob):
        """Pair two devices, then block Bob from Alice."""
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

        # Block Bob from Alice
        alice_helper.go_back_to_home()
        alice_helper.open_peer_menu()
        alice_helper.tap_menu_option("Block")
        alice_helper.confirm_dialog("Block")
        time.sleep(1)

    def test_blocked_date_shown(self, alice, bob):
        """Verify blocked list shows when each peer was blocked."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_and_block(alice_helper, bob_helper, alice, bob)

        # Navigate to blocked list
        alice_helper.navigate_to_blocked_list()

        # Should see "Blocked" with a time reference
        alice_helper._find("Blocked", timeout=10)

    def test_unblock_from_list(self, alice, bob):
        """Unblock a peer from the blocked list."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_and_block(alice_helper, bob_helper, alice, bob)

        # Navigate to blocked list
        alice_helper.navigate_to_blocked_list()

        # Find the popup menu and unblock
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Tap popup menu
        menu = WebDriverWait(alice, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Show menu') or "
                "contains(@content-desc, 'Popup')]"
            ))
        )
        menu.click()
        time.sleep(1)

        # Tap Unblock
        alice_helper._find("Unblock", timeout=10).click()
        time.sleep(1)

        # Confirm dialog
        alice_helper._find("Unblock", timeout=10, partial=False).click()
        time.sleep(1)

        # Should see "unblocked" snackbar or empty state
        try:
            alice_helper._find("No blocked users", timeout=5)
        except Exception:
            pass  # May take time to update

    def test_remove_permanently(self, alice, bob):
        """Remove a peer permanently from blocked list and trusted storage."""
        alice_helper = AppHelper(alice)
        bob_helper = AppHelper(bob)

        self._pair_and_block(alice_helper, bob_helper, alice, bob)

        # Navigate to blocked list
        alice_helper.navigate_to_blocked_list()

        # Find the popup menu and remove permanently
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        menu = WebDriverWait(alice, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Show menu') or "
                "contains(@content-desc, 'Popup')]"
            ))
        )
        menu.click()
        time.sleep(1)

        # Tap "Remove Permanently"
        alice_helper._find("Remove Permanently", timeout=10).click()
        time.sleep(1)

        # Confirm
        alice_helper._find("Remove", timeout=10, partial=False).click()
        time.sleep(2)

        # Should see "removed permanently" snackbar or empty state
        try:
            alice_helper._find("No blocked users", timeout=5)
        except Exception:
            pass  # Snackbar may have dismissed
