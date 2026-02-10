"""
Smoke tests for the Zajel Flutter desktop app (Windows/Linux).

Verifies that the app launches, displays the home screen, and basic
UI elements are visible. These tests run without a signaling server.

On Android, use test_pairing.py::TestPairing::test_app_launches_successfully instead.
"""

import pytest


@pytest.mark.smoke
@pytest.mark.single_device
@pytest.mark.windows
class TestSmoke:
    """Basic smoke tests — does the app even launch?"""

    def test_app_launches_successfully(self, alice):
        """App launches and home screen is visible."""
        # The alice fixture already waits for "Zajel" to appear
        # If we reach here, the app launched successfully
        assert alice.main_window is not None

    def test_home_screen_elements_visible(self, alice):
        """Home screen shows expected UI elements."""
        # The Connect FAB should be visible
        try:
            alice.find_by_name("Connect", timeout=10)
            has_connect = True
        except TimeoutError:
            has_connect = False

        assert has_connect, "Connect button should be visible on home screen"

    def test_navigate_to_settings(self, alice):
        """Can navigate to Settings screen."""
        alice.navigate_to_settings()
        # Settings screen should have some identifiable content
        try:
            alice.find_by_name("Settings", timeout=5)
            found = True
        except TimeoutError:
            found = False

        assert found, "Settings screen should be visible"
        alice.go_back_to_home()

    def test_navigate_to_connect_screen(self, alice):
        """Can navigate to Connect screen."""
        alice.navigate_to_connect()
        # Connect screen should show "My Code" section
        try:
            alice.find_by_name("My Code", timeout=10)
            found = True
        except TimeoutError:
            found = False

        assert found, "Connect screen should show 'My Code' section"
        alice.go_back_to_home()
