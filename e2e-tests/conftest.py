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
    """Create an Appium driver for the server at given index."""
    options = UiAutomator2Options()
    options.app = APK_PATH
    options.device_name = f"{device_name}-{server_index}"
    options.automation_name = "UiAutomator2"
    options.new_command_timeout = 300
    options.no_reset = False  # Fresh app state for each test

    # Android-specific settings
    options.auto_grant_permissions = True

    # Extended timeouts for slow software emulators (VPS without KVM)
    options.set_capability("appWaitDuration", 120000)  # 2 minutes to wait for app
    options.set_capability("uiautomator2ServerLaunchTimeout", 120000)  # 2 min for server
    options.set_capability("uiautomator2ServerInstallTimeout", 120000)  # 2 min for install
    options.set_capability("adbExecTimeout", 120000)  # 2 min for adb commands
    options.set_capability("ignoreHiddenApiPolicyError", True)  # Ignore hidden API errors

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
    """Helper methods for interacting with the Zajel app."""

    def __init__(self, driver: webdriver.Remote):
        self.driver = driver

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the app to be fully loaded."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Wait for main screen to appear
        WebDriverWait(self.driver, timeout).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.FrameLayout"))
        )

    def enable_external_connections(self):
        """Enable external connections toggle."""
        # Find and click the external connections toggle
        # Selector depends on actual app UI - adjust as needed
        toggle = self.driver.find_element(
            "xpath", "//android.widget.Switch | //android.widget.ToggleButton"
        )
        if toggle.get_attribute("checked") != "true":
            toggle.click()

    def get_pairing_code(self) -> str:
        """Get the current pairing code."""
        # Find the pairing code element
        # Selector depends on actual app UI - adjust as needed
        code_element = self.driver.find_element(
            "xpath", "//*[contains(@text, '-') and string-length(@text) >= 6]"
        )
        return code_element.text

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code to connect."""
        # Click "Enter Code" button
        self.driver.find_element("xpath", "//*[contains(@text, 'Enter') or contains(@text, 'Code')]").click()

        # Enter the code
        input_field = self.driver.find_element("xpath", "//android.widget.EditText")
        input_field.send_keys(code)

        # Submit
        self.driver.find_element("xpath", "//*[contains(@text, 'Connect')]").click()

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if connected to a peer."""
        try:
            if peer_name:
                self.driver.find_element("xpath", f"//*[contains(@text, '{peer_name}')]")
            else:
                # Check for any peer in list
                self.driver.find_element("xpath", "//android.widget.ListView//*")
            return True
        except Exception:
            return False


@pytest.fixture
def app_helper(request):
    """Factory fixture for creating AppHelper instances."""

    def _create_helper(driver):
        return AppHelper(driver)

    return _create_helper
