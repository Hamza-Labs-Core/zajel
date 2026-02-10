"""
Pytest fixtures for E2E tests.

Provides fixtures for:
- Single device (alice, bob)
- Device pairs for P2P testing
- All available devices
- Headless client (HeadlessBob) for cross-platform testing
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import threading
import pytest

from config import SIGNALING_URL

try:
    from appium import webdriver
    from appium.options.android import UiAutomator2Options
    from config import get_server_url, APK_PATH, SERVER_COUNT, APP_LAUNCH_TIMEOUT, ADB_PATH
    HAS_APPIUM = True
except ImportError:
    HAS_APPIUM = False
    SERVER_COUNT = 0
    APP_LAUNCH_TIMEOUT = 60

ARTIFACTS_DIR = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")

PACKAGE_NAME = "com.zajel.zajel"

# Store active drivers for failure diagnostics
_active_drivers: dict = {}


@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Capture screenshot and page source on test failure."""
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        safe_name = item.nodeid.replace("/", "_").replace("::", "__")
        for name, driver in _active_drivers.items():
            try:
                screenshot_path = os.path.join(
                    ARTIFACTS_DIR, f"fail_{safe_name}_{name}.png"
                )
                driver.save_screenshot(screenshot_path)
                print(f"Screenshot saved: {screenshot_path}")
            except Exception as e:
                print(f"Failed to save screenshot for {name}: {e}")
            try:
                source_path = os.path.join(
                    ARTIFACTS_DIR, f"fail_{safe_name}_{name}_source.xml"
                )
                source = driver.page_source
                if source:
                    with open(source_path, "w") as f:
                        f.write(source)
                    print(f"Page source saved: {source_path}")
            except Exception as e:
                print(f"Failed to save page source for {name}: {e}")


def _require_appium():
    """Skip test if Appium is not installed."""
    if not HAS_APPIUM:
        pytest.skip("Appium not installed — skipping emulator tests")


def create_driver(server_index: int, device_name: str = "emulator") -> webdriver.Remote:
    """Create an Appium driver for the server at given index.

    Each Appium server is pre-bound to a specific emulator via --default-capabilities
    in CI. The udid is also set here to ensure the correct device is targeted.
    Emulator ports follow the pattern: 5554, 5556, 5558, etc.
    """
    # Clear app data before each test to remove stale peers from previous runs.
    # Without this, the app accumulates trusted peers across runs and floods
    # the signaling server with reconnection attempts, preventing new pairings.
    emulator_port = 5554 + (server_index * 2)
    udid = f"emulator-{emulator_port}"
    try:
        subprocess.run(
            [ADB_PATH, "-s", udid, "shell", "pm", "clear", PACKAGE_NAME],
            capture_output=True, timeout=15
        )
    except Exception:
        pass  # App may not be installed yet on first run

    # Re-grant runtime permissions that pm clear revoked.
    # autoGrantPermissions only works at install time, not after pm clear.
    for perm in [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.POST_NOTIFICATIONS",
    ]:
        try:
            subprocess.run(
                [ADB_PATH, "-s", udid, "shell", "pm", "grant", PACKAGE_NAME, perm],
                capture_output=True, timeout=10
            )
        except Exception:
            pass

    options = UiAutomator2Options()
    options.app = APK_PATH
    options.device_name = f"{device_name}-{server_index}"
    options.automation_name = "UiAutomator2"
    options.new_command_timeout = 300

    # Bind to the specific emulator
    options.udid = udid

    options.no_reset = True  # Don't clear app data between tests
    options.full_reset = False  # Don't uninstall/reinstall app

    # Android-specific settings
    options.auto_grant_permissions = True

    # Timeouts
    options.set_capability("appWaitDuration", 120000)  # 2 minutes to wait for app
    options.set_capability("uiautomator2ServerLaunchTimeout", 180000)  # 3 min for server
    options.set_capability("uiautomator2ServerInstallTimeout", 180000)  # 3 min for install
    options.set_capability("adbExecTimeout", 180000)  # 3 min for adb commands
    options.set_capability("androidInstallTimeout", 180000)  # 3 min for APK install
    options.set_capability("ignoreHiddenApiPolicyError", True)  # Ignore hidden API errors

    # Skip some initialization to speed up
    options.set_capability("skipUnlock", True)  # Don't try to unlock screen
    options.set_capability("disableWindowAnimation", True)  # Disable animations for speed

    # Force launch the app even with noReset
    options.set_capability("forceAppLaunch", True)

    driver = webdriver.Remote(get_server_url(server_index), options=options)
    # Keep implicit wait short so WebDriverWait can poll effectively
    # (implicit wait blocks each findElement call; long values + WebDriverWait = only 1 attempt)
    driver.implicitly_wait(5)

    return driver


