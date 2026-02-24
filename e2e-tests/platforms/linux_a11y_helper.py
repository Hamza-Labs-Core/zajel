"""
Hybrid Shelf HTTP + pyautogui helper for Linux desktop E2E testing.

Flutter's AT-SPI bridge on Linux does not expose the full widget Semantics
tree (only shallow panel hierarchy). This helper uses the plan's fallback:

- **Shelf HTTP** (via appium_flutter_server) for element finding and position
  retrieval — reliable because it queries Flutter's widget tree directly.
- **pyautogui** for real mouse cursor movement and keyboard input — physically
  moves the cursor to elements and clicks, just like a human user.

The app is launched via ``flutter test integration_test/appium_test.dart``
(or a pre-built binary that embeds the Shelf server), which starts the
Shelf HTTP server on port 9000-9020.

Requirements:
- Xvfb (or real display) with DISPLAY set
- Python packages: pyautogui
- The Flutter app binary built with ``--target integration_test/appium_test.dart``
"""

import os
import subprocess
import time

try:
    import pyautogui
    pyautogui.FAILSAFE = False  # No fail-safe in headless Xvfb
    pyautogui.PAUSE = 0.1
    PYAUTOGUI_AVAILABLE = True
except ImportError:
    PYAUTOGUI_AVAILABLE = False

from platforms.linux_config import APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT
from platforms.linux_helper import LinuxAppHelper


