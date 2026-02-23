"""
E2E UI tests for desktop platforms (Linux, Windows, macOS).

These tests launch the real app binary, move the actual mouse cursor to UI
elements via platform accessibility APIs, and click them — just like a human.

Platform dispatch:
- Linux (linux-a11y): AT-SPI + pyautogui → LinuxDesktopHelper
- Windows: pywinauto + UIA → WindowsAppHelper
- macOS: atomacos + pyautogui → MacosAppHelper
- Linux (linux): Shelf HTTP → LinuxAppHelper (also works)

The `alice` fixture from conftest.py creates the correct helper based on
ZAJEL_TEST_PLATFORM. On desktop platforms, alice IS the helper (no wrapping
via app_helper needed).
"""

import pytest

from platforms import get_platform

PLATFORM = get_platform()

# Skip entire module if running on Android or iOS (use Appium tests instead)
pytestmark = [
    pytest.mark.desktop,
    pytest.mark.skipif(
        PLATFORM in ("android", "ios"),
        reason="Desktop UI tests only run on linux/linux-a11y/windows/macos",
    ),
]


class TestDesktopAppLaunch:
    """Verify the app launches and reaches the home screen."""

    @pytest.mark.single_device
    def test_app_launches_home_screen(self, alice):
        """App launches and shows the home screen with 'Zajel' title."""
        # alice fixture already calls launch() + wait_for_app_ready()
        # If we get here, the app launched and the home screen is visible.
        alice.find_by_name("Zajel", timeout=15)


class TestDesktopNavigation:
    """Test navigating between main app sections using real cursor clicks."""

    @pytest.mark.single_device
    def test_navigate_to_connect(self, alice):
        """Navigate to the Connect screen and verify 'My Code' is visible."""
        alice.navigate_to_connect()
        alice.find_by_name("My Code", timeout=10)
        alice.go_back_to_home()

    @pytest.mark.single_device
    def test_navigate_to_channels(self, alice):
        """Navigate to the Channels screen."""
        alice.navigate_to_channels()
        alice.find_by_name("Channels", timeout=5)
        alice.go_back_to_home()

    @pytest.mark.single_device
    def test_navigate_to_groups(self, alice):
        """Navigate to the Groups screen."""
        alice.navigate_to_groups()
        alice.find_by_name("Groups", timeout=5)
        alice.go_back_to_home()

    @pytest.mark.single_device
    def test_navigate_to_settings(self, alice):
        """Navigate to Settings and verify key sections are visible."""
        alice.navigate_to_settings()
        alice.find_by_name("Profile", timeout=5)
        alice.go_back_to_home()

    @pytest.mark.single_device
    def test_navigate_to_connect_shows_pairing_code(self, alice):
        """Navigate to Connect and verify a 6-char pairing code appears."""
        alice.navigate_to_connect()
        code = alice.get_pairing_code_from_connect_screen()
        assert code is not None, "Pairing code should be displayed"
        assert len(code) == 6, f"Pairing code should be 6 chars, got {len(code)}"
        assert code.isalnum(), f"Pairing code should be alphanumeric, got '{code}'"
        assert code.isupper(), f"Pairing code should be uppercase, got '{code}'"
        alice.go_back_to_home()