@pytest.fixture(scope="function")
def alice():
    """First device (Alice) - always available."""
    _require_appium()
    driver = create_driver(0, "alice")
    _active_drivers["alice"] = driver
    yield driver
    _active_drivers.pop("alice", None)
    driver.quit()


@pytest.fixture(scope="function")
def bob():
    """Second device (Bob) - requires at least 2 servers."""
    _require_appium()
    if SERVER_COUNT < 2:
        pytest.skip("Need at least 2 Appium servers for this test")
    driver = create_driver(1, "bob")
    _active_drivers["bob"] = driver
    yield driver
    _active_drivers.pop("bob", None)
    driver.quit()


@pytest.fixture(scope="function")
def charlie():
    """Third device (Charlie) - requires at least 3 servers."""
    _require_appium()
    if SERVER_COUNT < 3:
        pytest.skip("Need at least 3 Appium servers for this test")
    driver = create_driver(2, "charlie")
    _active_drivers["charlie"] = driver
    yield driver
    _active_drivers.pop("charlie", None)
    driver.quit()


@pytest.fixture(scope="function")
def device_pair(alice, bob):
    """Two devices ready for P2P testing."""
    return {"alice": alice, "bob": bob}


@pytest.fixture(scope="function")
def all_devices():
    """All available devices."""
    _require_appium()
    drivers = []
    for i in range(SERVER_COUNT):
        driver = create_driver(i, f"device-{i}")
        drivers.append(driver)

    yield drivers

    for driver in drivers:
        driver.quit()


