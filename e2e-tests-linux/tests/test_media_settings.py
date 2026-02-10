"""Media settings tests for Linux desktop."""

import time
import pytest


@pytest.mark.media_settings
class TestMediaSettings:
    """Tests for audio and video settings on Linux."""

    def test_open_media_settings(self, alice):
        """Open media settings screen."""
        alice.navigate_to_media_settings()
        alice.find_by_name("Microphone", timeout=10)

    def test_audio_processing_toggles(self, alice):
        """Verify audio processing toggles."""
        alice.navigate_to_media_settings()
        alice.find_by_name("Noise Suppression", timeout=10)
        alice.click("Noise Suppression")
        time.sleep(1)
        alice.find_by_name("Echo Cancellation", timeout=5)

    def test_background_blur_planned(self, alice):
        """Verify background blur shows as planned."""
        alice.navigate_to_media_settings()
        alice.find_by_name("Coming soon", timeout=30)
