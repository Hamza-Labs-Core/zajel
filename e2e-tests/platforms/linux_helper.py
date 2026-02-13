"""
Shelf HTTP helper for Linux desktop E2E testing.

Uses the appium_flutter_server's embedded Shelf HTTP server to interact
with Flutter widgets directly, bypassing AT-SPI entirely. This makes
Linux E2E tests work in headless CI environments (Xvfb) where Flutter's
AT-SPI bridge doesn't function properly.

The Flutter app is built with `integration_test/appium_test.dart` as
the entry point, which starts the Shelf server on port 9000-9020.
This helper communicates with that server over HTTP.
"""

import subprocess
import time
import os

from platforms.linux_config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT
from platforms.shelf_client import ShelfClient


class LinuxAppHelper:
    """Helper for interacting with the Zajel Flutter app on Linux via Shelf HTTP.

    Mirrors the AppHelper class from the Android E2E tests. Instead of using
    AT-SPI (which doesn't work in headless Xvfb), it communicates with the
    embedded Shelf HTTP server that runs inside the Flutter integration test
    binary.
    """

    # Track which Shelf ports are in use (for multi-instance support)
    _claimed_ports: set = set()

    def __init__(self, app_path: str, data_dir: str, instance_name: str = "zajel"):
        self.app_path = app_path
        self.data_dir = data_dir
        self.instance_name = instance_name
        self.process = None
        self._shelf = None
        self._shelf_port = None
        self._launch_mode = None  # "binary" or "flutter_test"

    def launch(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Launch the app and wait for the Shelf HTTP server to be ready.

        Supports three launch modes (auto-detected):

        **Pre-launched mode** (``ZAJEL_SHELF_PORT`` is set):
            The app and its Shelf server are already running (e.g. CI starts
            ``flutter test integration_test/appium_test.dart -d linux &``
            before pytest). Skips process launch, connects directly.

        **Binary mode** (``app_path`` exists as executable):
            Runs the pre-built binary directly. The binary must have been
            built with ``--target integration_test/appium_test.dart`` so
            the embedded Shelf HTTP server is included.

        **Flutter-test mode** (fallback):
            Runs ``flutter test integration_test/appium_test.dart -d linux``
            which compiles and launches the app in one step. Useful for local
            development without a prior ``flutter build linux`` step.
            Set ``ZAJEL_PROJECT_DIR`` to override the project path.
        """
        # ── Pre-launched mode: app already running externally ──
        pre_port = os.environ.get("ZAJEL_SHELF_PORT")
        if pre_port:
            self._launch_mode = "pre_launched"
            self._shelf_port = int(pre_port)
            self._shelf = ShelfClient(port=self._shelf_port)
            self._shelf.wait_for_server(timeout=timeout)
            self._shelf.create_session()
            LinuxAppHelper._claimed_ports.add(self._shelf_port)
            print(f"Pre-launched mode: connected to Shelf server on port {self._shelf_port}")
            return

        # ── Scan for an already-running Shelf server (CI may not set the env var) ──
        existing_port = self._probe_existing_server()
        if existing_port is not None:
            self._launch_mode = "pre_launched"
            self._shelf_port = existing_port
            self._shelf = ShelfClient(port=self._shelf_port)
            self._shelf.create_session()
            LinuxAppHelper._claimed_ports.add(self._shelf_port)
            print(f"Pre-launched mode: found existing Shelf server on port {existing_port}")
            return

        # ── Self-launched: start the app process ──
        os.makedirs(self.data_dir, exist_ok=True)

        env = os.environ.copy()
        env["XDG_DATA_HOME"] = os.path.join(self.data_dir, "data")
        env["XDG_CONFIG_HOME"] = os.path.join(self.data_dir, "config")
        env["XDG_CACHE_HOME"] = os.path.join(self.data_dir, "cache")

        if os.environ.get("CI"):
            env["LIBGL_ALWAYS_SOFTWARE"] = "1"

        if os.path.isfile(self.app_path) and os.access(self.app_path, os.X_OK):
            self._launch_mode = "binary"
            cmd = [self.app_path]
            cwd = None
        else:
            self._launch_mode = "flutter_test"
            project_dir = self._find_project_dir()
            cmd = [
                "flutter", "test",
                "integration_test/appium_test.dart",
                "-d", "linux",
            ]
            cwd = project_dir
            # flutter test compiles first; allow extra time
            timeout = max(timeout, 180)
            print(f"No binary at {self.app_path} — using flutter test mode from {project_dir}")

        # start_new_session=True creates a new process group so we can
        # kill the entire tree in flutter_test mode (flutter → dart → app).
        self.process = subprocess.Popen(
            cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            start_new_session=(self._launch_mode == "flutter_test"),
        )

        # Find the Shelf server port (9000-9020 range)
        self._shelf_port = self._find_server_port(timeout)
        self._shelf = ShelfClient(port=self._shelf_port)
        self._shelf.create_session()

    def _probe_existing_server(self) -> int | None:
        """Check if a Shelf server is already running on ports 9000-9020."""
        for port in range(9000, 9021):
            if port in LinuxAppHelper._claimed_ports:
                continue
            try:
                client = ShelfClient(port=port, timeout=1)
                client._get("/status")
                return port
            except Exception:
                continue
        return None

    def _find_project_dir(self) -> str:
        """Derive the Flutter project directory for flutter-test mode."""
        # Explicit override
        project_dir = os.environ.get("ZAJEL_PROJECT_DIR")
        if project_dir and os.path.isfile(os.path.join(project_dir, "pubspec.yaml")):
            return project_dir

        # Try to infer from app_path (flutter build layout):
        #   .../packages/app/build/linux/x64/release/bundle/zajel
        parts = os.path.normpath(self.app_path).split(os.sep)
        for i in range(len(parts) - 1, -1, -1):
            if parts[i] == "build" and i > 0:
                candidate = os.sep.join(parts[:i])
                if os.path.isfile(os.path.join(candidate, "pubspec.yaml")):
                    return candidate

        # Fallback: common local layout
        for candidate in [
            os.path.expanduser("~/zajel/packages/app"),
            os.path.join(os.getcwd(), "packages", "app"),
        ]:
            if os.path.isfile(os.path.join(candidate, "pubspec.yaml")):
                return candidate

        raise FileNotFoundError(
            f"Cannot find Flutter project directory. "
            f"Set ZAJEL_PROJECT_DIR or build the binary first at {self.app_path}"
        )

    def _find_server_port(self, timeout: int = 60) -> int:
        """Scan ports 9000-9020 to find the Shelf server for this process."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.process.poll() is not None:
                stderr = self.process.stderr.read().decode(errors="replace")
                raise RuntimeError(
                    f"App exited with code {self.process.returncode}. "
                    f"stderr:\n{stderr[-2000:]}"
                )
            for port in range(9000, 9021):
                if port in LinuxAppHelper._claimed_ports:
                    continue
                try:
                    client = ShelfClient(port=port, timeout=2)
                    client._get("/status")
                    LinuxAppHelper._claimed_ports.add(port)
                    print(f"Shelf server found on port {port}")
                    return port
                except Exception:
                    continue
            time.sleep(1)

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
            f"Shelf server not found on ports 9000-9020 within {timeout}s. "
            f"stderr:\n{stderr}"
        )

    def stop(self):
        """Stop the app and release the Shelf port.

        In pre-launched mode, only closes the Shelf session (the external
        process is managed by CI / the caller).
        """
        if self._shelf:
            try:
                self._shelf.delete_session()
            except Exception:
                pass
            self._shelf = None

        if self._shelf_port is not None:
            LinuxAppHelper._claimed_ports.discard(self._shelf_port)
            self._shelf_port = None

        # Don't kill the process in pre-launched mode — we don't own it.
        if self.process:
            if self._launch_mode == "flutter_test":
                # Kill the whole process group (flutter → dart → app).
                try:
                    import signal
                    os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
                except (OSError, ProcessLookupError):
                    self.process.terminate()
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None

    # ── Element finding ────────────────────────────────────────

    def _find(self, text: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find an element by text, trying multiple Shelf strategies.

        Tries in order: text → text containing → tooltip → semantics label.
        Returns a ShelfElement on success, raises on timeout.
        """
        deadline = time.time() + timeout
        strategies = ["text", "text containing", "tooltip", "semantics label"]
        last_error = None

        while time.time() < deadline:
            for strategy in strategies:
                try:
                    return self._shelf.find_element(strategy, text, timeout=3)
                except Exception as e:
                    last_error = e
                    continue
            time.sleep(0.5)

        raise TimeoutError(
            f"Element '{text}' not found within {timeout}s. Last error: {last_error}"
        )

    def _find_text_field(self, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find the first visible text input field (TextField)."""
        return self._shelf.find_by_type("TextField", timeout=timeout)

    def find_by_name(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find a widget by its text or semantics label."""
        return self._find(name, timeout)

    def find_by_role(self, role: str, name: str = None, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find a widget by role. Maps AT-SPI roles to Shelf types."""
        if role == "text":
            return self._find_text_field(timeout)
        elif role == "push button" and name:
            return self._find(name, timeout)
        else:
            return self._find(name or role, timeout)

    def click(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find and click an element by name."""
        el = self._find(name, timeout)
        el.click()
        time.sleep(0.5)

    def type_text(self, text: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Enter text into the first visible text field."""
        field = self._find_text_field(timeout)
        field.set_text(text)

    def press_key(self, key: str):
        """Simulate a key press. Limited to back/escape via Shelf API."""
        if key.lower() in ("escape", "back"):
            self._shelf.press_back()
        else:
            print(f"Warning: press_key('{key}') not supported via Shelf HTTP")

    # ── App lifecycle ──────────────────────────────────────────

    def wait_for_app_ready(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Wait for the home screen to be visible, dismissing onboarding if needed."""
        try:
            self._find("Zajel", timeout=15)
            return
        except TimeoutError:
            pass

        # Try dismissing onboarding screen (first launch)
        self._dismiss_onboarding()

        # Now wait for the actual home screen
        self._find("Zajel", timeout)

    def _dismiss_onboarding(self):
        """Dismiss the onboarding screen if present (first launch)."""
        try:
            skip_el = self._find("Skip", timeout=5)
            print("[wait_for_app_ready] Onboarding screen detected, clicking Skip")
            skip_el.click()
            time.sleep(2)
        except (TimeoutError, Exception):
            pass  # No onboarding screen

    def clear_data(self):
        """Clear all app data by removing the data directory."""
        import shutil
        self.stop()
        if os.path.exists(self.data_dir):
            shutil.rmtree(self.data_dir)

    # ── Navigation ─────────────────────────────────────────────

    def navigate_to_connect(self):
        """Tap the Connect FAB."""
        self.click("Connect")
        self._find("My Code")

    def go_back_to_home(self):
        """Navigate back to home screen."""
        self._shelf.press_back()
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

    # ── Pairing ─────────────────────────────────────────────────

    def get_pairing_code(self) -> str:
        """Get the pairing code from the home screen."""
        el = self._find("Code:", timeout=30)
        text = el.get_text()
        return text.replace("Code:", "").strip()

    def get_pairing_code_from_connect_screen(self) -> str:
        """Get the pairing code displayed on the Connect screen.

        Scans for a 6-character alphanumeric uppercase text element.
        """
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                elements = self._shelf.find_elements("type", "Text")
                for el in elements:
                    try:
                        text = el.get_text().strip()
                        if len(text) == 6 and text.isalnum() and text.isupper():
                            return text
                    except Exception:
                        continue
            except Exception:
                pass
            time.sleep(1)
        raise TimeoutError("Pairing code not found on Connect screen")

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code and submit."""
        field = self._find_text_field(timeout=10)
        field.set_text(code)
        time.sleep(0.5)
        self.click("Connect")

    def wait_for_signaling_connected(self, timeout: int = 60):
        """Wait for signaling server connection."""
        self._find("Code:", timeout)

    # ── Peer state ──────────────────────────────────────────────

    def is_peer_connected(self, peer_name: str = None) -> bool:
        """Check if a peer shows as Connected."""
        try:
            self._find("Connected", timeout=3)
            return True
        except (TimeoutError, Exception):
            return False

    def is_peer_offline(self, peer_name: str = None) -> bool:
        """Check if a peer shows as offline with last seen."""
        try:
            self._find("Last seen", timeout=3)
            return True
        except (TimeoutError, Exception):
            return False

    def open_chat_with_peer(self, peer_name: str = None):
        """Click a connected peer to open chat."""
        if peer_name:
            self.click(peer_name)
        else:
            el = self._find("Connected", timeout=10)
            el.click()
        time.sleep(1)

    # ── Messaging ───────────────────────────────────────────────

    def send_message(self, text: str):
        """Type and send a message in chat."""
        field = self._find_text_field(timeout=10)
        field.set_text(text)
        self.click("Send message")

    def has_message(self, text: str) -> bool:
        """Check if a message is visible in chat."""
        try:
            self._find(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Calls ───────────────────────────────────────────────────

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
            self._find("Incoming", timeout)
            return True
        except (TimeoutError, Exception):
            return False

    def wait_for_call_connected(self, timeout: int = 30) -> bool:
        """Wait for call to connect (duration timer visible)."""
        try:
            self._shelf.find_by_text_containing("00:", timeout=timeout)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Settings ────────────────────────────────────────────────

    def change_display_name(self, name: str):
        """Change the display name in settings."""
        self.click("Tap to change display name")
        time.sleep(0.5)
        field = self._find_text_field(timeout=10)
        field.clear()
        field.set_text(name)
        self.click("Save")

    # ── Emoji ───────────────────────────────────────────────────

    def open_emoji_picker(self):
        """Open the emoji picker in chat."""
        self.click("Emoji")
        time.sleep(1)

    def close_emoji_picker(self):
        """Close the emoji picker."""
        self.click("Keyboard")
        time.sleep(1)

    # ── Contacts ────────────────────────────────────────────────

    def set_peer_alias(self, alias: str):
        """Set a peer alias in contact detail."""
        self.click("Edit alias")
        time.sleep(0.5)
        field = self._find_text_field(timeout=10)
        field.clear()
        field.set_text(alias)
        self.click("Save")

    def search_contacts(self, query: str):
        """Search in the contacts list."""
        field = self._find_text_field(timeout=10)
        field.set_text(query)

    # ── Blocked ─────────────────────────────────────────────────

    def confirm_dialog(self, button_text: str):
        """Click a dialog button by text."""
        self.click(button_text)
        time.sleep(0.5)

    def dismiss_dialog(self):
        """Dismiss a dialog by clicking Cancel."""
        self.click("Cancel")
        time.sleep(0.5)

    # ── Channels ────────────────────────────────────────────────

    def navigate_to_channels(self):
        """Tap 'Channels' button from home screen."""
        self.click("Channels")
        time.sleep(1)

    def navigate_to_groups(self):
        """Tap 'Groups' button from home screen."""
        self.click("Groups")
        time.sleep(1)

    def create_channel(self, name, description=""):
        """Create a channel via FAB -> dialog -> fill fields -> tap Create."""
        self.click("Create Channel")
        time.sleep(1)

        # Find text fields and fill them
        fields = self._shelf.find_elements("type", "TextField")
        if fields:
            fields[0].set_text(name)
            if description and len(fields) > 1:
                fields[1].set_text(description)

        self.click("Create")
        time.sleep(2)

    def open_channel(self, name):
        """Tap a channel in the list by name."""
        self.click(name)
        time.sleep(1)

    def get_channel_invite_link(self):
        """Open share dialog -> extract link text -> dismiss."""
        self.click("Share channel")
        time.sleep(2)

        link = ""
        try:
            el = self._shelf.find_by_text_containing("zajel://", timeout=10)
            link = el.get_text()
        except Exception:
            pass

        try:
            self.click("Done")
        except (TimeoutError, Exception):
            self._shelf.press_back()
        time.sleep(1)

        return link

    def publish_channel_message(self, text):
        """Type in publish field -> tap 'Publish' button."""
        field = self._find_text_field(timeout=10)
        field.set_text(text)
        self.click("Publish")
        time.sleep(2)

    def has_channel_message(self, text):
        """Check if a channel message is visible."""
        try:
            self._find(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    # ── Groups ──────────────────────────────────────────────────

    def create_group(self, name):
        """Create a group via FAB -> dialog -> fill name -> tap Create."""
        self.click("Create Group")
        time.sleep(1)

        field = self._find_text_field(timeout=10)
        field.set_text(name)

        self.click("Create")
        time.sleep(2)

    def open_group(self, name):
        """Tap a group in the list by name."""
        self.click(name)
        time.sleep(1)

    def add_group_member(self, peer_name):
        """Tap 'Add member' -> select peer by name."""
        self.click("Add member")
        time.sleep(1)
        self.click(peer_name)
        time.sleep(2)

    def send_group_message(self, text):
        """Type in message field -> tap 'Send' button."""
        field = self._find_text_field(timeout=10)
        field.set_text(text)
        self.click("Send")
        time.sleep(2)

    def has_group_message(self, text):
        """Check if a group message is visible."""
        try:
            self._find(text, timeout=5)
            return True
        except (TimeoutError, Exception):
            return False

    def open_members_sheet(self):
        """Tap the members button to open the bottom sheet."""
        self._shelf.find_by_text_containing("members", timeout=ELEMENT_WAIT_TIMEOUT).click()
        time.sleep(1)

    # ── Screenshots ─────────────────────────────────────────────

    def take_screenshot(self, name):
        """Save screenshot via the Shelf HTTP API (base64 PNG)."""
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        try:
            self._shelf.take_screenshot(path)
            print(f"Screenshot saved: {path}")
        except Exception as e:
            print(f"Screenshot failed: {e}")
