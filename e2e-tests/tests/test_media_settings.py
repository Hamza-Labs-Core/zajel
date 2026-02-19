"""Tests for media device settings UI."""

import time
import pytest
from platforms.android_helper import AppHelper
from config import APP_LAUNCH_TIMEOUT


@pytest.mark.media_settings
@pytest.mark.single_device
class TestMediaSettings:
    """Tests for audio and video device settings screen."""

    def test_navigate_to_media_settings(self, alice):
        """Verify media settings screen opens."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_media_settings()

        # Should see the media settings sections
        helper._find("Microphone", timeout=10)
        helper._find("Camera", timeout=5)

    def test_audio_processing_toggles(self, alice):
        """Verify audio processing toggles are present and interactive."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_media_settings()

        # Scroll down to Audio Processing section
        screen_size = alice.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)
        alice.swipe(center_x, start_y, center_x, end_y, 500)
        time.sleep(1)

        # Find and toggle noise suppression
        helper._find("Noise Suppression", timeout=10).click()
        time.sleep(1)

        # Find echo cancellation
        helper._find("Echo Cancellation", timeout=5)

        # Find auto gain control
        helper._find("Auto Gain Control", timeout=5)

    def test_background_blur_toggle(self, alice):
        """Verify background blur toggle is present in media settings."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_media_settings()

        # Scroll to bottom
        screen_size = alice.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        for _ in range(3):
            alice.swipe(center_x, start_y, center_x, end_y, 500)
            time.sleep(0.5)

        helper._find("Background Blur", timeout=10)

    def test_refresh_devices(self, alice):
        """Verify refresh devices button works."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_media_settings()

        # Scroll until "Refresh Devices" is visible — it's at the very bottom
        # and the Camera preview section is tall, so we need to scroll and check
        screen_size = alice.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)

        found = False
        for _ in range(10):
            try:
                helper._find("Refresh Devices", timeout=2).click()
                found = True
                break
            except Exception:
                alice.swipe(center_x, start_y, center_x, end_y, 500)
                time.sleep(0.5)
        if not found:
            helper._find("Refresh Devices", timeout=5).click()
        time.sleep(2)

        # Scroll back up — Microphone is at the top of the settings page
        for _ in range(10):
            alice.swipe(center_x, end_y, center_x, start_y, 500)
            time.sleep(0.5)

        # Should still see the settings page after refresh
        helper._find("Microphone", timeout=10)
