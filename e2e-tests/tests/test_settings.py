"""
E2E tests for the Settings screen.

Tests navigation, display name changes, log viewer, and clear-all-data.
Most tests are single-device (Alice only), except clear-all-data which
needs a paired peer to verify it gets removed.
"""

import time
import pytest

from config import P2P_CONNECTION_TIMEOUT


@pytest.mark.settings
class TestSettings:
    """Test suite for settings screen functionality."""

    @pytest.mark.single_device
    def test_navigate_to_settings(self, alice, app_helper):
        """Tap Settings → screen loads with recognizable content."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_settings()

        # Settings screen should show the 'Profile' section header
        try:
            helper._find("Profile", timeout=10)
            loaded = True
        except Exception:
            loaded = False
        assert loaded, "Settings screen should show Profile section"

    @pytest.mark.single_device
    def test_change_display_name(self, alice, app_helper):
        """Change display name to 'E2EUser' → verify it appears on settings screen."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_settings()
        helper.change_display_name("E2EUser")

        # The new name should be visible on the settings screen
        try:
            helper._find("E2EUser", timeout=10)
            found = True
        except Exception:
            found = False
        assert found, "New display name 'E2EUser' should appear on settings screen"

    @pytest.mark.single_device
    def test_display_name_persists(self, alice, app_helper):
        """Set name → restart app → name still shown."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_settings()
        helper.change_display_name("PersistTest")

        # Verify it's set
        helper._find("PersistTest", timeout=10)

        # Restart the app
        package_name = "com.zajel.zajel"
        alice.terminate_app(package_name)
        time.sleep(2)
        alice.activate_app(package_name)
        helper.wait_for_app_ready()

        # Navigate back to settings and verify name persisted
        helper.navigate_to_settings()

        try:
            helper._find("PersistTest", timeout=10)
            persisted = True
        except Exception:
            persisted = False
        assert persisted, "Display name should persist after app restart"

    @pytest.mark.single_device
    def test_connection_status_shown(self, alice, app_helper):
        """Settings shows connection status ('Connected' or 'Connecting...')."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        # Navigate to connect first to trigger signaling connection
        helper.navigate_to_connect()
        time.sleep(5)
        helper.go_back_to_home()

        helper.navigate_to_settings()

        # The External Connections section may be below the fold — scroll down
        # Use small scroll increments to avoid overshooting past the section
        screen_size = alice.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.6)

        found_status = False
        # On Pixel 6 (~859dp usable), "External Connections" is at ~492dp
        # and should be visible without scrolling. Try with a longer timeout
        # first, then scroll with smaller increments as fallback.
        for attempt in range(4):
            find_timeout = 5 if attempt == 0 else 2
            for status_text in ['External Connections', 'Connected',
                                'Connecting', 'Pairing Code']:
                try:
                    helper._find(status_text, timeout=find_timeout)
                    found_status = True
                    break
                except Exception:
                    pass
            if found_status:
                break
            # Small scroll (~150dp) to avoid overshooting past the section
            small_end_y = int(screen_size['height'] * 0.45)
            alice.swipe(center_x, start_y, center_x, small_end_y, 500)
            time.sleep(1)

        assert found_status, \
            "Settings should show connection status section"

    @pytest.mark.single_device
    def test_view_logs(self, alice, app_helper):
        """Tap 'View Logs' → log viewer sheet appears → close it."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_settings()

        # Scroll down to find View Logs (it's in the Debugging section)
        screen_size = alice.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        for _ in range(3):
            try:
                helper._find("View Logs", timeout=3)
                break
            except Exception:
                alice.swipe(center_x, start_y, center_x, end_y, 500)
                time.sleep(1)

        helper.tap_settings_option("View Logs")

        # Log viewer bottom sheet should appear with 'Log Viewer' header
        try:
            helper._find("Log Viewer", timeout=10)
            opened = True
        except Exception:
            opened = False
        assert opened, "Log viewer sheet should open"

        # Close it (press back or tap close icon)
        alice.back()
        time.sleep(1)

    @pytest.mark.slow
    def test_clear_all_data(self, device_pair, app_helper):
        """Pair devices → clear all data on Alice → home screen shows no peers."""
        alice_driver = device_pair["alice"]
        bob_driver = device_pair["bob"]

        alice = app_helper(alice_driver)
        bob = app_helper(bob_driver)

        alice.wait_for_app_ready()
        bob.wait_for_app_ready()

        # Pair devices
        alice.navigate_to_connect()
        alice_code = alice.get_pairing_code_from_connect_screen()
        bob.navigate_to_connect()
        bob.enter_peer_code(alice_code)
        time.sleep(P2P_CONNECTION_TIMEOUT)

        alice.go_back_to_home()
        bob.go_back_to_home()
        time.sleep(3)

        # Verify paired
        assert alice.is_peer_connected() or bob.is_peer_connected(), \
            "Devices should be paired before clear-all test"

        # Alice clears all data
        alice.navigate_to_settings()

        # Scroll to bottom to find 'Clear All Data'
        screen_size = alice_driver.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        for _ in range(5):
            try:
                alice._find("Clear All Data", timeout=3)
                break
            except Exception:
                alice_driver.swipe(center_x, start_y, center_x, end_y, 500)
                time.sleep(1)

        alice.tap_settings_option("Clear All Data")
        alice.confirm_dialog("Clear All")

        # Wait for app to reset
        time.sleep(5)
        alice.wait_for_app_ready()

        # Home screen should show no peers (empty state)
        assert not alice.is_peer_connected(), \
            "After clearing data, no peers should be connected"
