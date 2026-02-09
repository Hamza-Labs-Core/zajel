"""
UI Automation helper for Windows desktop E2E testing.

Flutter on Windows exposes its widget tree via Windows UI Automation (UIA).
This module uses pywinauto to find and interact with Flutter widgets through
their UIA accessibility names (which map to Flutter Semantics labels).

Key concepts:
- Flutter's Semantics tree maps to UIA automation elements
- Widget text/labels appear as the element's "Name" property
- pywinauto with backend='uia' connects to the UIA tree
- Elements are found by title (Name), control_type, or automation_id
"""

import time

try:
    from pywinauto import Application, Desktop
    from pywinauto.timings import wait_until
    PYWINAUTO_AVAILABLE = True
except ImportError:
    PYWINAUTO_AVAILABLE = False

from config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT


class WindowsAppHelper:
    """Helper for interacting with the Zajel Flutter app on Windows via UIA.

    Mirrors the LinuxAppHelper API for consistent test patterns across
    desktop platforms.
    """

    def __init__(self, app_path: str):
        """Initialize the helper.

        Args:
            app_path: Path to the Flutter Windows app executable.
        """
        if not PYWINAUTO_AVAILABLE:
            raise RuntimeError(
                "pywinauto not available. Install with: pip install pywinauto"
            )

        self.app_path = app_path
        self.app = None
        self.main_window = None

    def launch(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Launch the app and wait for the main window to appear."""
        self.app = Application(backend="uia").start(
            self.app_path, timeout=timeout
        )

        # Wait for the main window to appear
        # Flutter Windows apps typically use the title set in main.cpp
        self.main_window = self.app.window(title_re=".*zajel.*", visible_only=True)
        self.main_window.wait("visible", timeout=timeout)

    def stop(self):
        """Stop the app."""
        if self.app:
            try:
                self.app.kill()
            except Exception:
                pass
            self.app = None
            self.main_window = None

    def find_by_name(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find a widget by its UIA Name property (Semantics label).

        Args:
            name: Text to search for in the UIA Name property.
            timeout: Maximum seconds to wait for the element.

        Returns:
            The UIA element matching the name.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                element = self.main_window.child_window(
                    title=name, found_index=0
                )
                if element.exists(timeout=0.5):
                    return element
            except Exception:
                pass
            time.sleep(0.5)

        raise TimeoutError(f"Element '{name}' not found within {timeout}s")

    def find_by_name_contains(self, text: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find a widget whose UIA Name contains the given text."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                element = self.main_window.child_window(
                    title_re=f".*{text}.*", found_index=0
                )
                if element.exists(timeout=0.5):
                    return element
            except Exception:
                pass
            time.sleep(0.5)

        raise TimeoutError(f"Element containing '{text}' not found within {timeout}s")

    def click(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find and click an element by name."""
        element = self.find_by_name(name, timeout)
        element.click_input()
        time.sleep(0.5)

    def type_text(self, text: str):
        """Type text into the currently focused field."""
        self.main_window.type_keys(text, with_spaces=True, with_newlines=True)

    def press_key(self, key: str):
        """Press a keyboard key (e.g., '{ENTER}', '{ESCAPE}', '{BACKSPACE}')."""
        self.main_window.type_keys(key)

    # ── App lifecycle ──────────────────────────────────────────────

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the home screen to be visible."""
        self.find_by_name("Zajel", timeout)

    # ── Navigation ────────────────────────────────────────────────

    def navigate_to_connect(self):
        """Tap the Connect FAB."""
        self.click("Connect")
        self.find_by_name("My Code")

    def go_back_to_home(self):
        """Navigate back to home screen."""
        self.press_key("{ESCAPE}")
        time.sleep(0.5)

    def navigate_to_settings(self):
        """Tap Settings in the app bar."""
        self.click("Settings")
        time.sleep(1)

    # ── Pairing ──────────────────────────────────────────────────

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code displayed on the Connect screen."""
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                # Look for children that match a 6-char alphanumeric code
                children = self.main_window.descendants()
                for child in children:
                    try:
                        name = child.window_text()
                        if name and len(name) == 6 and name.isalnum() and name.isupper():
                            return name
                    except Exception:
                        continue
            except Exception:
                pass
            time.sleep(1)
        raise TimeoutError("Pairing code not found on Connect screen")

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code and submit."""
        # Find the text input field
        try:
            edit = self.main_window.child_window(control_type="Edit", found_index=0)
            edit.click_input()
            edit.type_keys(code, with_spaces=False)
        except Exception:
            # Fallback: click near the input area and type
            self.type_text(code)

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
            element.click_input()
        time.sleep(1)

    # ── Messaging ────────────────────────────────────────────────

    def send_message(self, text: str):
        """Type and send a message in chat."""
        try:
            edit = self.main_window.child_window(control_type="Edit", found_index=0)
            edit.click_input()
            edit.type_keys(text, with_spaces=True)
        except Exception:
            self.type_text(text)
        self.click("Send message")

    def has_message(self, text: str) -> bool:
        """Check if a message is visible in chat."""
        try:
            self.find_by_name_contains(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False
