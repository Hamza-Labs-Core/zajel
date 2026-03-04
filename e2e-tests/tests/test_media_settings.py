"""Tests for media device settings UI."""

import time
import pytest
from appium.webdriver.common.appiumby import AppiumBy
from platforms.android_helper import AppHelper
from config import APP_LAUNCH_TIMEOUT


def _scroll_to(driver, text):
    """Scroll a UiScrollable until an element with the given text is visible.

    Flutter exposes widget text as either @text or @content-desc depending
    on the widget type and semantics merging.  Try descriptionContains first
    (covers SwitchListTile, section headers) then textContains (plain Text).
    """
    for selector_fn in ("descriptionContains", "textContains"):
        try:
            return driver.find_element(
                AppiumBy.ANDROID_UIAUTOMATOR,
                f'new UiScrollable(new UiSelector().scrollable(true))'
                f'.scrollIntoView(new UiSelector().{selector_fn}("{text}"))'
            )
        except Exception:
            continue
    # Final attempt — let it raise
    return driver.find_element(
        AppiumBy.ANDROID_UIAUTOMATOR,
        f'new UiScrollable(new UiSelector().scrollable(true))'
        f'.scrollIntoView(new UiSelector().descriptionContains("{text}"))'
    )


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

        # Scroll down to "Audio Processing" section.  Flutter's ListView
        # lazily renders children — items below the visible viewport are
        # NOT in the UiAutomator hierarchy.  We use UiScrollable to scroll
        # the container until the target text appears.

        # Scroll to and click Noise Suppression toggle
        _scroll_to(alice, "Noise Suppression")
        helper._find("Noise Suppression", timeout=5).click()
        time.sleep(1)

        # Scroll further to bring Echo Cancellation into view
        _scroll_to(alice, "Echo Cancellation")
        helper._find("Echo Cancellation", timeout=5)

        # Scroll to Auto Gain Control
        _scroll_to(alice, "Auto Gain Control")
        helper._find("Auto Gain Control", timeout=5)

    def test_background_blur_toggle(self, alice):
        """Verify background blur toggle is present in media settings."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_media_settings()

        _scroll_to(alice, "Background Blur")
        helper._find("Background Blur", timeout=5)

    def test_refresh_devices(self, alice):
        """Verify refresh devices button works."""
        helper = AppHelper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_media_settings()

        # Scroll to Refresh Devices button at bottom
        _scroll_to(alice, "Refresh Devices")
        helper._find("Refresh Devices", timeout=5).click()
        time.sleep(2)

        # Scroll back to top
        alice.find_element(
            AppiumBy.ANDROID_UIAUTOMATOR,
            'new UiScrollable(new UiSelector().scrollable(true))'
            '.scrollToBeginning(5)'
        )

        # Should still see the settings page after refresh
        helper._find("Microphone", timeout=10)