# Helper functions for tests
class AppHelper:
    """Helper methods for interacting with the Zajel app.

    The Zajel app is a Flutter app with this navigation:
    - Home screen: shows "Zajel" title, pairing code as "Code: XXXXXX",
      status indicator (Online/Connecting.../Offline), peer list
    - Connect screen (/connect): tabs "My Code" / "Scan" / "Link Web"
      "My Code" tab shows QR code, pairing code in large text,
      a TextField (hint: "Enter pairing code"), and "Connect" button
    - Settings screen (/settings): profile, privacy, connection info
    """

    def __init__(self, driver: webdriver.Remote):
        self.driver = driver

    def _dismiss_system_dialog(self):
        """Dismiss 'System UI isn't responding' or similar ANR dialogs."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            wait_btn = self.driver.find_element(
                "id", "android:id/aerr_wait"
            )
            print("Dismissing 'System UI isn't responding' dialog")
            wait_btn.click()
        except NoSuchElementException:
            pass

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the app to be fully loaded and showing the home screen.

        Detection strategy:
        1. Dismiss any ANR dialogs (System UI not responding)
        2. Wait for the actual home screen content — the "Zajel" title or
           "Connect" FAB — not just any android.view.View (which also
           matches the loading spinner shown during initialization).
        """
        import time as _time
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Brief wait for app process to start
        _time.sleep(3)

        # Log current app state for CI debugging
        try:
            activity = self.driver.current_activity
            print(f"[wait_for_app_ready] current_activity={activity}")
        except Exception as e:
            print(f"[wait_for_app_ready] failed to get activity: {e}")

        # Dismiss any ANR dialog that might be blocking
        self._dismiss_system_dialog()

        # Wait for the actual home screen to render.
        # The home screen has the "Zajel" AppBar title and a "Connect" FAB.
        # The loading screen only shows a CircularProgressIndicator which
        # does NOT have these text elements.
        home_screen_xpath = (
            "//*[@package='com.zajel.zajel' and "
            "(contains(@text, 'Zajel') or contains(@content-desc, 'Zajel') or "
            "contains(@text, 'Connect') or contains(@content-desc, 'Connect'))]"
        )
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((By.XPATH, home_screen_xpath))
            )
        except Exception:
            # Try dismissing dialog again and retry once
            self._dismiss_system_dialog()
            _time.sleep(3)
            try:
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.XPATH, home_screen_xpath))
                )
            except Exception:
                print("=== PAGE SOURCE (app not ready) ===")
                try:
                    source = self.driver.page_source
                    print(source[:20000] if source else "EMPTY PAGE SOURCE")
                except Exception as e:
                    print(f"Failed to get page source: {e}")
                print("=== END PAGE SOURCE ===")
                raise

        # Dismiss onboarding screen if present (first launch after pm clear)
        self._dismiss_onboarding()

    def _dismiss_onboarding(self):
        """Dismiss the onboarding screen if present (first launch after pm clear)."""
        import time as _time
        from selenium.webdriver.common.by import By

        try:
            skip_btn = self.driver.find_element(
                By.XPATH,
                "//*[@package='com.zajel.zajel' and "
                "(contains(@text, 'Skip') or contains(@content-desc, 'Skip'))]"
            )
            print("[wait_for_app_ready] Onboarding screen detected, tapping Skip")
            skip_btn.click()
            _time.sleep(2)
            # Re-wait for the actual home screen after onboarding dismissal
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            home_screen_xpath = (
                "//*[@package='com.zajel.zajel' and "
                "(contains(@text, 'Code:') or contains(@content-desc, 'Code:') or "
                "contains(@text, 'Online') or contains(@content-desc, 'Online') or "
                "contains(@text, 'Connecting') or contains(@content-desc, 'Connecting') or "
                "contains(@text, 'Offline') or contains(@content-desc, 'Offline'))]"
            )
            WebDriverWait(self.driver, 15).until(
                EC.presence_of_element_located((By.XPATH, home_screen_xpath))
            )
            print("[wait_for_app_ready] Home screen confirmed after onboarding dismissal")
        except Exception:
            pass  # No onboarding screen — already on home

    def _find(self, text, timeout=10, partial=True):
        """Find an element by text, checking @text, @content-desc, and @tooltip-text.

        Flutter renders its own widgets and may expose text content via any
        of these attributes depending on the widget type and semantics
        configuration. In release builds on Android 12+ (API 31), IconButton
        tooltips appear as @tooltip-text rather than @content-desc.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        if partial:
            xpath = (
                f"//*[contains(@text, '{text}') or "
                f"contains(@content-desc, '{text}') or "
                f"contains(@tooltip-text, '{text}')]"
            )
        else:
            xpath = (
                f"//*[@text='{text}' or "
                f"@content-desc='{text}' or "
                f"@tooltip-text='{text}']"
            )

        try:
            return WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((By.XPATH, xpath))
            )
        except Exception:
            print(f"=== _find FAILED: text='{text}' partial={partial} timeout={timeout} ===")
            try:
                source = self.driver.page_source
                # Truncate to avoid flooding logs
                print(source[:15000] if source else "EMPTY PAGE SOURCE")
            except Exception as e:
                print(f"Failed to get page source: {e}")
            print("=== END PAGE SOURCE ===")
            raise

    def _scroll_down(self, times=1):
        """Scroll down on the current screen."""
        import time as _time
        screen_size = self.driver.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.7)
        end_y = int(screen_size['height'] * 0.3)
        for _ in range(times):
            self.driver.swipe(center_x, start_y, center_x, end_y, 500)
            _time.sleep(0.5)

    def navigate_to_connect(self):
        """Navigate to the Connect screen by tapping the FAB or QR icon.

        The home screen has multiple elements containing "Connect":
        - "Connected Peers" section header (not clickable)
        - "Connect via QR code" button
        - "Connect" FAB button
        - "Connect to peer" app bar icon (tooltip-text only)

        We target the clickable FAB or app bar icon specifically.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        try:
            # Target the "Connect to peer" app bar button (tooltip-text) or
            # the exact "Connect" FAB (content-desc), both clickable
            btn = WebDriverWait(self.driver, 5).until(
                EC.element_to_be_clickable((
                    By.XPATH,
                    "//*[("
                    "@tooltip-text='Connect to peer' or "
                    "@content-desc='Connect to peer' or "
                    "((@content-desc='Connect' or @text='Connect') "
                    "and not(contains(@content-desc, 'Connected')) "
                    "and not(contains(@content-desc, 'QR')))"
                    ") and @clickable='true']"
                ))
            )
            btn.click()
        except Exception:
            # Last resort: click "Connect via QR code"
            self._find("Connect via QR code", timeout=5).click()

        # Wait for Connect screen to load
        self._find("My Code")

    def wait_for_signaling_connected(self, timeout: int = 60):
        """Wait until signaling server connects and pairing code appears."""
        import time as _time
        from selenium.common.exceptions import NoSuchElementException

        deadline = _time.time() + timeout
        while _time.time() < deadline:
            try:
                el = self.driver.find_element(
                    "xpath",
                    "//*[starts-with(@text, 'Code: ') or starts-with(@content-desc, 'Code: ')]"
                )
                text = el.text or el.get_attribute("content-desc") or ""
                if text.startswith('Code: '):
                    return
            except NoSuchElementException:
                pass
            _time.sleep(2)

        raise TimeoutError("Signaling server did not connect within timeout")

    def get_pairing_code(self) -> str:
        """Get the pairing code from the home screen ('Code: XXXXXX' text)."""
        el = self.driver.find_element(
            "xpath",
            "//*[starts-with(@text, 'Code: ') or starts-with(@content-desc, 'Code: ')]"
        )
        text = el.text or el.get_attribute("content-desc") or ""
        return text.replace('Code: ', '').strip()

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code from the Connect screen (large 6-char display).

        Waits for a 6-character uppercase alphanumeric string to appear.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Match 6-char uppercase text (the pairing code)
        xpath = (
            "//*["
            "(string-length(@text) = 6 and translate(@text, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = @text)"
            " or "
            "(string-length(@content-desc) = 6 and translate(@content-desc, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = @content-desc)"
            "]"
        )
        # 60s timeout: on CI cold starts, signaling connection (DNS +
        # bootstrap discovery + WebSocket handshake) can take 30-50s.
        el = WebDriverWait(self.driver, 60).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        )
        return (el.text or el.get_attribute("content-desc") or "").strip()

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code on the Connect screen and submit."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time

        # The TextField may be below the fold on small screens (320x640).
        # Flutter's SingleChildScrollView won't add offscreen children to
        # the accessibility tree until they're scrolled into view.
        # Scroll down first to reveal the "Enter pairing code" input.
        screen_size = self.driver.get_window_size()
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)
        center_x = int(screen_size['width'] * 0.5)

        for attempt in range(3):
            try:
                input_field = WebDriverWait(self.driver, 5).until(
                    EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
                )
                break
            except Exception:
                # Scroll down to reveal the input field
                self.driver.swipe(center_x, start_y, center_x, end_y, 500)
                time.sleep(1)
        else:
            # Final attempt with longer timeout
            input_field = WebDriverWait(self.driver, 10).until(
                EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
            )

        input_field.click()
        # Use IME-based typing instead of setText (send_keys) because
        # Flutter's TextEditingController is not updated by UiAutomator2's
        # ACTION_SET_TEXT. The mobile: type command sends keystrokes through
        # the input method, which properly flows through Flutter's text
        # input pipeline into the TextEditingController.
        self.driver.execute_script('mobile: type', {'text': code})

        # Tap the "Connect" ElevatedButton (exact match to avoid
        # hitting "Connect via QR code" which also contains "Connect")
        connect_btn = WebDriverWait(self.driver, 5).until(
            EC.element_to_be_clickable((
                By.XPATH,
                "//*[(@text='Connect' or @content-desc='Connect') and @clickable='true']"
            ))
        )
        connect_btn.click()

    def go_back_to_home(self):
        """Navigate back to the home screen.

        Only presses back if we're not already on the home screen
        (detected by pane-title='Zajel' or the presence of "Connected Peers").
        """
        from selenium.common.exceptions import NoSuchElementException
        try:
            # Check if we're already on the home screen (Flutter pane-title)
            self.driver.find_element(
                "xpath",
                "//*[@package='com.zajel.zajel' and "
                "contains(@content-desc, 'Connected Peers')]"
            )
            # Already on home screen
            return
        except (NoSuchElementException, Exception):
            pass
        self.driver.back()

    def open_chat_with_peer(self, peer_name: str = None):
        """Tap on a connected peer to open the chat screen.

        Flutter merges ListTile title+subtitle into a single content-desc,
        e.g. "Peer ABC123\nConnected". We match on "Peer" to avoid hitting
        the "Connected Peers" section header.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        if peer_name:
            xpath = (
                f"//*[contains(@content-desc, '{peer_name}') and "
                f"contains(@content-desc, 'Connected')]"
            )
        else:
            # Match peer cards: contain "Peer" AND "Connected" but not the header
            xpath = (
                "//*[contains(@content-desc, 'Peer') and "
                "contains(@content-desc, 'Connected') and "
                "not(contains(@content-desc, 'Connected Peers'))]"
            )
        WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        ).click()

    def send_message(self, text: str):
        """Type and send a message in the chat screen."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.click()
        # Use mobile: type for Flutter TextEditingController compatibility
        self.driver.execute_script('mobile: type', {'text': text})

        # Tap send button
        send_btn = WebDriverWait(self.driver, 5).until(
            EC.element_to_be_clickable((
                By.XPATH,
                "//*[contains(@content-desc, 'Send message') or "
                "contains(@content-desc, 'Send')]"
            ))
        )
        send_btn.click()

    def has_message(self, text: str) -> bool:
        """Check if a message with the given text is visible."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            self._find(text, timeout=5)
            return True
        except Exception:
            return False

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if a peer shows as 'Connected' on the home screen.

        Flutter merges ListTile title+subtitle into a single content-desc
        separated by newlines, e.g. "Peer ABC123\nConnected".
        We use contains() to match "Connected" within that merged text.
        """
        from selenium.common.exceptions import NoSuchElementException
        try:
            if peer_name:
                self.driver.find_element(
                    "xpath",
                    f"//*[contains(@text, '{peer_name}') or contains(@content-desc, '{peer_name}')]"
                )
            # Use contains() since Flutter merges title+subtitle in content-desc
            self.driver.find_element(
                "xpath",
                "//*[contains(@content-desc, 'Connected') and "
                "not(contains(@content-desc, 'Connected Peers'))]"
            )
            return True
        except (NoSuchElementException, Exception):
            return False

    def is_status_online(self) -> bool:
        """Check if the signaling status shows 'Online'."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            self.driver.find_element(
                "xpath", "//*[@text='Online' or @content-desc='Online']"
            )
            return True
        except NoSuchElementException:
            return False

    # ── Call-related helpers ──────────────────────────────────────────

    def start_voice_call(self):
        """In chat screen, tap the 'Voice call' tooltip button."""
        self._find("Voice call", timeout=10).click()

    def start_video_call(self):
        """In chat screen, tap the 'Video call' tooltip button."""
        self._find("Video call", timeout=10).click()

    def get_call_status(self) -> str:
        """Return visible call status text.

        Possible values: 'Calling...', 'Connecting...', 'Call ended',
        or a duration string like '00:05'.
        """
        for status_text in ['Calling...', 'Connecting...', 'Call ended']:
            try:
                self._find(status_text, timeout=2)
                return status_text
            except Exception:
                pass
        # Check for duration timer (connected state)
        try:
            self._find('00:', timeout=2)
            return 'connected'
        except Exception:
            return 'unknown'

    def tap_call_button(self, label: str):
        """Tap a call control button by its label text.

        Labels: 'Mute', 'Unmute', 'End', 'Flip', 'Video Off', 'Video On'.
        """
        self._find(label, timeout=10, partial=False).click()

    def accept_incoming_call(self, with_video: bool = False):
        """Accept an incoming call.

        For audio calls: taps 'Accept'.
        For video calls: taps 'Video' (with_video=True) or 'Audio' (False).
        """
        if with_video:
            self._find("Video", timeout=15, partial=False).click()
        else:
            # 'Accept' for audio calls, 'Audio' for video-call-as-audio
            try:
                self._find("Accept", timeout=5, partial=False).click()
            except Exception:
                self._find("Audio", timeout=5, partial=False).click()

    def reject_incoming_call(self):
        """Tap 'Decline' on incoming call dialog."""
        self._find("Decline", timeout=15, partial=False).click()

    def has_incoming_call_dialog(self, timeout: int = 15) -> bool:
        """Check if an incoming call dialog is visible.

        Polls for 'Incoming call' or 'Incoming video call' text, as well as
        the 'Decline' button which is unique to the incoming call dialog.
        """
        import time as _time
        deadline = _time.time() + timeout
        while _time.time() < deadline:
            try:
                self._find("Incoming", timeout=2)
                return True
            except Exception:
                pass
            try:
                self._find("Decline", timeout=1, partial=False)
                return True
            except Exception:
                pass
            _time.sleep(1)
        return False

    def end_call(self):
        """Tap 'End' button to hang up."""
        self._find("End", timeout=10, partial=False).click()

    def wait_for_call_connected(self, timeout: int = 30) -> bool:
        """Wait until call shows a duration timer ('00:'), indicating connected."""
        import time as _time
        deadline = _time.time() + timeout
        while _time.time() < deadline:
            try:
                self._find('00:', timeout=2)
                return True
            except Exception:
                _time.sleep(1)
        return False

    # ── Settings helpers ─────────────────────────────────────────────

    def navigate_to_settings(self):
        """Tap 'Settings' tooltip button from home screen app bar."""
        self._find("Settings", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def change_display_name(self, name: str):
        """In settings, tap display name row, clear field, type new name, save."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Tap the profile/display name row
        self._find("Tap to change display name", timeout=10).click()
        import time as _time
        _time.sleep(1)

        # Find the EditText in the dialog, clear it, type new name
        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.clear()
        self.driver.execute_script('mobile: type', {'text': name})

        # Tap Save
        self._find("Save", timeout=5, partial=False).click()
        _time.sleep(1)

    def tap_settings_option(self, text: str):
        """Tap a settings row by its title text."""
        self._find(text, timeout=10).click()
        import time as _time
        _time.sleep(1)

    def confirm_dialog(self, button_text: str):
        """Tap a button in an alert dialog (e.g. 'Block', 'Clear All', 'Unblock')."""
        self._find(button_text, timeout=10, partial=False).click()
        import time as _time
        _time.sleep(1)

    def dismiss_dialog(self):
        """Tap 'Cancel' in an alert dialog."""
        self._find("Cancel", timeout=10, partial=False).click()
        import time as _time
        _time.sleep(1)

    # ── Peer management helpers ──────────────────────────────────────

    def open_peer_menu(self):
        """Tap the overflow menu (more_vert) on the first visible peer card."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # The more_vert icon button has content-desc 'Show menu'
        menu_btn = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Show menu') or "
                "contains(@content-desc, 'More options')]"
            ))
        )
        menu_btn.click()
        import time as _time
        _time.sleep(1)

    def tap_menu_option(self, option: str):
        """Tap a popup menu item by text (e.g. 'Block')."""
        self._find(option, timeout=10).click()
        import time as _time
        _time.sleep(1)

    # ── Notification settings helpers ───────────────────────────────

    def navigate_to_notification_settings(self):
        """Navigate to Settings > Notifications."""
        self.navigate_to_settings()
        self.tap_settings_option("Notifications")

    def toggle_dnd(self):
        """Toggle the Do Not Disturb switch in notification settings."""
        self._find("Do Not Disturb", timeout=10).click()

    def toggle_sound(self):
        """Toggle the Sound switch in notification settings."""
        self._find("Sound", timeout=10).click()

    def mute_peer(self, peer_name: str):
        """Mute a peer from the notification settings muted peers list."""
        self._find(peer_name, timeout=10).click()

    # ── Media settings helpers ───────────────────────────────────────

    def navigate_to_media_settings(self):
        """Navigate to Settings > Audio & Video."""
        self.navigate_to_settings()
        # Scroll down — "Audio & Video" may be below the fold on small screens
        # (e.g. after the Appearance section was added to settings)
        self._scroll_down()
        self.tap_settings_option("Audio & Video")

    # ── Emoji helpers ────────────────────────────────────────────────

    def open_emoji_picker(self):
        """Tap the emoji button in the chat input bar."""
        self._find("Emoji", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def close_emoji_picker(self):
        """Tap the keyboard button to close the emoji picker."""
        self._find("Keyboard", timeout=10).click()
        import time as _time
        _time.sleep(1)

    # ── Contact helpers ──────────────────────────────────────────────

    def navigate_to_contacts(self):
        """Tap the contacts button from home screen."""
        self._find("Contacts", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def set_peer_alias(self, alias: str):
        """In contact detail, set a custom alias."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        self._find("Edit alias", timeout=10).click()
        import time as _time
        _time.sleep(1)

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.clear()
        self.driver.execute_script('mobile: type', {'text': alias})

        self._find("Save", timeout=5, partial=False).click()
        _time.sleep(1)

    def search_contacts(self, query: str):
        """Type in the contacts search bar."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        search_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        search_field.click()
        self.driver.execute_script('mobile: type', {'text': query})

    def open_contact_detail(self, name: str):
        """Tap a contact in the contacts list to open detail."""
        self._find(name, timeout=10).click()
        import time as _time
        _time.sleep(1)

    # ── Offline peer helpers ─────────────────────────────────────────

    def is_peer_offline(self, peer_name: str = None) -> bool:
        """Check if a peer shows as 'Offline' on the home screen."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            if peer_name:
                self.driver.find_element(
                    "xpath",
                    f"//*[contains(@content-desc, '{peer_name}') and "
                    f"contains(@content-desc, 'Last seen')]"
                )
            else:
                self.driver.find_element(
                    "xpath",
                    "//*[contains(@content-desc, 'Last seen')]"
                )
            return True
        except (NoSuchElementException, Exception):
            return False

    def get_last_seen(self, peer_name: str = None) -> str:
        """Get the 'Last seen' text for an offline peer."""
        try:
            if peer_name:
                el = self.driver.find_element(
                    "xpath",
                    f"//*[contains(@content-desc, '{peer_name}') and "
                    f"contains(@content-desc, 'Last seen')]"
                )
            else:
                el = self.driver.find_element(
                    "xpath",
                    "//*[contains(@content-desc, 'Last seen')]"
                )
            text = el.get_attribute("content-desc") or el.text or ""
            # Extract "Last seen X ago" from the merged content-desc
            for line in text.split('\n'):
                if 'Last seen' in line:
                    return line.strip()
            return text
        except Exception:
            return ""

    # ── Blocked list helpers ─────────────────────────────────────────

    def navigate_to_blocked_list(self):
        """Navigate to Settings > Blocked Users."""
        self.navigate_to_settings()
        self.tap_settings_option("Blocked Users")

    def remove_peer_permanently(self, peer_name: str):
        """Remove a peer permanently from blocked list via popup menu."""
        # Find and tap the menu on the blocked peer
        self._find(peer_name, timeout=10)
        # Tap the popup menu for this peer
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        # Find the popup trigger near the peer entry
        menu = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Show menu') or "
                "contains(@content-desc, 'More options') or "
                "contains(@content-desc, 'Popup')]"
            ))
        )
        menu.click()
        _time.sleep(1)

        self._find("Remove Permanently", timeout=10).click()
        _time.sleep(1)

        # Confirm the dialog
        self._find("Remove", timeout=10, partial=False).click()
        _time.sleep(1)

    # ── File transfer helpers ────────────────────────────────────────

    def tap_attach_file(self):
        """Tap the attach file button in chat input bar."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # attach_file icon — no tooltip, find by class near the input area
        attach_btn = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Attach') or "
                "contains(@content-desc, 'attach')]"
            ))
        )
        attach_btn.click()

    def select_file_in_picker(self, filename: str, timeout: int = 10) -> bool:
        """Select a file in the Android Documents UI file picker.

        After tap_attach_file() opens the system picker, this navigates
        the picker to find and tap the file by its @text attribute.

        The Documents UI (com.google.android.documentsui) shows recently
        accessed files by default. The file must be pushed via adb and
        indexed by the media scanner before calling this.

        Returns True if the file was found and tapped, False otherwise.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        try:
            # Wait for the file picker activity to load.
            # Look for the file by @text (Documents UI uses android:id/title).
            file_elem = WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((
                    By.XPATH,
                    f"//*[contains(@text, '{filename}')]"
                ))
            )
            file_elem.click()
            _time.sleep(2)
            return True
        except Exception:
            # File not in Recent — try navigating to Downloads via the drawer.
            try:
                # Tap "Show roots" hamburger menu
                roots_btn = self.driver.find_element(
                    By.XPATH,
                    "//*[@content-desc='Show roots']"
                )
                roots_btn.click()
                _time.sleep(1)

                # Tap "Downloads"
                downloads = self.driver.find_element(
                    By.XPATH,
                    "//*[contains(@text, 'Downloads')]"
                )
                downloads.click()
                _time.sleep(2)

                # Now find the file
                file_elem = WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((
                        By.XPATH,
                        f"//*[contains(@text, '{filename}')]"
                    ))
                )
                file_elem.click()
                _time.sleep(2)
                return True
            except Exception:
                return False


