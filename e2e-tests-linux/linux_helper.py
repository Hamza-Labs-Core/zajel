"""
AT-SPI helper for Linux desktop E2E testing.

Flutter on Linux exposes its widget tree via AT-SPI (Accessibility Technology
Service Provider Interface). This module uses dogtail to find and interact
with Flutter widgets through their accessibility labels (Semantics).

Key concepts:
- Flutter's Semantics tree maps to AT-SPI accessible nodes
- Widget text/labels appear as the node's "name" attribute
- Buttons are "push button" role, text fields are "text" role
- dogtail.tree.root is the AT-SPI root node for all running apps
"""

import subprocess
import time
import os

try:
    from dogtail.tree import root
    from dogtail import rawinput
    from dogtail.utils import run
    from dogtail.predicate import GenericPredicate
    DOGTAIL_AVAILABLE = True
except ImportError:
    DOGTAIL_AVAILABLE = False

from config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT


class LinuxAppHelper:
    """Helper for interacting with the Zajel Flutter app on Linux via AT-SPI.

    Mirrors the AppHelper class from the Android E2E tests, adapted for
    desktop AT-SPI accessibility.
    """

    def __init__(self, app_path: str, data_dir: str, instance_name: str = "zajel"):
        """Initialize the helper.

        Args:
            app_path: Path to the Flutter Linux app binary.
            data_dir: Custom data directory for this app instance.
            instance_name: Name for identifying the AT-SPI app node.
        """
        if not DOGTAIL_AVAILABLE:
            raise RuntimeError(
                "dogtail not available. Install with: pip install dogtail"
            )

        self.app_path = app_path
        self.data_dir = data_dir
        self.instance_name = instance_name
        self.process = None
        self.app = None

    def launch(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Launch the app and wait for it to appear in the AT-SPI tree."""
        # Ensure data directory exists
        os.makedirs(self.data_dir, exist_ok=True)

        # Set XDG_DATA_HOME to isolate this instance's storage
        env = os.environ.copy()
        env["XDG_DATA_HOME"] = os.path.join(self.data_dir, "data")
        env["XDG_CONFIG_HOME"] = os.path.join(self.data_dir, "config")
        env["XDG_CACHE_HOME"] = os.path.join(self.data_dir, "cache")

        # On CI (no GPU), use Mesa's software rasterizer (llvmpipe) via
        # LIBGL_ALWAYS_SOFTWARE instead of Flutter's --enable-software-rendering.
        # Flutter's software renderer bypasses the GTK embedder's normal
        # rendering path, which also skips AT-SPI accessibility registration.
        # llvmpipe keeps the full GTK pipeline intact while using CPU rendering.
        #
        # GTK_MODULES=gail:atk-bridge forces GTK to load the ATK bridge,
        # which registers the app with AT-SPI. Without it, the bridge may
        # not load in headless environments where accessibility isn't autodetected.
        cmd = [self.app_path]
        if os.environ.get("CI"):
            env["LIBGL_ALWAYS_SOFTWARE"] = "1"
            env["GTK_MODULES"] = "gail:atk-bridge"

        self.process = subprocess.Popen(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Wait for the app to register with AT-SPI
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                # Check if process crashed
                if self.process.poll() is not None:
                    stderr = self.process.stderr.read().decode(errors="replace")
                    raise RuntimeError(
                        f"App exited with code {self.process.returncode}. "
                        f"stderr:\n{stderr[-2000:]}"
                    )
                self.app = root.application("zajel")
                return
            except RuntimeError:
                raise
            except Exception:
                time.sleep(1)

        # Timeout — capture stderr for diagnostics
        stderr = ""
        if self.process.poll() is not None:
            stderr = self.process.stderr.read().decode(errors="replace")[-2000:]
        else:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
                stderr = self.process.stderr.read().decode(errors="replace")[-2000:]
            except Exception:
                self.process.kill()
        raise TimeoutError(
            f"App did not appear in AT-SPI tree within {timeout}s. "
            f"stderr:\n{stderr}"
        )

    def stop(self):
        """Stop the app."""
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None
            self.app = None

    def find_by_name(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find a widget by its accessible name (Semantics label).

        Args:
            name: Text to search for in the AT-SPI name attribute.
            timeout: Maximum seconds to wait for the element.

        Returns:
            The AT-SPI node matching the name.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                node = self.app.child(name, retry=False)
                if node:
                    return node
            except Exception:
                pass
            time.sleep(0.5)

        raise TimeoutError(f"Element '{name}' not found within {timeout}s")

    def find_by_role(self, role: str, name: str = None, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find a widget by AT-SPI role and optionally by name.

        Args:
            role: AT-SPI role (e.g., "push button", "text", "frame").
            name: Optional name to filter by.
            timeout: Maximum seconds to wait.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                predicate = GenericPredicate(roleName=role, name=name or "")
                node = self.app.findChild(predicate, retry=False)
                if node:
                    return node
            except Exception:
                pass
            time.sleep(0.5)

        raise TimeoutError(
            f"Element role='{role}' name='{name}' not found within {timeout}s"
        )

    def click(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find and click an element by name."""
        node = self.find_by_name(name, timeout)
        node.click()
        time.sleep(0.5)

    def type_text(self, text: str):
        """Type text into the currently focused field."""
        rawinput.typeText(text)

    def press_key(self, key: str):
        """Press a keyboard key (e.g., 'Return', 'Escape', 'BackSpace')."""
        rawinput.pressKey(key)

    # ── App lifecycle ──────────────────────────────────────────────

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the home screen to be visible."""
        self.find_by_name("Zajel", timeout)

    def clear_data(self):
        """Clear all app data by removing the data directory."""
        import shutil
        self.stop()
        if os.path.exists(self.data_dir):
            shutil.rmtree(self.data_dir)

    # ── Navigation ────────────────────────────────────────────────

    def navigate_to_connect(self):
        """Tap the Connect FAB."""
        self.click("Connect")
        self.find_by_name("My Code")

    def go_back_to_home(self):
        """Navigate back to home screen."""
        self.press_key("Escape")
        time.sleep(0.5)

    def navigate_to_settings(self):
        """Tap Settings in the app bar."""
        self.click("Settings")
        time.sleep(1)

    def navigate_to_contacts(self):
        """Tap the Contacts button from home screen."""
        self.click("Contacts")
        time.sleep(1)

    def navigate_to_notification_settings(self):
        """Navigate to Settings > Notifications."""
        self.navigate_to_settings()
        self.click("Notifications")

    def navigate_to_media_settings(self):
        """Navigate to Settings > Audio & Video."""
        self.navigate_to_settings()
        self.click("Audio & Video")

    def navigate_to_blocked_list(self):
        """Navigate to Settings > Blocked Users."""
        self.navigate_to_settings()
        self.click("Blocked Users")

    # ── Pairing ──────────────────────────────────────────────────

    def get_pairing_code(self) -> str:
        """Get the pairing code from the home screen."""
        node = self.find_by_name("Code:", timeout=30)
        # Extract the code from text like "Code: ABCDEF"
        text = node.name
        return text.replace("Code:", "").strip()

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code displayed on the Connect screen."""
        # Look for 6-character text
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                # Search for children that look like a 6-char code
                for child in self.app.findChildren(
                    GenericPredicate(roleName="label")
                ):
                    text = child.name.strip()
                    if len(text) == 6 and text.isalnum() and text.isupper():
                        return text
            except Exception:
                pass
            time.sleep(1)
        raise TimeoutError("Pairing code not found on Connect screen")

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code and submit."""
        # Find the text field
        text_field = self.find_by_role("text", timeout=10)
        text_field.click()
        self.type_text(code)
        time.sleep(0.5)

        # Click Connect button
        self.click("Connect")

    def wait_for_signaling_connected(self, timeout: int = 60):
        """Wait for signaling server connection."""
        self.find_by_name("Code:", timeout)

    # ── Peer state ───────────────────────────────────────────────

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if a peer shows as Connected."""
        try:
            self.find_by_name("Connected", timeout=3)
            return True
        except (TimeoutError, Exception):
            return False

    def is_peer_offline(self, peer_name: str = None) -> bool:
        """Check if a peer shows as offline with last seen."""
        try:
            self.find_by_name("Last seen", timeout=3)
            return True
        except (TimeoutError, Exception):
            return False

    def open_chat_with_peer(self, peer_name: str = None):
        """Click a connected peer to open chat."""
        if peer_name:
            self.click(peer_name)
        else:
            # Click first connected peer
            node = self.find_by_name("Connected", timeout=10)
            node.click()
        time.sleep(1)

    # ── Messaging ────────────────────────────────────────────────

    def send_message(self, text: str):
        """Type and send a message in chat."""
        text_field = self.find_by_role("text", timeout=10)
        text_field.click()
        self.type_text(text)
        self.click("Send message")

    def has_message(self, text: str) -> bool:
        """Check if a message is visible in chat."""
        try:
            self.find_by_name(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Calls ────────────────────────────────────────────────────

    def start_voice_call(self):
        """Start a voice call."""
        self.click("Voice call")

    def start_video_call(self):
        """Start a video call."""
        self.click("Video call")

    def accept_incoming_call(self, with_video: bool = False):
        """Accept an incoming call."""
        if with_video:
            self.click("Video")
        else:
            try:
                self.click("Accept")
            except TimeoutError:
                self.click("Audio")

    def reject_incoming_call(self):
        """Reject an incoming call."""
        self.click("Decline")

    def end_call(self):
        """End the current call."""
        self.click("End")

    def has_incoming_call_dialog(self, timeout: int = 15) -> bool:
        """Check if incoming call dialog is visible."""
        try:
            self.find_by_name("Incoming", timeout)
            return True
        except (TimeoutError, Exception):
            return False

    def wait_for_call_connected(self, timeout: int = 30) -> bool:
        """Wait for call to connect (duration timer visible)."""
        try:
            self.find_by_name("00:", timeout)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Settings ─────────────────────────────────────────────────

    def change_display_name(self, name: str):
        """Change the display name in settings."""
        self.click("Tap to change display name")
        time.sleep(0.5)
        text_field = self.find_by_role("text", timeout=10)
        text_field.click()
        # Select all and replace
        rawinput.keyCombo("<Ctrl>a")
        self.type_text(name)
        self.click("Save")

    # ── Emoji ────────────────────────────────────────────────────

    def open_emoji_picker(self):
        """Open the emoji picker in chat."""
        self.click("Emoji")
        time.sleep(1)

    def close_emoji_picker(self):
        """Close the emoji picker."""
        self.click("Keyboard")
        time.sleep(1)

    # ── Contacts ─────────────────────────────────────────────────

    def set_peer_alias(self, alias: str):
        """Set a peer alias in contact detail."""
        self.click("Edit alias")
        time.sleep(0.5)
        text_field = self.find_by_role("text", timeout=10)
        text_field.click()
        rawinput.keyCombo("<Ctrl>a")
        self.type_text(alias)
        self.click("Save")

    def search_contacts(self, query: str):
        """Search in the contacts list."""
        text_field = self.find_by_role("text", timeout=10)
        text_field.click()
        self.type_text(query)

    # ── Blocked ──────────────────────────────────────────────────

    def confirm_dialog(self, button_text: str):
        """Click a dialog button by text."""
        self.click(button_text)
        time.sleep(0.5)

    def dismiss_dialog(self):
        """Dismiss a dialog by clicking Cancel."""
        self.click("Cancel")
        time.sleep(0.5)
