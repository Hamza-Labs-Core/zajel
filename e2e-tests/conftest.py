"""
Pytest fixtures for E2E tests.

Provides fixtures for:
- Single device (alice, bob)
- Device pairs for P2P testing
- All available devices
"""

import pytest
from appium import webdriver
from appium.options.android import UiAutomator2Options

from config import get_server_url, APK_PATH, SERVER_COUNT, APP_LAUNCH_TIMEOUT


def create_driver(server_index: int, device_name: str = "emulator") -> webdriver.Remote:
    """Create an Appium driver for the server at given index.

    Each Appium server is pre-bound to a specific emulator via --default-capabilities
    in CI. The udid is also set here to ensure the correct device is targeted.
    Emulator ports follow the pattern: 5554, 5556, 5558, etc.
    """
    options = UiAutomator2Options()
    options.app = APK_PATH
    options.device_name = f"{device_name}-{server_index}"
    options.automation_name = "UiAutomator2"
    options.new_command_timeout = 300

    # Bind to the specific emulator for this server index
    # Emulator console ports: 5554, 5556, 5558, ...
    emulator_port = 5554 + (server_index * 2)
    options.udid = f"emulator-{emulator_port}"

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
    driver.implicitly_wait(APP_LAUNCH_TIMEOUT)

    return driver


@pytest.fixture(scope="function")
def alice():
    """First device (Alice) - always available."""
    driver = create_driver(0, "alice")
    yield driver
    driver.quit()


@pytest.fixture(scope="function")
def bob():
    """Second device (Bob) - requires at least 2 servers."""
    if SERVER_COUNT < 2:
        pytest.skip("Need at least 2 Appium servers for this test")
    driver = create_driver(1, "bob")
    yield driver
    driver.quit()


@pytest.fixture(scope="function")
def charlie():
    """Third device (Charlie) - requires at least 3 servers."""
    if SERVER_COUNT < 3:
        pytest.skip("Need at least 3 Appium servers for this test")
    driver = create_driver(2, "charlie")
    yield driver
    driver.quit()


@pytest.fixture(scope="function")
def device_pair(alice, bob):
    """Two devices ready for P2P testing."""
    return {"alice": alice, "bob": bob}


@pytest.fixture(scope="function")
def all_devices():
    """All available devices."""
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

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the app to be fully loaded (home screen with 'Zajel' title).

        Flutter exposes text via @text or @content-desc depending on the widget.
        AppBar title typically shows up as @text, but we check both to be safe.
        """
        import time as _time
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Dump initial page source after a brief wait for debugging
        _time.sleep(5)
        print("=== INITIAL PAGE SOURCE (after 5s) ===")
        try:
            source = self.driver.page_source
            print(source[:5000] if source else "EMPTY PAGE SOURCE")
        except Exception as e:
            print(f"Failed to get page source: {e}")
        print("=== END INITIAL PAGE SOURCE ===")

        try:
            WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((
                    By.XPATH,
                    "//*[contains(@text, 'Zajel') or contains(@content-desc, 'Zajel')]"
                ))
            )
        except Exception:
            # Dump page source for debugging
            print("=== PAGE SOURCE (app not ready) ===")
            try:
                source = self.driver.page_source
                print(source[:5000] if source else "EMPTY PAGE SOURCE")
            except Exception as e:
                print(f"Failed to get page source: {e}")
            print("=== END PAGE SOURCE ===")
            raise

    def _find(self, text, timeout=10, partial=True):
        """Find an element by text, checking both @text and @content-desc.

        Flutter renders its own widgets and may expose text content via either
        attribute depending on the widget type and semantics configuration.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        fn = "contains" if partial else ""
        if partial:
            xpath = f"//*[contains(@text, '{text}') or contains(@content-desc, '{text}')]"
        else:
            xpath = f"//*[@text='{text}' or @content-desc='{text}']"

        return WebDriverWait(self.driver, timeout).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        )

    def navigate_to_connect(self):
        """Navigate to the Connect screen by tapping the FAB or QR icon."""
        from selenium.common.exceptions import TimeoutException

        # Try the FAB "Connect" button first
        try:
            btn = self._find("Connect", timeout=5)
            # Avoid clicking "Connected" or "Connected Peers"
            if btn.text and "Connected" in btn.text:
                raise TimeoutException("Found 'Connected' not 'Connect'")
            btn.click()
        except TimeoutException:
            # Fallback: QR scanner icon via tooltip
            self.driver.find_element(
                "xpath", "//*[contains(@content-desc, 'Connect to peer')]"
            ).click()

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
        el = WebDriverWait(self.driver, 30).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        )
        return (el.text or el.get_attribute("content-desc") or "").strip()

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code on the Connect screen and submit."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.clear()
        input_field.send_keys(code)

        # Tap the "Connect" ElevatedButton
        self.driver.find_element(
            "xpath",
            "//*[(contains(@text, 'Connect') or contains(@content-desc, 'Connect')) and @clickable='true']"
        ).click()

    def go_back_to_home(self):
        """Navigate back to the home screen."""
        self.driver.back()

    def open_chat_with_peer(self, peer_name: str = None):
        """Tap on a connected peer to open the chat screen."""
        if peer_name:
            self._find(peer_name).click()
        else:
            # Tap the first peer card that shows "Connected"
            self._find("Connected").click()

    def send_message(self, text: str):
        """Type and send a message in the chat screen."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.send_keys(text)

        # Tap send button (icon button with send content-desc or text)
        self.driver.find_element(
            "xpath",
            "//*[contains(@content-desc, 'end') or contains(@content-desc, 'Send')]"
        ).click()

    def has_message(self, text: str) -> bool:
        """Check if a message with the given text is visible."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            self._find(text, timeout=5)
            return True
        except Exception:
            return False

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if a peer shows as 'Connected' on the home screen."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            if peer_name:
                self.driver.find_element(
                    "xpath",
                    f"//*[contains(@text, '{peer_name}') or contains(@content-desc, '{peer_name}')]"
                )
            self.driver.find_element(
                "xpath",
                "//*[@text='Connected' or @content-desc='Connected']"
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


@pytest.fixture
def app_helper(request):
    """Factory fixture for creating AppHelper instances."""

    def _create_helper(driver):
        return AppHelper(driver)

    return _create_helper
