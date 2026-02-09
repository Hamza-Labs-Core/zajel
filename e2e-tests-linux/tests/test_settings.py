"""Settings tests for Linux desktop."""

import time
import pytest


@pytest.mark.settings
class TestSettings:
    """Tests for settings screen on Linux."""

    def test_navigate_to_settings(self, alice):
        """Open settings screen."""
        alice.navigate_to_settings()
        alice.find_by_name("Profile", timeout=10)

    def test_change_display_name(self, alice):
        """Change display name and verify it appears."""
        alice.navigate_to_settings()
        alice.change_display_name("TestUser")
        time.sleep(1)
        alice.find_by_name("TestUser", timeout=10)

    def test_notification_settings(self, alice):
        """Open notification settings."""
        alice.navigate_to_notification_settings()
        alice.find_by_name("Do Not Disturb", timeout=10)

    def test_media_settings(self, alice):
        """Open media settings."""
        alice.navigate_to_media_settings()
        alice.find_by_name("Microphone", timeout=10)
