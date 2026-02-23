"""
NSAccessibility + pyautogui helper for macOS desktop E2E testing with real cursor.

Uses atomacos (or raw pyobjc NSAccessibility) to traverse Flutter's
accessibility tree on macOS and find UI elements by title/role. Then uses
pyautogui to move the real mouse cursor and click.

Requirements:
- macOS with Accessibility permission granted to the terminal/runner
- Python packages: atomacos, pyautogui, pyobjc (optional for lower-level access)

Flutter on macOS exposes its Semantics tree via NSAccessibility. Widget labels
appear as AXTitle or AXDescription, and positions are available via
AXPosition + AXSize.
"""

import os
import re
import signal
import subprocess
import time

try:
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.PAUSE = 0.1
    PYAUTOGUI_AVAILABLE = True
except ImportError:
    PYAUTOGUI_AVAILABLE = False

try:
    import atomacos
    ATOMACOS_AVAILABLE = True
except ImportError:
    ATOMACOS_AVAILABLE = False

from platforms.macos_config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT


class MacosAppHelper:
    """Helper for interacting with the Zajel Flutter app on macOS via NSAccessibility.

    Mirrors the WindowsAppHelper/LinuxAppHelper API for consistent test
    patterns across desktop platforms. Uses real cursor movement via pyautogui.
    """

    def __init__(self, app_path: str, data_dir: str = None, instance_name: str = "zajel"):
        if not ATOMACOS_AVAILABLE:
            raise RuntimeError(
                "atomacos not available. Install with: pip install atomacos"
            )
        if not PYAUTOGUI_AVAILABLE:
            raise RuntimeError(
                "pyautogui not available. Install with: pip install pyautogui"
            )

        self.app_path = app_path
        self.data_dir = data_dir
        self.instance_name = instance_name
        self.process = None
        self._app_ref = None

    def launch(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Launch the .app bundle and wait for it to register in accessibility tree."""
        if self.data_dir:
            os.makedirs(self.data_dir, exist_ok=True)

        env = os.environ.copy()
        if self.data_dir:
            env["XDG_DATA_HOME"] = os.path.join(self.data_dir, "data")
            env["XDG_CONFIG_HOME"] = os.path.join(self.data_dir, "config")
            env["XDG_CACHE_HOME"] = os.path.join(self.data_dir, "cache")

        # Launch the .app bundle using open command
        subprocess.Popen(["open", "-a", self.app_path], env=env)
        print(f"[MacosAppHelper] Launched {self.app_path}")

        # Wait for app to appear in accessibility tree
        self._app_ref = self._wait_for_app(timeout)
        print(f"[MacosAppHelper] App found in accessibility tree")

    def stop(self):
        """Stop the app."""
        if self._app_ref:
            try:
                # Use osascript to quit the app gracefully
                bundle_name = os.path.basename(self.app_path).replace(".app", "")
                subprocess.run(
                    ["osascript", "-e", f'tell application "{bundle_name}" to quit'],
                    timeout=5,
                    capture_output=True,
                )
            except Exception:
                pass
            time.sleep(1)
            # Force kill if still running
            try:
                subprocess.run(
                    ["pkill", "-f", self.instance_name],
                    timeout=5,
                    capture_output=True,
                )
            except Exception:
                pass
            self._app_ref = None

    # ── Accessibility tree traversal ──────────────────────────────

    def _wait_for_app(self, timeout: int):
        """Wait for the app to appear in the macOS accessibility tree."""
        deadline = time.time() + timeout
        bundle_name = os.path.basename(self.app_path).replace(".app", "")

        while time.time() < deadline:
            try:
                apps = atomacos.NativeUIElement.getRunningApps()
                for app in apps:
                    app_title = app.localizedName() or ""
                    if bundle_name.lower() in app_title.lower():
                        return atomacos.getAppRefByLocalizedName(app_title)
            except Exception:
                pass
            time.sleep(1)

        raise TimeoutError(
            f"App '{bundle_name}' not found in accessibility tree after {timeout}s"
        )

    def _find_element(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT,
                      partial: bool = False):
        """Find an accessible element by AXTitle or AXDescription."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if partial:
                    elements = self._app_ref.findAllR(AXDescription=name)
                    if not elements:
                        elements = self._app_ref.findAllR(AXTitle=name)
                    # Filter for partial match
                    for el in (elements or []):
                        title = getattr(el, 'AXTitle', '') or ''
                        desc = getattr(el, 'AXDescription', '') or ''
                        if name.lower() in title.lower() or name.lower() in desc.lower():
                            return el
                else:
                    try:
                        el = self._app_ref.findFirstR(AXTitle=name)
                        if el:
                            return el
                    except Exception:
                        pass
                    try:
                        el = self._app_ref.findFirstR(AXDescription=name)
                        if el:
                            return el
                    except Exception:
                        pass
            except Exception:
                pass
            time.sleep(0.5)

        raise TimeoutError(f"Element '{name}' not found within {timeout}s")

    def _get_element_center(self, element):
        """Get the screen center coordinates of an accessibility element."""
        pos = element.AXPosition  # (x, y)
        size = element.AXSize     # (w, h)
        cx = int(pos[0] + size[0] / 2)
        cy = int(pos[1] + size[1] / 2)
        return cx, cy

    # ── Public API ────────────────────────────────────────────────

    def find_by_name(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find an accessible element by exact name."""
        return self._find_element(name, timeout)

    def find_by_name_contains(self, text: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find an element whose name contains the given text."""
        return self._find_element(text, timeout, partial=True)

    def click(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find element by name, move cursor to it, and click."""
        element = self._find_element(name, timeout)
        cx, cy = self._get_element_center(element)
        pyautogui.moveTo(cx, cy, duration=0.2)
        pyautogui.click()
        time.sleep(0.5)

    def type_text(self, text: str):
        """Type text via keyboard simulation."""
        for char in text:
            pyautogui.press(char)
        time.sleep(0.3)

    def press_key(self, key: str):
        """Press a keyboard key.

        Accepts pyautogui key names or pywinauto-style '{ESCAPE}' format.
        """
        key_map = {
            "{ESCAPE}": "escape",
            "{ENTER}": "enter",
            "{BACKSPACE}": "backspace",
            "{TAB}": "tab",
            "{DELETE}": "delete",
        }
        key = key_map.get(key.upper(), key.lower().strip("{}"))
        pyautogui.press(key)
        time.sleep(0.3)

    # ── App lifecycle ──────────────────────────────────────────────

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the home screen, dismissing onboarding if needed."""
        try:
            self.find_by_name("Zajel", timeout=15)
            print("[wait_for_app_ready] Home screen detected directly")
            return
        except TimeoutError:
            pass

        self._dismiss_onboarding()

        try:
            self.find_by_name("Zajel", timeout=timeout)
            print("[wait_for_app_ready] Home screen confirmed after onboarding")
        except TimeoutError:
            print("[wait_for_app_ready] FAILED to reach home screen")
            raise

    def _dismiss_onboarding(self):
        """Dismiss onboarding screen if present."""
        try:
            self.click("Skip", timeout=10)
            time.sleep(2)
            return
        except TimeoutError:
            pass

        for page in range(5):
            try:
                self.click("Next", timeout=3)
                time.sleep(1)
            except TimeoutError:
                try:
                    self.click("Get Started", timeout=2)
                    time.sleep(1)
                except TimeoutError:
                    break

    # ── Navigation ────────────────────────────────────────────────

    def navigate_to_connect(self):
        """Tap the Connect FAB."""
        self.click("Connect")
        self.find_by_name("My Code")

    def go_back_to_home(self):
        """Navigate back to home screen."""
        self.press_key("escape")
        time.sleep(0.5)

    def navigate_to_settings(self):
        """Tap Settings."""
        self.click("Settings")
        time.sleep(1)

    def navigate_to_channels(self):
        """Tap Channels button."""
        self.click("Channels")
        time.sleep(1)

    def navigate_to_groups(self):
        """Tap Groups button."""
        self.click("Groups")
        time.sleep(1)

    # ── Pairing ──────────────────────────────────────────────────

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code from the Connect screen."""
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                # Walk tree looking for 6-char alphanumeric codes
                elements = self._app_ref.findAllR(AXRole='AXStaticText')
                for el in (elements or []):
                    try:
                        value = getattr(el, 'AXValue', '') or getattr(el, 'AXTitle', '') or ''
                        if len(value) == 6 and value.isalnum() and value.isupper():
                            return value
                    except Exception:
                        continue
            except Exception:
                pass
            time.sleep(1)
        raise TimeoutError("Pairing code not found on Connect screen")

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code and submit."""
        try:
            text_field = self._app_ref.findFirstR(AXRole='AXTextField')
            if text_field:
                cx, cy = self._get_element_center(text_field)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
                time.sleep(0.3)
        except Exception:
            pass

        for char in code:
            pyautogui.press(char.lower())
        time.sleep(0.5)
        self.click("Connect")

    def wait_for_signaling_connected(self, timeout: int = 60):
        """Wait for signaling server connection."""
        self.find_by_name_contains("Code:", timeout)

    # ── Peer state ───────────────────────────────────────────────

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if a peer shows as Connected."""
        try:
            self.find_by_name("Connected", timeout=3)
            return True
        except (TimeoutError, Exception):
            return False

    def open_chat_with_peer(self, peer_name: str = None):
        """Click a connected peer to open chat."""
        if peer_name:
            self.click(peer_name)
        else:
            element = self.find_by_name("Connected", timeout=10)
            cx, cy = self._get_element_center(element)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
        time.sleep(1)

    # ── Messaging ────────────────────────────────────────────────

    def send_message(self, text: str):
        """Type and send a message in chat."""
        try:
            text_field = self._app_ref.findFirstR(AXRole='AXTextField')
            if text_field:
                cx, cy = self._get_element_center(text_field)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
        except Exception:
            pass
        for char in text:
            pyautogui.press(char.lower())
        self.click("Send message")

    def has_message(self, text: str) -> bool:
        """Check if a message is visible in chat."""
        try:
            self.find_by_name_contains(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Channels ──────────────────────────────────────────────────

    def create_channel(self, name: str, description: str = ""):
        """Create a channel."""
        self.click("Create Channel")
        time.sleep(1)
        try:
            text_field = self._app_ref.findFirstR(AXRole='AXTextField')
            if text_field:
                cx, cy = self._get_element_center(text_field)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
                for char in name:
                    pyautogui.press(char.lower())
        except Exception:
            for char in name:
                pyautogui.press(char.lower())
        self.click("Create")
        time.sleep(2)

    def open_channel(self, name: str):
        """Tap a channel in the list by name."""
        self.click(name)
        time.sleep(1)

    def get_channel_invite_link(self) -> str:
        """Open share dialog -> extract link -> dismiss."""
        self.click("Share channel")
        time.sleep(2)
        try:
            link_el = self.find_by_name_contains("zajel://", timeout=10)
            link = getattr(link_el, 'AXTitle', '') or getattr(link_el, 'AXValue', '') or ''
        except (TimeoutError, Exception):
            link = ""
        try:
            self.click("Done")
        except (TimeoutError, Exception):
            self.press_key("escape")
        time.sleep(1)
        return link

    def publish_channel_message(self, text: str):
        """Type in publish field -> tap Publish."""
        try:
            text_field = self._app_ref.findFirstR(AXRole='AXTextField')
            if text_field:
                cx, cy = self._get_element_center(text_field)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
                for char in text:
                    pyautogui.press(char.lower())
        except Exception:
            for char in text:
                pyautogui.press(char.lower())
        self.click("Publish")
        time.sleep(2)

    def has_channel_message(self, text: str) -> bool:
        """Check if a channel message is visible."""
        try:
            self.find_by_name_contains(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Groups ────────────────────────────────────────────────────

    def create_group(self, name: str):
        """Create a group."""
        self.click("Create Group")
        time.sleep(1)
        try:
            text_field = self._app_ref.findFirstR(AXRole='AXTextField')
            if text_field:
                cx, cy = self._get_element_center(text_field)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
                for char in name:
                    pyautogui.press(char.lower())
        except Exception:
            for char in name:
                pyautogui.press(char.lower())
        self.click("Create")
        time.sleep(2)

    def open_group(self, name: str):
        """Tap a group in the list by name."""
        self.click(name)
        time.sleep(1)

    def add_group_member(self, peer_name: str):
        """Tap 'Add member' -> select peer by name."""
        self.click("Add member")
        time.sleep(1)
        self.click(peer_name)
        time.sleep(2)

    def send_group_message(self, text: str):
        """Type in message field -> tap Send."""
        try:
            text_field = self._app_ref.findFirstR(AXRole='AXTextField')
            if text_field:
                cx, cy = self._get_element_center(text_field)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
                for char in text:
                    pyautogui.press(char.lower())
        except Exception:
            for char in text:
                pyautogui.press(char.lower())
        self.click("Send")
        time.sleep(2)

    def has_group_message(self, text: str) -> bool:
        """Check if a group message is visible."""
        try:
            self.find_by_name_contains(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    def open_members_sheet(self):
        """Tap the members button."""
        self.click("members")
        time.sleep(1)

    # ── Screenshots ───────────────────────────────────────────────

    def take_screenshot(self, name: str):
        """Save screenshot via pyautogui."""
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        try:
            screenshot = pyautogui.screenshot()
            screenshot.save(path)
            print(f"Screenshot saved: {path}")
        except Exception as e:
            print(f"Screenshot failed: {e}")
