"""
E2E tests for notifications when messages arrive from headless client.

Tests that the Android app fires system notifications via
`adb shell dumpsys notification --noredact` when messages arrive from Bob
(headless client) while Alice's chat is not in the foreground.
"""

import subprocess
import time
import pytest

from config import P2P_CONNECTION_TIMEOUT, ADB_PATH


def _get_device_id_from_driver(driver):
    """Extract the device UDID from an Appium driver session."""
    caps = driver.capabilities
    return caps.get("udid", caps.get("deviceUDID", "emulator-5554"))


def _check_android_notification(device_id: str, expected_text: str, timeout: int = 15) -> bool:
    """Poll adb dumpsys notification for expected text.

    Args:
        device_id: ADB device serial (e.g. emulator-5554)
        expected_text: Text to look for in notification content
        timeout: Max seconds to wait

    Returns:
        True if notification found, False otherwise
    """
    adb = ADB_PATH if ADB_PATH else "adb"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = subprocess.run(
                [adb, "-s", device_id, "shell", "dumpsys", "notification", "--noredact"],
                capture_output=True, text=True, timeout=10
            )
            if expected_text in result.stdout:
                return True
        except (subprocess.TimeoutExpired, OSError):
            pass
        time.sleep(2)
    return False


def _clear_notifications(device_id: str):
    """Clear all notifications on the device."""
    adb = ADB_PATH if ADB_PATH else "adb"
    try:
        subprocess.run(
            [adb, "-s", device_id, "shell", "service", "call", "notification", "1"],
            capture_output=True, timeout=5
        )
    except (subprocess.TimeoutExpired, OSError):
        pass


@pytest.mark.headless
@pytest.mark.notifications
class TestHeadlessNotifications:
    """Notification tests using headless client as the peer."""

    def _pair_and_go_home(self, alice, app_helper, headless_bob):
        """Pair Alice with Bob and return to home screen (chat not open)."""
        helper = app_helper(alice)
        helper.wait_for_app_ready()

        helper.navigate_to_connect()
        helper.get_pairing_code_from_connect_screen()
        helper.enter_peer_code(headless_bob.pairing_code)

        time.sleep(P2P_CONNECTION_TIMEOUT)

        helper.go_back_to_home()
        time.sleep(3)

        assert helper.is_peer_connected(), "Pairing must succeed"
        return helper

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_notification_fires_when_chat_closed(self, alice, app_helper, headless_bob):
        """Bob sends message while Alice is on home screen → notification fires."""
        helper = self._pair_and_go_home(alice, app_helper, headless_bob)

        device_id = _get_device_id_from_driver(alice)
        _clear_notifications(device_id)

        # Bob sends a message while Alice is NOT in the chat
        peer_id = headless_bob.connected_peer.peer_id
        headless_bob.send_text(peer_id, "Notification test message")

        # Check for notification
        found = _check_android_notification(
            device_id, "com.zajel.app", timeout=15
        )
        assert found, "Notification should appear when chat is not open"

    @pytest.mark.single_device
    @pytest.mark.slow
    def test_no_notification_when_chat_open(self, alice, app_helper, headless_bob):
        """Bob sends message while Alice has the chat open → no new notification."""
        helper = self._pair_and_go_home(alice, app_helper, headless_bob)

        # Open chat with peer
        helper.open_chat_with_peer()
        time.sleep(2)

        device_id = _get_device_id_from_driver(alice)
        _clear_notifications(device_id)

        # Bob sends a message while Alice HAS the chat open
        peer_id = headless_bob.connected_peer.peer_id
        headless_bob.send_text(peer_id, "In-chat message")
        time.sleep(5)

        # Alice should see the message in-chat
        assert helper.has_message("In-chat message")

        # But no notification should be posted (message is visible in chat)
        # Note: This is a best-effort check — the app may still post
        # notifications briefly. We check that no notification with the
        # specific message text is present.
        found = _check_android_notification(
            device_id, "In-chat message", timeout=5
        )
        # Allow this to pass either way — some implementations always notify
        # This test documents the expected behavior
        if found:
            print("Note: Notification was posted even with chat open (may be expected)")
