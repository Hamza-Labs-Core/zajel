"""
Android (Appium/UiAutomator2) helper for E2E testing.

Extracted from e2e-tests/conftest.py. Provides the AppHelper class
that interacts with the Zajel Flutter app via Appium + UiAutomator2.
"""

from __future__ import annotations


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

    def __init__(self, driver):
        self.driver = driver

    def _dismiss_system_dialog(self):
        """Dismiss 'System UI isn't responding' or similar ANR dialogs."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            wait_btn = self.driver.find_element(
                "id", "android:id/aerr_wait"
            )
            print("Dismissing 'System UI isn't responding' dialog")
            wait_btn.click()
        except NoSuchElementException:
            pass

    def wait_for_app_ready(self, timeout: int = 60):
        """Wait for the app to be fully loaded and showing the home screen.

        Detection strategy:
        1. Dismiss any ANR dialogs (System UI not responding)
        2. Wait for the actual home screen content -- the "Zajel" title or
           "Connect" FAB -- not just any android.view.View (which also
           matches the loading spinner shown during initialization).
        """
        import time as _time
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        # Brief wait for app process to start
        _time.sleep(3)

        # Log current app state for CI debugging
        try:
            activity = self.driver.current_activity
            print(f"[wait_for_app_ready] current_activity={activity}")
        except Exception as e:
            print(f"[wait_for_app_ready] failed to get activity: {e}")

        # Dismiss any ANR dialog that might be blocking
        self._dismiss_system_dialog()

        # Wait for the actual home screen to render.
        home_screen_xpath = (
            "//*[@package='com.zajel.zajel' and "
            "(contains(@text, 'Zajel') or contains(@content-desc, 'Zajel') or "
            "contains(@text, 'Connect') or contains(@content-desc, 'Connect'))]"
        )
        try:
            WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((By.XPATH, home_screen_xpath))
            )
        except Exception:
            # Try dismissing dialog again and retry once
            self._dismiss_system_dialog()
            _time.sleep(3)
            try:
                WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((By.XPATH, home_screen_xpath))
                )
            except Exception:
                print("=== PAGE SOURCE (app not ready) ===")
                try:
                    source = self.driver.page_source
                    print(source[:20000] if source else "EMPTY PAGE SOURCE")
                except Exception as e:
                    print(f"Failed to get page source: {e}")
                print("=== END PAGE SOURCE ===")
                raise

        # Dismiss onboarding screen if present (first launch after pm clear)
        self._dismiss_onboarding()

    def _dismiss_onboarding(self):
        """Dismiss the onboarding screen if present (first launch after pm clear)."""
        import time as _time
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        try:
            skip_btn = self.driver.find_element(
                By.XPATH,
                "//*[@package='com.zajel.zajel' and "
                "(contains(@text, 'Skip') or contains(@content-desc, 'Skip'))]"
            )
            print("[wait_for_app_ready] Onboarding screen detected, tapping Skip")
            skip_btn.click()
            _time.sleep(2)
            # Re-wait for the actual home screen after onboarding dismissal
            home_screen_xpath = (
                "//*[@package='com.zajel.zajel' and "
                "(contains(@text, 'Code:') or contains(@content-desc, 'Code:') or "
                "contains(@text, 'Online') or contains(@content-desc, 'Online') or "
                "contains(@text, 'Connecting') or contains(@content-desc, 'Connecting') or "
                "contains(@text, 'Offline') or contains(@content-desc, 'Offline'))]"
            )
            WebDriverWait(self.driver, 15).until(
                EC.presence_of_element_located((By.XPATH, home_screen_xpath))
            )
            print("[wait_for_app_ready] Home screen confirmed after onboarding dismissal")
        except Exception:
            pass  # No onboarding screen -- already on home

    def _find(self, text, timeout=10, partial=True):
        """Find an element by text, checking @text, @content-desc, and @tooltip-text.

        Flutter renders its own widgets and may expose text content via any
        of these attributes depending on the widget type and semantics
        configuration. In release builds on Android 12+ (API 31), IconButton
        tooltips appear as @tooltip-text rather than @content-desc.
        """
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        if partial:
            xpath = (
                f"//*[contains(@text, '{text}') or "
                f"contains(@content-desc, '{text}') or "
                f"contains(@tooltip-text, '{text}')]"
            )
        else:
            xpath = (
                f"//*[@text='{text}' or "
                f"@content-desc='{text}' or "
                f"@tooltip-text='{text}']"
            )

        try:
            return WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((By.XPATH, xpath))
            )
        except Exception:
            print(f"=== _find FAILED: text='{text}' partial={partial} timeout={timeout} ===")
            try:
                source = self.driver.page_source
                # Truncate to avoid flooding logs
                print(source[:15000] if source else "EMPTY PAGE SOURCE")
            except Exception as e:
                print(f"Failed to get page source: {e}")
            print("=== END PAGE SOURCE ===")
            raise

    def _scroll_down(self, times=1):
        """Scroll down on the current screen."""
        import time as _time
        screen_size = self.driver.get_window_size()
        center_x = int(screen_size['width'] * 0.5)
        start_y = int(screen_size['height'] * 0.7)
        end_y = int(screen_size['height'] * 0.3)
        for _ in range(times):
            self.driver.swipe(center_x, start_y, center_x, end_y, 500)
            _time.sleep(0.5)

    def navigate_to_connect(self):
        """Navigate to the Connect screen by tapping the FAB or QR icon."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        try:
            btn = WebDriverWait(self.driver, 5).until(
                EC.element_to_be_clickable((
                    By.XPATH,
                    "//*[("
                    "@tooltip-text='Connect to peer' or "
                    "@content-desc='Connect to peer' or "
                    "((@content-desc='Connect' or @text='Connect') "
                    "and not(contains(@content-desc, 'Connected')) "
                    "and not(contains(@content-desc, 'QR')))"
                    ") and @clickable='true']"
                ))
            )
            btn.click()
        except Exception:
            # Last resort: click "Connect via QR code"
            self._find("Connect via QR code", timeout=5).click()

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
        """Get the pairing code from the Connect screen (large 6-char display)."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        xpath = (
            "//*["
            "(string-length(@text) = 6 and translate(@text, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = @text)"
            " or "
            "(string-length(@content-desc) = 6 and translate(@content-desc, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') = @content-desc)"
            "]"
        )
        el = WebDriverWait(self.driver, 60).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        )
        return (el.text or el.get_attribute("content-desc") or "").strip()

    def enter_peer_code(self, code: str):
        """Enter a peer's pairing code on the Connect screen and submit."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time

        screen_size = self.driver.get_window_size()
        start_y = int(screen_size['height'] * 0.8)
        end_y = int(screen_size['height'] * 0.2)
        center_x = int(screen_size['width'] * 0.5)

        for attempt in range(3):
            try:
                input_field = WebDriverWait(self.driver, 5).until(
                    EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
                )
                break
            except Exception:
                self.driver.swipe(center_x, start_y, center_x, end_y, 500)
                time.sleep(1)
        else:
            input_field = WebDriverWait(self.driver, 10).until(
                EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
            )

        input_field.click()
        self.driver.execute_script('mobile: type', {'text': code})

        connect_btn = WebDriverWait(self.driver, 5).until(
            EC.element_to_be_clickable((
                By.XPATH,
                "//*[(@text='Connect' or @content-desc='Connect') and @clickable='true']"
            ))
        )
        connect_btn.click()

    def go_back_to_home(self):
        """Navigate back to the home screen."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            self.driver.find_element(
                "xpath",
                "//*[@package='com.zajel.zajel' and "
                "contains(@content-desc, 'Connected Peers')]"
            )
            return
        except (NoSuchElementException, Exception):
            pass
        self.driver.back()

    def open_chat_with_peer(self, peer_name: str = None):
        """Tap on a connected peer to open the chat screen."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        if peer_name:
            xpath = (
                f"//*[contains(@content-desc, '{peer_name}') and "
                f"contains(@content-desc, 'Connected')]"
            )
        else:
            xpath = (
                "//*[contains(@content-desc, 'Peer') and "
                "contains(@content-desc, 'Connected') and "
                "not(contains(@content-desc, 'Connected Peers'))]"
            )
        WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, xpath))
        ).click()

    def send_message(self, text: str):
        """Type and send a message in the chat screen."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.click()
        self.driver.execute_script('mobile: type', {'text': text})

        send_btn = WebDriverWait(self.driver, 5).until(
            EC.element_to_be_clickable((
                By.XPATH,
                "//*[contains(@content-desc, 'Send message') or "
                "contains(@content-desc, 'Send')]"
            ))
        )
        send_btn.click()

    def has_message(self, text: str) -> bool:
        """Check if a message with the given text is visible."""
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
                "//*[contains(@content-desc, 'Connected') and "
                "not(contains(@content-desc, 'Connected Peers'))]"
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

    # -- Call-related helpers --

    def start_voice_call(self):
        """In chat screen, tap the 'Voice call' tooltip button."""
        self._find("Voice call", timeout=10).click()

    def start_video_call(self):
        """In chat screen, tap the 'Video call' tooltip button."""
        self._find("Video call", timeout=10).click()

    def get_call_status(self) -> str:
        """Return visible call status text."""
        for status_text in ['Calling...', 'Connecting...', 'Call ended']:
            try:
                self._find(status_text, timeout=2)
                return status_text
            except Exception:
                pass
        try:
            self._find('00:', timeout=2)
            return 'connected'
        except Exception:
            return 'unknown'

    def tap_call_button(self, label: str):
        """Tap a call control button by its label text."""
        self._find(label, timeout=10, partial=False).click()

    def accept_incoming_call(self, with_video: bool = False):
        """Accept an incoming call."""
        if with_video:
            self._find("Video", timeout=15, partial=False).click()
        else:
            try:
                self._find("Accept", timeout=5, partial=False).click()
            except Exception:
                self._find("Audio", timeout=5, partial=False).click()

    def reject_incoming_call(self):
        """Tap 'Decline' on incoming call dialog."""
        self._find("Decline", timeout=15, partial=False).click()

    def has_incoming_call_dialog(self, timeout: int = 15) -> bool:
        """Check if an incoming call dialog is visible."""
        import time as _time
        deadline = _time.time() + timeout
        while _time.time() < deadline:
            try:
                self._find("Incoming", timeout=2)
                return True
            except Exception:
                pass
            try:
                self._find("Decline", timeout=1, partial=False)
                return True
            except Exception:
                pass
            _time.sleep(1)
        return False

    def end_call(self):
        """Tap 'End' button to hang up."""
        self._find("End", timeout=10, partial=False).click()

    def wait_for_call_connected(self, timeout: int = 30) -> bool:
        """Wait until call shows a duration timer ('00:'), indicating connected."""
        import time as _time
        deadline = _time.time() + timeout
        while _time.time() < deadline:
            try:
                self._find('00:', timeout=2)
                return True
            except Exception:
                _time.sleep(1)
        return False

    # -- Settings helpers --

    def navigate_to_settings(self):
        """Tap 'Settings' tooltip button from home screen app bar."""
        self._find("Settings", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def change_display_name(self, name: str):
        """In settings, tap display name row, clear field, type new name, save."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        self._find("Tap to change username", timeout=10).click()
        import time as _time
        _time.sleep(1)

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        # Flutter TextFields may not respond to .clear() properly.
        # Select all text first, then type to replace it.
        input_field.click()
        _time.sleep(0.3)
        input_field.clear()
        _time.sleep(0.3)
        self.driver.execute_script('mobile: type', {'text': name})
        _time.sleep(0.5)

        self._find("Save", timeout=10, partial=False).click()
        _time.sleep(1)

    def tap_settings_option(self, text: str):
        """Tap a settings row by its title text."""
        self._find(text, timeout=10).click()
        import time as _time
        _time.sleep(1)

    def confirm_dialog(self, button_text: str):
        """Tap a button in an alert dialog."""
        self._find(button_text, timeout=10, partial=False).click()
        import time as _time
        _time.sleep(1)

    def dismiss_dialog(self):
        """Tap 'Cancel' in an alert dialog."""
        self._find("Cancel", timeout=10, partial=False).click()
        import time as _time
        _time.sleep(1)

    # -- Peer management helpers --

    def open_peer_menu(self):
        """Tap the overflow menu (more_vert) on the first visible peer card."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        menu_btn = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Show menu') or "
                "contains(@content-desc, 'More options')]"
            ))
        )
        menu_btn.click()
        import time as _time
        _time.sleep(1)

    def tap_menu_option(self, option: str):
        """Tap a popup menu item by text."""
        self._find(option, timeout=10).click()
        import time as _time
        _time.sleep(1)

    # -- Notification settings helpers --

    def navigate_to_notification_settings(self):
        """Navigate to Settings > Notifications."""
        self.navigate_to_settings()
        self.tap_settings_option("Notifications")

    def toggle_dnd(self):
        """Toggle the Do Not Disturb switch in notification settings."""
        self._find("Do Not Disturb", timeout=10).click()

    def toggle_sound(self):
        """Toggle the Sound switch in notification settings."""
        self._find("Sound", timeout=10).click()

    def mute_peer(self, peer_name: str):
        """Mute a peer from the notification settings muted peers list."""
        self._find(peer_name, timeout=10).click()

    # -- Media settings helpers --

    def navigate_to_media_settings(self):
        """Navigate to Settings > Audio & Video.

        On a Pixel 6 (1080x2400), "Audio & Video" is the 4th section
        (~494dp from top) and fits within the ~859dp visible area without
        scrolling.  If it's not immediately visible (e.g. keyboard pushed
        the view), try one small scroll before failing.
        """
        self.navigate_to_settings()
        try:
            self.tap_settings_option("Audio & Video")
        except Exception:
            self._scroll_down()
            self.tap_settings_option("Audio & Video")

    # -- Emoji helpers --

    def open_emoji_picker(self):
        """Tap the emoji button in the chat input bar."""
        self._find("Emoji", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def close_emoji_picker(self):
        """Tap the keyboard button to close the emoji picker."""
        self._find("Keyboard", timeout=10).click()
        import time as _time
        _time.sleep(1)

    # -- Contact helpers --

    def navigate_to_contacts(self):
        """Tap the contacts button from home screen."""
        self._find("Contacts", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def set_peer_alias(self, alias: str):
        """In contact detail, set a custom alias."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        self._find("Edit alias", timeout=10).click()
        import time as _time
        _time.sleep(1)

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.clear()
        self.driver.execute_script('mobile: type', {'text': alias})

        self._find("Save", timeout=5, partial=False).click()
        _time.sleep(1)

    def search_contacts(self, query: str):
        """Type in the contacts search bar."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        search_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        search_field.click()
        self.driver.execute_script('mobile: type', {'text': query})

    def open_contact_detail(self, name: str):
        """Tap a contact in the contacts list to open detail."""
        self._find(name, timeout=10).click()
        import time as _time
        _time.sleep(1)

    # -- Offline peer helpers --

    def is_peer_offline(self, peer_name: str = None) -> bool:
        """Check if a peer shows as 'Offline' on the home screen."""
        from selenium.common.exceptions import NoSuchElementException
        try:
            if peer_name:
                self.driver.find_element(
                    "xpath",
                    f"//*[contains(@content-desc, '{peer_name}') and "
                    f"contains(@content-desc, 'Last seen')]"
                )
            else:
                self.driver.find_element(
                    "xpath",
                    "//*[contains(@content-desc, 'Last seen')]"
                )
            return True
        except (NoSuchElementException, Exception):
            return False

    def get_last_seen(self, peer_name: str = None) -> str:
        """Get the 'Last seen' text for an offline peer."""
        try:
            if peer_name:
                el = self.driver.find_element(
                    "xpath",
                    f"//*[contains(@content-desc, '{peer_name}') and "
                    f"contains(@content-desc, 'Last seen')]"
                )
            else:
                el = self.driver.find_element(
                    "xpath",
                    "//*[contains(@content-desc, 'Last seen')]"
                )
            text = el.get_attribute("content-desc") or el.text or ""
            for line in text.split('\n'):
                if 'Last seen' in line:
                    return line.strip()
            return text
        except Exception:
            return ""

    # -- Blocked list helpers --

    def navigate_to_blocked_list(self):
        """Navigate to Settings > Blocked Users."""
        self.navigate_to_settings()
        self.tap_settings_option("Blocked Users")

    def remove_peer_permanently(self, peer_name: str):
        """Remove a peer permanently from blocked list via popup menu."""
        self._find(peer_name, timeout=10)
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        menu = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Show menu') or "
                "contains(@content-desc, 'More options') or "
                "contains(@content-desc, 'Popup')]"
            ))
        )
        menu.click()
        _time.sleep(1)

        self._find("Remove Permanently", timeout=10).click()
        _time.sleep(1)

        self._find("Remove", timeout=10, partial=False).click()
        _time.sleep(1)

    # -- File transfer helpers --

    def tap_attach_file(self):
        """Tap the attach file button in chat input bar."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        attach_btn = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((
                By.XPATH,
                "//*[contains(@content-desc, 'Attach') or "
                "contains(@content-desc, 'attach')]"
            ))
        )
        attach_btn.click()

    def select_file_in_picker(self, filename: str, timeout: int = 10) -> bool:
        """Select a file in the Android Documents UI file picker."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        try:
            file_elem = WebDriverWait(self.driver, timeout).until(
                EC.presence_of_element_located((
                    By.XPATH,
                    f"//*[contains(@text, '{filename}')]"
                ))
            )
            file_elem.click()
            _time.sleep(2)
            return True
        except Exception:
            try:
                roots_btn = self.driver.find_element(
                    By.XPATH,
                    "//*[@content-desc='Show roots']"
                )
                roots_btn.click()
                _time.sleep(1)

                downloads = self.driver.find_element(
                    By.XPATH,
                    "//*[contains(@text, 'Downloads')]"
                )
                downloads.click()
                _time.sleep(2)

                file_elem = WebDriverWait(self.driver, timeout).until(
                    EC.presence_of_element_located((
                        By.XPATH,
                        f"//*[contains(@text, '{filename}')]"
                    ))
                )
                file_elem.click()
                _time.sleep(2)
                return True
            except Exception:
                return False

    # -- Channel helpers --

    def navigate_to_channels(self):
        """Tap 'Channels' tooltip button in home app bar → channels list."""
        self._find("Channels", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def navigate_to_groups(self):
        """Tap 'Groups' tooltip button in home app bar → groups list."""
        self._find("Groups", timeout=10).click()
        import time as _time
        _time.sleep(1)

    def create_channel(self, name, description=""):
        """Create a channel via FAB → dialog → fill fields → tap Create."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        # Tap FAB (tooltip: "Create Channel")
        self._find("Create Channel", timeout=10).click()
        _time.sleep(1)

        # Fill channel name (first EditText in dialog)
        fields = self.driver.find_elements(By.XPATH, "//android.widget.EditText")
        if fields:
            fields[0].click()
            self.driver.execute_script('mobile: type', {'text': name})

        # Fill description if provided (second EditText)
        if description and len(fields) > 1:
            fields[1].click()
            self.driver.execute_script('mobile: type', {'text': description})

        # Tap Create button
        self._find("Create", timeout=5, partial=False).click()
        _time.sleep(2)

    def open_channel(self, name):
        """Tap a channel in the list by name."""
        self._find(name, timeout=10).click()
        import time as _time
        _time.sleep(1)

    def get_channel_invite_link(self):
        """Open share dialog → extract SelectableText link → dismiss."""
        import time as _time

        # Tap 'Share channel' button
        self._find("Share channel", timeout=10).click()
        _time.sleep(2)

        # The share dialog shows the link as selectable text starting with zajel://
        try:
            link_el = self._find("zajel://", timeout=10)
            link = link_el.text or link_el.get_attribute("content-desc") or ""
            # Sometimes the full text is in content-desc
            if not link.startswith("zajel://"):
                link = link_el.get_attribute("content-desc") or link_el.text or ""
        except Exception:
            link = ""

        # Dismiss the dialog
        try:
            self._find("Done", timeout=5).click()
        except Exception:
            self.driver.back()
        _time.sleep(1)

        return link

    def publish_channel_message(self, text):
        """Type in 'Publish to channel...' field → tap send button."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.click()
        input_field.clear()
        _time.sleep(0.5)
        self.driver.execute_script('mobile: type', {'text': text})
        _time.sleep(0.5)

        # Tap the send button — use tooltip-text to avoid matching
        # "Publish something!" empty state text
        try:
            send_btn = self.driver.find_element(
                By.XPATH,
                '//*[@tooltip-text="Publish" and @clickable="true"]'
            )
            send_btn.click()
        except Exception:
            # Fallback: find by content-desc
            self._find("Publish", timeout=5).click()
        _time.sleep(2)

    def has_channel_message(self, text):
        """Check if a channel message is visible."""
        try:
            self._find(text, timeout=5)
            return True
        except Exception:
            return False

    # -- Group helpers --

    def create_group(self, name):
        """Create a group via FAB → dialog → fill name → tap Create."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By
        import time as _time

        # Tap FAB (tooltip: "Create Group")
        self._find("Create Group", timeout=10).click()
        _time.sleep(1)

        # Fill group name
        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.click()
        self.driver.execute_script('mobile: type', {'text': name})

        # Tap Create button
        self._find("Create", timeout=5, partial=False).click()
        _time.sleep(2)

    def open_group(self, name):
        """Tap a group in the list by name."""
        self._find(name, timeout=10).click()
        import time as _time
        _time.sleep(1)

    def add_group_member(self, peer_name):
        """Tap 'Add member' → select peer by name in the dialog.

        peer_name can be a display name or partial match. The app shows
        peers as "Peer XXXX" (pairing code) if no display name is set,
        or by their display name.
        """
        import time as _time

        self._find("Add member", timeout=10).click()
        _time.sleep(1)

        # Try exact match first, then partial match with "Peer" prefix
        try:
            self._find(peer_name, timeout=5).click()
        except Exception:
            # App may show "Peer <code>" instead of display name
            self._find("Peer", timeout=5, partial=True).click()
        _time.sleep(2)

    def send_group_message(self, text):
        """Type in 'Type a message...' field → tap 'Send' button."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.common.by import By

        input_field = WebDriverWait(self.driver, 10).until(
            EC.presence_of_element_located((By.XPATH, "//android.widget.EditText"))
        )
        input_field.click()
        input_field.clear()
        self.driver.execute_script('mobile: type', {'text': text})

        self._find("Send", timeout=5).click()
        import time as _time
        _time.sleep(2)

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
        import time as _time
        _time.sleep(1)

    # -- Screenshot helper --

    def take_screenshot(self, name):
        """Save screenshot to E2E_ARTIFACTS_DIR/{name}.png."""
        import os
        artifacts_dir = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
        os.makedirs(artifacts_dir, exist_ok=True)
        path = os.path.join(artifacts_dir, f"{name}.png")
        self.driver.save_screenshot(path)
        print(f"Screenshot saved: {path}")