class LinuxDesktopHelper(LinuxAppHelper):
    """Hybrid helper: Shelf HTTP for finding + pyautogui for real cursor.

    Extends LinuxAppHelper (which handles all Shelf HTTP communication) and
    overrides click/type methods to use pyautogui for physical cursor
    movement and keyboard input.

    The window position offset is needed to convert Shelf's widget-relative
    coordinates to absolute screen coordinates for pyautogui.
    """

    def __init__(self, app_path: str, data_dir: str, instance_name: str = "zajel"):
        if not PYAUTOGUI_AVAILABLE:
            raise RuntimeError(
                "pyautogui not available. Install with: pip install pyautogui"
            )
        super().__init__(app_path, data_dir, instance_name)
        # Window content area offset on screen (set after launch)
        self._window_x = 0
        self._window_y = 0
        self._window_w = 0
        self._window_h = 0
        # Whether pyautogui cursor clicks are meaningful (window large enough)
        self._cursor_clicks_enabled = False

    def launch(self, timeout: int = APP_LAUNCH_TIMEOUT):
        """Launch app via Shelf (parent), then determine window position."""
        super().launch(timeout=timeout)
        self._detect_window_position()

    def _detect_window_position(self):
        """Detect the Flutter window's position and size on screen.

        Uses xdotool to find the window by name and get its geometry.
        If the window is too small (e.g. 10x10 from IntegrationTestBinding),
        disables pyautogui cursor clicks since the coordinates would be
        meaningless — the internal render surface (1280x720) doesn't match
        the GTK window dimensions.
        """
        try:
            result = subprocess.run(
                ["xdotool", "search", "--name", "Zajel"],
                capture_output=True, text=True, timeout=5,
            )
            window_ids = result.stdout.strip().split("\n")
            if window_ids and window_ids[0]:
                wid = window_ids[0]
                geo = subprocess.run(
                    ["xdotool", "getwindowgeometry", "--shell", wid],
                    capture_output=True, text=True, timeout=5,
                )
                for line in geo.stdout.strip().split("\n"):
                    if line.startswith("X="):
                        self._window_x = int(line.split("=")[1])
                    elif line.startswith("Y="):
                        self._window_y = int(line.split("=")[1])
                    elif line.startswith("WIDTH="):
                        self._window_w = int(line.split("=")[1])
                    elif line.startswith("HEIGHT="):
                        self._window_h = int(line.split("=")[1])

                # Enable cursor clicks only if window is large enough for
                # meaningful cursor interaction (at least 200x200).
                min_size = 200
                self._cursor_clicks_enabled = (
                    self._window_w >= min_size and self._window_h >= min_size
                )
                print(
                    f"[LinuxDesktopHelper] Window: pos=({self._window_x},{self._window_y}) "
                    f"size={self._window_w}x{self._window_h} "
                    f"cursor_clicks={'ON' if self._cursor_clicks_enabled else 'OFF'}"
                )
        except Exception as e:
            print(f"[LinuxDesktopHelper] Window detection failed: {e}, cursor clicks OFF")

    def _get_element_screen_center(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find element via Shelf, get its rect, compute screen center.

        Returns (screen_x, screen_y) for pyautogui cursor movement.
        """
        el = self._find(name, timeout)
        try:
            rect = el.get_rect()
            # Shelf may return rect values as strings; cast to float
            x = float(rect.get("x", 0))
            y = float(rect.get("y", 0))
            w = float(rect.get("width", 0))
            h = float(rect.get("height", 0))
            # Convert widget-relative to screen-absolute
            screen_x = self._window_x + x + w / 2
            screen_y = self._window_y + y + h / 2
            return int(screen_x), int(screen_y)
        except Exception as e:
            print(f"[LinuxDesktopHelper] get_rect failed for '{name}': {e}")
            # Fall back to Shelf programmatic click
            raise

    def click(self, name: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Find element, move real cursor to it, and click.

        When the window is large enough for meaningful cursor interaction,
        uses pyautogui to physically move the cursor and click (like a
        human user). Falls back to Shelf programmatic click when:
        - The window is too small (integration test 10x10 surface)
        - Element rect retrieval fails
        """
        if self._cursor_clicks_enabled:
            try:
                cx, cy = self._get_element_screen_center(name, timeout)
                pyautogui.moveTo(cx, cy, duration=0.2)
                pyautogui.click()
                time.sleep(0.5)
                return
            except Exception:
                pass
        # Shelf programmatic click (always works)
        super().click(name, timeout)

    def type_text(self, text: str, timeout: int = ELEMENT_WAIT_TIMEOUT):
        """Type text via pyautogui keyboard simulation.

        First clicks into the text field (via Shelf), then uses pyautogui
        to type each character as real keyboard input.
        """
        # Find and focus the text field via Shelf
        field = self._find_text_field(timeout)
        try:
            rect = field.get_rect()
            x = float(rect.get("x", 0))
            y = float(rect.get("y", 0))
            w = float(rect.get("width", 0))
            h = float(rect.get("height", 0))
            screen_x = int(self._window_x + x + w / 2)
            screen_y = int(self._window_y + y + h / 2)
            pyautogui.moveTo(screen_x, screen_y, duration=0.15)
            pyautogui.click()
            time.sleep(0.3)
        except Exception:
            # Fallback: programmatic click on field
            field.click()
            time.sleep(0.3)

        # Type via real keyboard
        for char in text:
            pyautogui.press(char.lower())
        time.sleep(0.3)

    def press_key(self, key: str):
        """Press a keyboard key via pyautogui, or fall back to Shelf.

        When cursor clicks are enabled (real window detected), uses pyautogui
        to send real keyboard events. Otherwise falls back to the parent
        class's Shelf-based press_key (supports escape/back only).
        """
        if self._cursor_clicks_enabled:
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
        else:
            # Fall back to Shelf programmatic key press
            super().press_key(key)

    # ── Navigation overrides (use real cursor where possible) ──

    def go_back_to_home(self):
        """Navigate back using real Escape key or Shelf press_back."""
        if self._cursor_clicks_enabled:
            self.press_key("escape")
            time.sleep(0.5)
        else:
            super().go_back_to_home()

    # ── Screenshots ─────────────────────────────────────────────

    def take_screenshot(self, name: str):
        """Save screenshot via pyautogui (captures entire screen).

        This captures the real screen (including cursor position) rather
        than just the Flutter render tree like Shelf's screenshot.
        """
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        try:
            screenshot = pyautogui.screenshot()
            screenshot.save(path)
            print(f"Screenshot saved: {path}")
        except Exception as e:
            print(f"pyautogui screenshot failed: {e}, trying Shelf")
            super().take_screenshot(name)
