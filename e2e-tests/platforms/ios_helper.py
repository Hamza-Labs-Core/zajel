"""
iOS (Appium/XCUITest) helper for E2E testing.

Uses Appium with XCUITest backend to interact with the Zajel Flutter app
on iOS Simulator. Flutter exposes its Semantics tree through XCUITest
accessibility labels, so the same tooltip strings used for Android also
work here via @label attribute.

Requires:
- Appium server running with XCUITest driver
- iOS Simulator booted
- .app bundle built with --no-codesign
"""

from __future__ import annotations

import os
import time

from platforms.ios_config import APP_LAUNCH_TIMEOUT


class IosAppHelper:
    """Helper methods for interacting with the Zajel app on iOS Simulator.

    Mirrors the Android AppHelper API. Uses Appium XCUITest backend where
    Flutter Semantics labels map to XCUITest accessibility identifiers.
    """

    def __init__(self, driver):
        self.driver = driver

    def _find(self, text, timeout=10, partial=True):
        """Find an element by accessibility label or text.

        On iOS/XCUITest, Flutter Semantics labels appear as the
        accessibility label (@label) in the element tree.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        if partial:
            xpath = (
                f"//*[contains(@label, '{text}') or "
                f"contains(@name, '{text}') or "
                f"contains(@value, '{text}')]"
            )
        else:
            xpath = (
                f"//*[@label='{text}' or "
                f"@name='{text}' or "
                f"@value='{text}']"
            )

        try:
            return WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((By.XPATH, xpath))
            )
        except Exception:
            print(f"=== _find FAILED: text='{text}' partial={partial} timeout={timeout} ===")
            try:
                source = self.driver.page_source
                print(source[:15000] if source else "EMPTY PAGE SOURCE")
            except Exception as e:
                print(f"Failed to get page source: {e}")
            print("=== END PAGE SOURCE ===")
            raise

    # ── App lifecycle ──────────────────────────────────────────────

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the app to show the home screen."""
        time.sleep(3)
        self._find("Zajel", timeout=timeout)

    # ── Navigation ────────────────────────────────────────────────

    def navigate_to_connect(self):
        """Tap the Connect button."""
        self._find("Connect to peer", timeout=10).click()
        self._find("My Code")

    def go_back_to_home(self):
        """Navigate back to the home screen."""
        self.driver.back()
        time.sleep(0.5)

    def navigate_to_settings(self):
        """Tap Settings in the app bar."""
        self._find("Settings", timeout=10).click()
        time.sleep(1)

    def navigate_to_contacts(self):
        """Tap the Contacts button from home screen."""
        self._find("Contacts", timeout=10).click()
        time.sleep(1)

    def navigate_to_channels(self):
        """Tap 'Channels' button in home app bar."""
        self._find("Channels", timeout=10).click()
        time.sleep(1)

    def navigate_to_groups(self):
        """Tap 'Groups' button in home app bar."""
        self._find("Groups", timeout=10).click()
        time.sleep(1)

    # ── Pairing ──────────────────────────────────────────────────

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code from the Connect screen."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        deadline = time.time() + 60
        while time.time() < deadline:
            try:
                elements = self.driver.find_elements(By.XPATH, "//*[@label]")
                for el in elements:
                    label = el.get_attribute("label") or ""
                    if len(label) == 6 and label.isalnum() and label.isupper():
                        return label
            except Exception:
                pass
            time.sleep(1)
        raise TimeoutError("Pairing code not found on Connect screen")

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code and submit."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//XCUIElementTypeTextField"))
        )
        input_field.click()
        input_field.send_keys(code)

        self._find("Connect", timeout=5, partial=False).click()

    # ── Peer state ───────────────────────────────────────────────

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if a peer shows as Connected."""
        try:
            self._find("Connected", timeout=5)
            return True
        except Exception:
            return False

    def open_chat_with_peer(self, peer_name: str = None):
        """Tap a connected peer to open the chat screen."""
        if peer_name:
            self._find(peer_name, timeout=10).click()
        else:
            self._find("Connected", timeout=10).click()
        time.sleep(1)

    # ── Messaging ────────────────────────────────────────────────

    def send_message(self, text: str):
        """Type and send a message in the chat screen."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//XCUIElementTypeTextField"))
        )
        input_field.click()
        input_field.send_keys(text)
        self._find("Send message", timeout=5).click()

    def has_message(self, text: str) -> bool:
        """Check if a message with the given text is visible."""
        try:
            self._find(text, timeout=5)
            return True
        except Exception:
            return False

    # ── Channel helpers ──────────────────────────────────────────

    def create_channel(self, name, description=""):
        """Create a channel via FAB → dialog → fill fields → tap Create."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        self._find("Create Channel", timeout=10).click()
        time.sleep(1)

        fields = self.driver.find_elements(By.XPATH, "//XCUIElementTypeTextField")
        if fields:
            fields[0].click()
            fields[0].send_keys(name)

        if description and len(fields) > 1:
            fields[1].click()
            fields[1].send_keys(description)

        self._find("Create", timeout=5, partial=False).click()
        time.sleep(2)

    def open_channel(self, name):
        """Tap a channel in the list by name."""
        self._find(name, timeout=10).click()
        time.sleep(1)

    def get_channel_invite_link(self):
        """Open share dialog → extract link → dismiss."""
        self._find("Share channel", timeout=10).click()
        time.sleep(2)

        try:
            link_el = self._find("zajel://", timeout=10)
            link = link_el.get_attribute("label") or link_el.text or ""
        except Exception:
            link = ""

        try:
            self._find("Done", timeout=5).click()
        except Exception:
            self.driver.back()
        time.sleep(1)

        return link

    def publish_channel_message(self, text):
        """Type in publish field → tap 'Publish' button."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//XCUIElementTypeTextField"))
        )
        input_field.click()
        input_field.send_keys(text)
        self._find("Publish", timeout=5).click()
        time.sleep(2)

    def has_channel_message(self, text):
        """Check if a channel message is visible."""
        try:
            self._find(text, timeout=5)
            return True
        except Exception:
            return False

    # ── Group helpers ────────────────────────────────────────────

    def create_group(self, name):
        """Create a group via FAB → dialog → fill name → tap Create."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        self._find("Create Group", timeout=10).click()
        time.sleep(1)

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//XCUIElementTypeTextField"))
        )
        input_field.click()
        input_field.send_keys(name)

        self._find("Create", timeout=5, partial=False).click()
        time.sleep(2)

    def open_group(self, name):
        """Tap a group in the list by name."""
        self._find(name, timeout=10).click()
        time.sleep(1)

    def add_group_member(self, peer_name):
        """Tap 'Add member' → select peer by name."""
        self._find("Add member", timeout=10).click()
        time.sleep(1)
        self._find(peer_name, timeout=10).click()
        time.sleep(2)

    def send_group_message(self, text):
        """Type in message field → tap 'Send' button."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//XCUIElementTypeTextField"))
        )
        input_field.click()
        input_field.send_keys(text)
        self._find("Send", timeout=5).click()
        time.sleep(2)

    def has_group_message(self, text):
        """Check if a group message is visible."""
        try:
            self._find(text, timeout=5)
            return True
        except Exception:
            return False

    def open_members_sheet(self):
        """Tap the members button to open the bottom sheet."""
        self._find("members", timeout=10).click()
        time.sleep(1)

    # ── Screenshots ──────────────────────────────────────────────

    def take_screenshot(self, name):
        """Save screenshot to E2E_ARTIFACTS_DIR/{name}.png."""
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        self.driver.save_screenshot(path)
        print(f"Screenshot saved: {path}")
