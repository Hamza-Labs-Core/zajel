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

from platforms.windows_config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT


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
        """Launch the app and wait for the main window to appear.

        Passes --enable-software-rendering to avoid ANGLE/DirectX failures
        on CI runners that lack GPU hardware or have driver issues.
        """
        self.app = Application(backend="uia").start(
            f'"{self.app_path}" --enable-software-rendering',
            timeout=timeout,
        )

        # Wait for the main window to appear
        # Flutter Windows apps use the title set in main.cpp — match
        # case-insensitively since it could be "zajel" or "Zajel"
        self.main_window = self.app.window(
            title_re="(?i).*zajel.*", visible_only=True
        )
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
        """Wait for the home screen to be visible, dismissing onboarding if needed."""
        try:
            self.find_by_name("Zajel", timeout=15)
            print("[wait_for_app_ready] Home screen detected directly")
            return
        except TimeoutError:
            pass

        # Try dismissing onboarding screen (first launch)
        self._dismiss_onboarding()

        # Now wait for the actual home screen
        try:
            self.find_by_name("Zajel", timeout=timeout)
            print("[wait_for_app_ready] Home screen confirmed after onboarding dismissal")
        except TimeoutError:
            print("[wait_for_app_ready] FAILED to reach home screen after onboarding dismissal")
            raise

    def _dismiss_onboarding(self):
        """Dismiss the onboarding screen if present (first launch).

        Tries multiple strategies since Flutter's UIA tree may expose
        TextButton text differently on Windows Server CI runners.
        """
        # Strategy 1: Find Skip button by exact title
        try:
            skip = self.main_window.child_window(title="Skip", found_index=0)
            if skip.exists(timeout=10):
                print("[wait_for_app_ready] Onboarding screen detected, clicking Skip")
                skip.click_input()
                time.sleep(2)
                return
        except Exception:
            pass

        # Strategy 2: Find Skip by regex (case-insensitive)
        try:
            skip = self.main_window.child_window(title_re="(?i)^skip$", found_index=0)
            if skip.exists(timeout=5):
                print("[wait_for_app_ready] Onboarding detected (regex), clicking Skip")
                skip.click_input()
                time.sleep(2)
                return
        except Exception:
            pass

        # Strategy 3: Walk descendants looking for "Skip" text
        try:
            for child in self.main_window.descendants():
                try:
                    name = child.window_text()
                    if name and name.strip().lower() == "skip":
                        print(f"[wait_for_app_ready] Found Skip via descendants walk")
                        child.click_input()
                        time.sleep(2)
                        return
                except Exception:
                    continue
        except Exception:
            pass

        # Strategy 4: Click through onboarding pages using Next/Get Started
        try:
            for page in range(5):
                try:
                    btn = self.main_window.child_window(
                        title_re="(?i)(next|get started)", found_index=0
                    )
                    if btn.exists(timeout=3):
                        print(f"[wait_for_app_ready] Clicking Next/Get Started (page {page + 1})")
                        btn.click_input()
                        time.sleep(1)
                    else:
                        break
                except Exception:
                    break
        except Exception:
            pass

        # Debug: dump visible UIA elements to help diagnose future issues
        try:
            print("[wait_for_app_ready] UIA tree dump (top 30 named elements):")
            count = 0
            for child in self.main_window.descendants():
                if count >= 30:
                    break
                try:
                    name = child.window_text()
                    if name:
                        ctrl = child.element_info.control_type
                        print(f"  [{ctrl}] '{name}'")
                        count += 1
                except Exception:
                    continue
        except Exception:
            pass

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

    # ── Channels ──────────────────────────────────────────────────

    def navigate_to_channels(self):
        """Tap 'Channels' button from home screen."""
        self.click("Channels")
        time.sleep(1)

    def navigate_to_groups(self):
        """Tap 'Groups' button from home screen."""
        self.click("Groups")
        time.sleep(1)

    def create_channel(self, name, description=""):
        """Create a channel via FAB → dialog → fill fields → tap Create."""
        self.click("Create Channel")
        time.sleep(1)

        # Fill channel name in first Edit control
        try:
            edits = self.main_window.children(control_type="Edit")
            if edits:
                edits[0].click_input()
                edits[0].type_keys(name, with_spaces=True)
                if description and len(edits) > 1:
                    edits[1].click_input()
                    edits[1].type_keys(description, with_spaces=True)
        except Exception:
            self.type_text(name)

        self.click("Create")
        time.sleep(2)

    def open_channel(self, name):
        """Tap a channel in the list by name."""
        self.click(name)
        time.sleep(1)

    def get_channel_invite_link(self):
        """Open share dialog → extract link text → dismiss."""
        self.click("Share channel")
        time.sleep(2)

        try:
            link_el = self.find_by_name_contains("zajel://", timeout=10)
            link = link_el.window_text()
        except (TimeoutError, Exception):
            link = ""

        try:
            self.click("Done")
        except (TimeoutError, Exception):
            self.press_key("{ESCAPE}")
        time.sleep(1)

        return link

    def publish_channel_message(self, text):
        """Type in publish field → tap 'Publish' button."""
        try:
            edit = self.main_window.child_window(control_type="Edit", found_index=0)
            edit.click_input()
            edit.type_keys(text, with_spaces=True)
        except Exception:
            self.type_text(text)
        self.click("Publish")
        time.sleep(2)

    def has_channel_message(self, text):
        """Check if a channel message is visible."""
        try:
            self.find_by_name_contains(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Groups ────────────────────────────────────────────────────

    def create_group(self, name):
        """Create a group via FAB → dialog → fill name → tap Create."""
        self.click("Create Group")
        time.sleep(1)

        try:
            edit = self.main_window.child_window(control_type="Edit", found_index=0)
            edit.click_input()
            edit.type_keys(name, with_spaces=True)
        except Exception:
            self.type_text(name)

        self.click("Create")
        time.sleep(2)

    def open_group(self, name):
        """Tap a group in the list by name."""
        self.click(name)
        time.sleep(1)

    def add_group_member(self, peer_name):
        """Tap 'Add member' → select peer by name."""
        self.click("Add member")
        time.sleep(1)
        self.click(peer_name)
        time.sleep(2)

    def send_group_message(self, text):
        """Type in message field → tap 'Send' button."""
        try:
            edit = self.main_window.child_window(control_type="Edit", found_index=0)
            edit.click_input()
            edit.type_keys(text, with_spaces=True)
        except Exception:
            self.type_text(text)
        self.click("Send")
        time.sleep(2)

    def has_group_message(self, text):
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

    def take_screenshot(self, name):
        """Save screenshot to E2E_ARTIFACTS_DIR/{name}.png."""
        import os
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        try:
            self.main_window.capture_as_image().save(path)
            print(f"Screenshot saved: {path}")
        except Exception as e:
            print(f"Screenshot failed: {e}")