@pytest.fixture
def app_helper(request):
    """Factory fixture for creating AppHelper instances."""
    _require_appium()

    def _create_helper(driver):
        return AppHelper(driver)

    return _create_helper


# ── Headless Client Fixtures ─────────────────────────────────────

class HeadlessBob:
    """Synchronous wrapper around ZajelHeadlessClient for pytest.

    Runs the async event loop in a background thread so that synchronous
    test code can call connect(), send_text(), etc. directly.
    """

    def __init__(self, signaling_url: str, **kwargs):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

        from zajel.client import ZajelHeadlessClient
        self._client = ZajelHeadlessClient(signaling_url=signaling_url, **kwargs)
        self.pairing_code = None
        self.connected_peer = None

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _run(self, coro, timeout=120):
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def connect(self) -> str:
        self.pairing_code = self._run(self._client.connect())
        return self.pairing_code

    def pair_with(self, code: str):
        self.connected_peer = self._run(self._client.pair_with(code))
        return self.connected_peer

    def wait_for_pair(self, timeout=60):
        self.connected_peer = self._run(
            self._client.wait_for_pair(timeout=timeout), timeout=timeout + 10
        )
        return self.connected_peer

    def send_text(self, peer_id: str, text: str):
        self._run(self._client.send_text(peer_id, text))

    def receive_message(self, timeout=30):
        return self._run(
            self._client.receive_message(timeout=timeout), timeout=timeout + 10
        )

    def send_file(self, peer_id: str, file_path: str):
        return self._run(self._client.send_file(peer_id, file_path))

    def receive_file(self, timeout=60):
        return self._run(
            self._client.receive_file(timeout=timeout), timeout=timeout + 10
        )

    def disconnect(self):
        try:
            self._run(self._client.disconnect(), timeout=10)
        except Exception:
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)


@pytest.fixture(scope="function")
def headless_bob():
    """Headless client acting as Bob for cross-platform tests.

    Connects to the signaling server, auto-accepts pair requests.
    Tests use headless_bob.pairing_code to pair Alice (Flutter app) with Bob.
    """
    if not SIGNALING_URL:
        pytest.skip("SIGNALING_URL not set — headless tests require a signaling server")

    bob = HeadlessBob(
        signaling_url=SIGNALING_URL,
        name="HeadlessBob",
        auto_accept_pairs=True,
        log_level="DEBUG",
    )
    bob.connect()
    yield bob
    bob.disconnect()
