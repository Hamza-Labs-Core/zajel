"""Tests for notification settings UI."""

import time
import pytest
from platforms.android_helper import AppHelper
from config import APP_LAUNCH_TIMEOUT


@pytest.mark.notifications
@pytest.mark.single_device
class TestNotifications:
    """Tests for notification settings screen and DND controls."""

    def test_navigate_to_notification_settings(self, alice):
        """Verify notification settings screen opens."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_notification_settings()

        # Should see the notification settings page
        helper._find("Do Not Disturb", timeout=10)
        helper._find("Sound", timeout=5)

    def test_dnd_toggle(self, alice):
        """Toggle DND on and off."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_notification_settings()

        # Toggle DND on
        helper._find("Do Not Disturb", timeout=10).click()
        time.sleep(1)

        # Should see DND schedule options
        helper._find("1 hour", timeout=5)

        # Select "Indefinitely"
        helper._find("Indefinitely", timeout=5).click()
        time.sleep(1)

    def test_sound_toggle(self, alice):
        """Toggle sound on and off."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_notification_settings()

        # Toggle sound
        helper._find("Sound", timeout=10).click()
        time.sleep(1)

    def test_notification_preview_toggle(self, alice):
        """Toggle message preview on and off."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_notification_settings()

        helper._find("Message Preview", timeout=10).click()
        time.sleep(1)

    def test_per_type_toggles(self, alice):
        """Verify per-type notification toggles are present."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_notification_settings()

        # Scroll down to see all toggles
        screen_size = alice.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)
        alice.swipe(center_x, start_y, center_x, end_y, 500)
        time.sleep(1)

        # Verify type toggles exist
        helper._find("Messages", timeout=5)
        helper._find("Calls", timeout=5)
