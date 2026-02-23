"""
AT-SPI + pyautogui helper for Linux desktop E2E testing with real cursor.

Uses AT-SPI (Assistive Technology Service Provider Interface) via GObject
introspection to traverse Flutter's accessibility tree and find UI elements.
Then uses pyautogui to move the real mouse cursor to those elements and
click/type — just like a human user would.

Requirements:
- D-Bus session bus running
- at-spi2-registryd running
- Xvfb (or real display) with DISPLAY set
- Python packages: PyGObject, pyautogui
- System packages: gir1.2-atspi-2.0, at-spi2-core

Flutter enables its Semantics tree when an AT-SPI client connects. The tree
exposes widget labels, roles (button, text field, etc.), and screen positions.
"""

import os
import re
import signal
import subprocess
import time

try:
    import pyautogui
    pyautogui.FAILSAFE = False  # No fail-safe in headless Xvfb
    pyautogui.PAUSE = 0.1
    PYAUTOGUI_AVAILABLE = True
except ImportError:
    PYAUTOGUI_AVAILABLE = False

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    ATSPI_AVAILABLE = True
except (ImportError, ValueError):
    ATSPI_AVAILABLE = False

from platforms.linux_config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT


class LinuxDesktopHelper:
    """Helper for interacting with the Zajel Flutter app on Linux via AT-SPI.

    Mirrors the WindowsAppHelper/LinuxAppHelper API for consistent test
    patterns across desktop platforms. Uses real cursor movement via pyautogui.
    """

    def __init__(self, app_path: str, data_dir: str, instance_name: str = "zajel"):
        if not ATSPI_AVAILABLE:
            raise RuntimeError(
                "AT-SPI not available. Install: sudo apt-get install "
                "gir1.2-atspi-2.0 at-spi2-core python3-gi"
            )
        if not PYAUTOGUI_AVAILABLE:
            raise RuntimeError(
                "pyautogui not available. Install with: pip install pyautogui"
            )

        self.app_path = app_path
        self.data_dir = data_dir
        self.instance_name = instance_name
        self.process = None
        self._app_node = None

    def launch(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Launch the app binary and wait for it to appear in the AT-SPI tree.

        Sets up isolated data dirs (XDG_DATA_HOME, etc.) so multiple instances
        don't interfere with each other.
        """
        os.makedirs(self.data_dir, exist_ok=True)

        env = os.environ.copy()
        env["XDG_DATA_HOME"] = os.path.join(self.data_dir, "data")
        env["XDG_CONFIG_HOME"] = os.path.join(self.data_dir, "config")
        env["XDG_CACHE_HOME"] = os.path.join(self.data_dir, "cache")

        if os.environ.get("CI"):
            env["LIBGL_ALWAYS_SOFTWARE"] = "1"

        # Enable accessibility
        env["GTK_MODULES"] = "atk-bridge"

        self.process = subprocess.Popen(
            [self.app_path],
            env=env,
            start_new_session=True,
        )
        print(f"[LinuxDesktopHelper] Launched {self.app_path} (PID {self.process.pid})")

        # Wait for app to register in AT-SPI tree
        self._app_node = self._wait_for_app(timeout)
        print(f"[LinuxDesktopHelper] App found in AT-SPI tree: {self._app_node.get_name()}")

    def stop(self):
        """Stop the app process."""
        if self.process:
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.process.pid), signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    pass
            self.process = None
        self._app_node = None

    # ── AT-SPI tree traversal ─────────────────────────────────────

    def _wait_for_app(self, timeout: int):
        """Poll AT-SPI desktop until our app appears."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            desktop = Atspi.get_desktop(0)
            for i in range(desktop.get_child_count()):
                try:
                    app = desktop.get_child_at_index(i)
                    app_name = app.get_name() or ""
                    if self.instance_name.lower() in app_name.lower():
                        return app
                except Exception:
                    continue
            time.sleep(1)
        raise TimeoutError(
            f"App '{self.instance_name}' not found in AT-SPI tree after {timeout}s"
        )

    def _find_element(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT,
                      partial: bool = False, role: str = None):
        """Find an accessible element by name, recursively searching the tree.

        Args:
            name: Text to search for in the element's accessible name.
            timeout: Maximum seconds to wait.
            partial: If True, match elements whose name contains the text.
            role: Optional AT-SPI role name filter (e.g. 'push button', 'text').

        Returns:
            The AT-SPI accessible object.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            result = self._search_tree(self._app_node, name, partial, role)
            if result is not None:
                return result
            time.sleep(0.5)
        raise TimeoutError(f"Element '{name}' not found within {timeout}s")

    def _search_tree(self, node, name: str, partial: bool = False,
                     role_filter: str = None):
        """Recursively search the AT-SPI tree for an element matching criteria."""
        if node is None:
            return None

        try:
            node_name = node.get_name() or ""
            node_role = node.get_role_name() or ""

            # Check name match
            name_match = False
            if partial:
                name_match = name.lower() in node_name.lower()
            else:
                name_match = node_name.strip() == name.strip()

            # Check role match
            role_match = True
            if role_filter:
                role_match = role_filter.lower() in node_role.lower()

            if name_match and role_match:
                return node

            # Recurse into children
            child_count = node.get_child_count()
            for i in range(child_count):
                try:
                    child = node.get_child_at_index(i)
                    result = self._search_tree(child, name, partial, role_filter)
                    if result is not None:
                        return result
                except Exception:
                    continue
        except Exception:
            pass

        return None

    def _get_element_center(self, element):
        """Get the screen center coordinates of an AT-SPI element."""
        try:
            component = element.queryComponent()
            rect = component.getExtents(Atspi.CoordType.SCREEN)
            cx = rect.x + rect.width // 2
            cy = rect.y + rect.height // 2
            return cx, cy
        except Exception:
            # Fallback: try the Atspi.Component interface directly
            rect = element.get_extents(Atspi.CoordType.SCREEN)
            cx = rect.x + rect.width // 2
            cy = rect.y + rect.height // 2
            return cx, cy

    # ── Public API (mirrors WindowsAppHelper) ─────────────────────

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
        """Type text via keyboard simulation using pyautogui."""
        # pyautogui.write() only handles ASCII; use pyperclip for Unicode
        for char in text:
            pyautogui.press(char)
        time.sleep(0.3)

    def press_key(self, key: str):
        """Press a keyboard key.

        Accepts pyautogui key names: 'escape', 'enter', 'backspace', 'tab', etc.
        Also handles pywinauto-style '{ESCAPE}', '{ENTER}' for compatibility.
        """
        # Normalize pywinauto-style keys to pyautogui-style
        key_map = {
            "{ESCAPE}": "escape",
            "{ENTER}": "enter",
            "{BACKSPACE}": "backspace",
            "{TAB}": "tab",
            "{DELETE}": "delete",
            "{HOME}": "home",
            "{END}": "end",
        }
        key = key_map.get(key.upper(), key.lower().strip("{}"))
        pyautogui.press(key)
        time.sleep(0.3)

    # ── App lifecycle ──────────────────────────────────────────────

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the home screen, dismissing onboarding if needed."""
        # First check if we're already on the home screen
        try:
            self.find_by_name("Zajel", timeout=15)
            print("[wait_for_app_ready] Home screen detected directly")
            return
        except TimeoutError:
            pass

        # Try dismissing onboarding
        self._dismiss_onboarding()

        # Now wait for home screen
        try:
            self.find_by_name("Zajel", timeout=timeout)
            print("[wait_for_app_ready] Home screen confirmed after onboarding")
        except TimeoutError:
            print("[wait_for_app_ready] FAILED to reach home screen")
            self._dump_tree()
            raise

    def _dismiss_onboarding(self):
        """Dismiss onboarding screen if present."""
        # Try clicking Skip
        try:
            self.click("Skip", timeout=10)
            time.sleep(2)
            return
        except TimeoutError:
            pass

        # Try clicking through Next/Get Started pages
        for page in range(5):
            try:
                element = self._find_element("Next", timeout=3)
                cx, cy = self._get_element_center(element)
                pyautogui.moveTo(cx, cy, duration=0.15)
                pyautogui.click()
                time.sleep(1)
            except TimeoutError:
                try:
                    element = self._find_element("Get Started", timeout=2)
                    cx, cy = self._get_element_center(element)
                    pyautogui.moveTo(cx, cy, duration=0.15)
                    pyautogui.click()
                    time.sleep(1)
                except TimeoutError:
                    break

    def _dump_tree(self, max_elements: int = 30):
        """Dump the AT-SPI tree for debugging."""
        print("[AT-SPI tree dump]")
        count = [0]

        def _walk(node, depth=0):
            if count[0] >= max_elements:
                return
            try:
                name = node.get_name() or ""
                role = node.get_role_name() or ""
                if name:
                    indent = "  " * depth
                    print(f"  {indent}[{role}] '{name}'")
                    count[0] += 1
                for i in range(node.get_child_count()):
                    _walk(node.get_child_at_index(i), depth + 1)
            except Exception:
                pass

        if self._app_node:
            _walk(self._app_node)

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
        """Tap Settings in the app bar or sidebar."""
        self.click("Settings")
        time.sleep(1)

    def navigate_to_channels(self):
        """Tap 'Channels' button."""
        self.click("Channels")
        time.sleep(1)

    def navigate_to_groups(self):
        """Tap 'Groups' button."""
        self.click("Groups")
        time.sleep(1)

    # ── Pairing ──────────────────────────────────────────────────

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code from the Connect screen.

        Scans the AT-SPI tree for a 6-character uppercase alphanumeric string.
        """
        deadline = time.time() + 30
        while time.time() < deadline:
            codes = self._find_codes_in_tree(self._app_node)
            if codes:
                return codes[0]
            time.sleep(1)
        raise TimeoutError("Pairing code not found on Connect screen")

    def _find_codes_in_tree(self, node) -> list:
        """Search the AT-SPI tree for 6-char uppercase alphanumeric strings."""
        results = []
        if node is None:
            return results
        try:
            name = node.get_name() or ""
            if len(name) == 6 and name.isalnum() and name.isupper():
                results.append(name)
            for i in range(node.get_child_count()):
                results.extend(
                    self._find_codes_in_tree(node.get_child_at_index(i))
                )
        except Exception:
            pass
        return results

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code and submit."""
        # Find a text input field
        try:
            text_field = self._find_element("", timeout=5, partial=True,
                                            role="text")
            cx, cy = self._get_element_center(text_field)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
            time.sleep(0.3)
        except TimeoutError:
            pass

        # Type the code
        for char in code:
            pyautogui.press(char.lower())
        time.sleep(0.5)

        # Tap Connect button
        self.click("Connect")

    def wait_for_signaling_connected(self, timeout: int = 60):
        """Wait for signaling server connection (code appears on screen)."""
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
        # Find text field, type, send
        try:
            text_field = self._find_element("", timeout=5, partial=True,
                                            role="text")
            cx, cy = self._get_element_center(text_field)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
        except TimeoutError:
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
        """Create a channel via FAB -> dialog -> fill fields -> Create."""
        self.click("Create Channel")
        time.sleep(1)
        # Type channel name into first text field
        try:
            text_field = self._find_element("", timeout=5, partial=True,
                                            role="text")
            cx, cy = self._get_element_center(text_field)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
            for char in name:
                pyautogui.press(char.lower())
        except TimeoutError:
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
            link = link_el.get_name() or ""
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
            text_field = self._find_element("", timeout=5, partial=True,
                                            role="text")
            cx, cy = self._get_element_center(text_field)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
            for char in text:
                pyautogui.press(char.lower())
        except TimeoutError:
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
        """Create a group via FAB -> dialog -> fill name -> Create."""
        self.click("Create Group")
        time.sleep(1)
        try:
            text_field = self._find_element("", timeout=5, partial=True,
                                            role="text")
            cx, cy = self._get_element_center(text_field)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
            for char in name:
                pyautogui.press(char.lower())
        except TimeoutError:
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
            text_field = self._find_element("", timeout=5, partial=True,
                                            role="text")
            cx, cy = self._get_element_center(text_field)
            pyautogui.moveTo(cx, cy, duration=0.15)
            pyautogui.click()
            for char in text:
                pyautogui.press(char.lower())
        except TimeoutError:
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
        """Tap the members button to open the bottom sheet."""
        self.click("members")
        time.sleep(1)

    # ── Screenshots ───────────────────────────────────────────────

    def take_screenshot(self, name: str):
        """Save screenshot via pyautogui (captures entire screen)."""
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        try:
            screenshot = pyautogui.screenshot()
            screenshot.save(path)
            print(f"Screenshot saved: {path}")
        except Exception as e:
            print(f"Screenshot failed: {e}")
