"""Notification settings tests for Linux desktop."""

import time
import pytest


@pytest.mark.notifications
class TestNotifications:
    """Tests for notification settings on Linux."""

    def test_dnd_toggle(self, alice):
        """Toggle DND on and off."""
        alice.navigate_to_notification_settings()
        alice.click("Do Not Disturb")
        time.sleep(1)
        alice.find_by_name("1 hour", timeout=5)

    def test_sound_toggle(self, alice):
        """Toggle sound setting."""
        alice.navigate_to_notification_settings()
        alice.click("Sound")
        time.sleep(1)

    def test_preview_toggle(self, alice):
        """Toggle message preview."""
        alice.navigate_to_notification_settings()
        alice.click("Message Preview")
        time.sleep(1)
