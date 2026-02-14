"""
Pytest fixtures for unified E2E tests.

Supports multiple platforms via ZAJEL_TEST_PLATFORM env var:
- android (default): Appium + UiAutomator2
- linux: dogtail + AT-SPI
- windows: pywinauto + UIA

Provides fixtures for:
- Single device (alice, bob)
- Device pairs for P2P testing
- All available devices
- Headless client (HeadlessBob) for cross-platform testing
- Platform-aware app_helper factory
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import threading
import pytest

from platforms import get_platform, get_config, create_helper

# ── Platform detection ───────────────────────────────────────────

PLATFORM = get_platform()

# ── Platform-specific imports (conditional) ──────────────────────

# Android
HAS_APPIUM = False
SERVER_COUNT = 0
APP_LAUNCH_TIMEOUT = 60

if PLATFORM == "android":
    try:
        from appium import webdriver
        from appium.options.android import UiAutomator2Options
        config = get_config()
        from platforms.android_config import (
            get_server_url, APK_PATH, SERVER_COUNT, APP_LAUNCH_TIMEOUT, ADB_PATH,
            SIGNALING_URL,
        )
        HAS_APPIUM = True
    except ImportError:
        HAS_APPIUM = False
        SERVER_COUNT = 0
        APP_LAUNCH_TIMEOUT = 60
        SIGNALING_URL = os.environ.get("SIGNALING_URL", "")
elif PLATFORM == "linux":
    from platforms.linux_config import (
        APP_PATH, DATA_DIR_1, DATA_DIR_2, SIGNALING_URL,
        APP_LAUNCH_TIMEOUT,
    )
elif PLATFORM == "windows":
    from platforms.windows_config import (
        APP_PATH, SIGNALING_URL, APP_LAUNCH_TIMEOUT,
    )
elif PLATFORM == "ios":
    from platforms.ios_config import (
        APP_PATH, SIGNALING_URL, APP_LAUNCH_TIMEOUT, SIMULATOR_UDID,
    )
else:
    SIGNALING_URL = os.environ.get("SIGNALING_URL", "")

logger = logging.getLogger(__name__)

ARTIFACTS_DIR = os.environ.get("E2E_ARTIFACTS_DIR", "/tmp/e2e-artifacts")
PACKAGE_NAME = "com.zajel.zajel"

# Store active drivers for failure diagnostics (Android only)
_active_drivers: dict = {}


# ── Hooks (Android screenshot on failure) ────────────────────────

@pytest.hookimpl(tryfirst=True, hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Capture screenshot and page source on test failure (Android only)."""
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed and PLATFORM == "android":
        os.makedirs(ARTIFACTS_DIR, exist_ok=True)
        safe_name = item.nodeid.replace("/", "_").replace("::", "__")
        for name, driver in _active_drivers.items():
            try:
                screenshot_path = os.path.join(
                    ARTIFACTS_DIR, f"fail_{safe_name}_{name}.png"
                )
                driver.save_screenshot(screenshot_path)
                print(f"Screenshot saved: {screenshot_path}")
            except Exception as e:
                print(f"Failed to save screenshot for {name}: {e}")
            try:
                source_path = os.path.join(
                    ARTIFACTS_DIR, f"fail_{safe_name}_{name}_source.xml"
                )
                source = driver.page_source
                if source:
                    with open(source_path, "w") as f:
                        f.write(source)
                    print(f"Page source saved: {source_path}")
            except Exception as e:
                print(f"Failed to save page source for {name}: {e}")


# ── Android driver helpers ───────────────────────────────────────

def _require_appium():
    """Skip test if Appium is not installed (Android platform only)."""
    if PLATFORM == "android" and not HAS_APPIUM:
        pytest.skip("Appium not installed -- skipping emulator tests")


def create_driver(server_index: int, device_name: str = "emulator"):
    """Create an Appium driver for the server at given index (Android only)."""
    emulator_port = 5554 + (server_index * 2)
    udid = f"emulator-{emulator_port}"
    try:
        subprocess.run(
            [ADB_PATH, "-s", udid, "shell", "pm", "clear", PACKAGE_NAME],
            capture_output=True, timeout=15
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError) as e:
        print(f"Warning: Failed to clear app data: {e}")

    for perm in [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_EXTERNAL_STORAGE",
        "android.permission.WRITE_EXTERNAL_STORAGE",
        "android.permission.POST_NOTIFICATIONS",
    ]:
        try:
            subprocess.run(
                [ADB_PATH, "-s", udid, "shell", "pm", "grant", PACKAGE_NAME, perm],
                capture_output=True, timeout=10
            )
        except (subprocess.CalledProcessError, FileNotFoundError, OSError):
            pass

    options = UiAutomator2Options()
    options.app = APK_PATH
    options.device_name = f"{device_name}-{server_index}"
    options.automation_name = "UiAutomator2"
    options.new_command_timeout = 300
    options.udid = udid
    options.no_reset = True
    options.full_reset = False
    options.auto_grant_permissions = True
    options.set_capability("appWaitDuration", 120000)
    options.set_capability("uiautomator2ServerLaunchTimeout", 180000)
    options.set_capability("uiautomator2ServerInstallTimeout", 180000)
    options.set_capability("adbExecTimeout", 180000)
    options.set_capability("androidInstallTimeout", 180000)
    options.set_capability("ignoreHiddenApiPolicyError", True)
    options.set_capability("skipUnlock", True)
    options.set_capability("disableWindowAnimation", True)
    options.set_capability("forceAppLaunch", True)

    driver = webdriver.Remote(get_server_url(server_index), options=options)
    driver.implicitly_wait(5)
    return driver


# ── Platform-dispatched fixtures ─────────────────────────────────

@pytest.fixture(scope="function")
def alice():
    """First device/app instance (Alice).

    Returns:
        - Android: Appium Remote driver
        - Linux: LinuxAppHelper instance (launched and ready)
        - Windows: WindowsAppHelper instance (launched and ready)
    """
    if PLATFORM == "android":
        _require_appium()
        driver = create_driver(0, "alice")
        _active_drivers["alice"] = driver
        yield driver
        _active_drivers.pop("alice", None)
        driver.quit()

    elif PLATFORM == "linux":
        if os.path.exists(DATA_DIR_1):
            shutil.rmtree(DATA_DIR_1)
        helper = create_helper("linux", app_path=APP_PATH, data_dir=DATA_DIR_1, name="alice")
        helper.launch()
        helper.wait_for_app_ready()
        yield helper
        helper.stop()

    elif PLATFORM == "windows":
        helper = create_helper("windows", app_path=APP_PATH)
        helper.launch()
        helper.wait_for_app_ready()
        yield helper
        helper.stop()


@pytest.fixture(scope="function")
def bob():
    """Second device/app instance (Bob).

    Returns:
        - Android: Appium Remote driver (requires >= 2 Appium servers)
        - Linux: LinuxAppHelper instance (second data dir)
        - Windows: not supported (skip)
    """
    if PLATFORM == "android":
        _require_appium()
        if SERVER_COUNT < 2:
            pytest.skip("Need at least 2 Appium servers for this test")
        driver = create_driver(1, "bob")
        _active_drivers["bob"] = driver
        yield driver
        _active_drivers.pop("bob", None)
        driver.quit()

    elif PLATFORM == "linux":
        if os.path.exists(DATA_DIR_2):
            shutil.rmtree(DATA_DIR_2)
        helper = create_helper("linux", app_path=APP_PATH, data_dir=DATA_DIR_2, name="bob")
        helper.launch()
        helper.wait_for_app_ready()
        yield helper
        helper.stop()

    elif PLATFORM == "windows":
        pytest.skip("Windows E2E does not support a second app instance (bob)")


@pytest.fixture(scope="function")
def charlie():
    """Third device (Charlie) - Android only, requires at least 3 servers."""
    if PLATFORM != "android":
        pytest.skip("charlie fixture is only available on Android")
    _require_appium()
    if SERVER_COUNT < 3:
        pytest.skip("Need at least 3 Appium servers for this test")
    driver = create_driver(2, "charlie")
    _active_drivers["charlie"] = driver
    yield driver
    _active_drivers.pop("charlie", None)
    driver.quit()


@pytest.fixture(scope="function")
def device_pair(alice, bob):
    """Two devices ready for P2P testing."""
    return {"alice": alice, "bob": bob}


@pytest.fixture(scope="function")
def all_devices():
    """All available devices (Android only)."""
    if PLATFORM != "android":
        pytest.skip("all_devices fixture is only available on Android")
    _require_appium()
    drivers = []
    for i in range(SERVER_COUNT):
        driver = create_driver(i, f"device-{i}")
        drivers.append(driver)
    yield drivers
    for driver in drivers:
        driver.quit()


@pytest.fixture
def app_helper(request):
    """Factory fixture for creating platform helpers.

    Usage:
        - Android: helper = app_helper(driver)
        - Linux/Windows: helper = app_helper(alice)  (alice is already a helper)

    On Linux/Windows, this is a pass-through since the alice/bob fixtures
    already return helper instances.
    """
    if PLATFORM == "android":
        _require_appium()
        from platforms.android_helper import AppHelper

        def _create_helper(driver):
            return AppHelper(driver)

        return _create_helper
    else:
        # On desktop platforms, alice/bob are already helpers
        def _passthrough(helper):
            return helper

        return _passthrough


# ── Headless Client Fixtures ─────────────────────────────────────

class HeadlessBob:
    """Synchronous wrapper around ZajelHeadlessClient for pytest.

    Runs the async event loop in a background thread so that synchronous
    test code can call connect(), send_text(), etc. directly.

    This is the single canonical definition -- previously duplicated in
    e2e-tests/conftest.py, e2e-tests-linux/conftest.py, and
    e2e-tests-windows/conftest.py.
    """

    def __init__(self, signaling_url: str, **kwargs):
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()

        from zajel.client import ZajelHeadlessClient
        self._client = ZajelHeadlessClient(signaling_url=signaling_url, **kwargs)
        self.pairing_code = None
        self._connected_peer = None

    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    @property
    def connected_peer(self):
        """Return the connected peer, checking auto-accept peers if needed."""
        if self._connected_peer is not None:
            return self._connected_peer
        # Auto-accept may have connected a peer without explicit pair_with()
        peers = self._client.get_connected_peers()
        if peers:
            return next(iter(peers.values()))
        return None

    @connected_peer.setter
    def connected_peer(self, value):
        self._connected_peer = value

    def _run(self, coro, timeout=120):
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def connect(self) -> str:
        self.pairing_code = self._run(self._client.connect())
        return self.pairing_code

    def pair_with(self, code: str):
        self._connected_peer = self._run(self._client.pair_with(code))
        return self._connected_peer

    def pair_with_async(self, code: str):
        """Start pairing in background, returns a Future."""
        future = asyncio.run_coroutine_threadsafe(
            self._client.pair_with(code), self._loop
        )
        return future

    def wait_for_pair(self, timeout=60):
        self._connected_peer = self._run(
            self._client.wait_for_pair(timeout=timeout), timeout=timeout + 10
        )
        return self._connected_peer

    def send_text(self, peer_id: str, text: str):
        self._run(self._client.send_text(peer_id, text))

    def receive_message(self, timeout=30):
        return self._run(
            self._client.receive_message(timeout=timeout), timeout=timeout + 10
        )

    def send_file(self, peer_id: str, file_path: str):
        return self._run(self._client.send_file(peer_id, file_path))

    def receive_file(self, timeout=60):
        return self._run(
            self._client.receive_file(timeout=timeout), timeout=timeout + 10
        )

    # ── Channel methods ──────────────────────────────────────

    def subscribe_channel(self, invite_link: str):
        return self._run(self._client.subscribe_channel(invite_link))

    def get_subscribed_channels(self):
        return self._run(self._client.get_subscribed_channels())

    def get_channel(self, channel_id: str):
        return self._run(self._client.get_channel(channel_id))

    def unsubscribe_channel(self, channel_id: str):
        self._run(self._client.unsubscribe_channel(channel_id))

    def receive_channel_chunk(self, channel_id: str, chunk_data: dict):
        return self._run(
            self._client.receive_channel_chunk(channel_id, chunk_data)
        )

    def receive_channel_content(self, timeout=30):
        return self._run(
            self._client.receive_channel_content(timeout=timeout),
            timeout=timeout + 10,
        )

    # ── Group methods ────────────────────────────────────────

    def create_group(self, name: str):
        return self._run(self._client.create_group(name))

    def get_groups(self):
        return self._run(self._client.get_groups())

    def get_group(self, group_id: str):
        return self._run(self._client.get_group(group_id))

    def add_group_member(self, group_id, member, sender_key):
        return self._run(
            self._client.add_group_member(group_id, member, sender_key)
        )

    def send_group_message(self, group_id: str, content: str):
        return self._run(
            self._client.send_group_message(group_id, content)
        )

    def receive_group_message(self, group_id, author_device_id, encrypted_bytes):
        return self._run(
            self._client.receive_group_message(
                group_id, author_device_id, encrypted_bytes
            )
        )

    def wait_for_group_message(self, timeout=30):
        return self._run(
            self._client.wait_for_group_message(timeout=timeout),
            timeout=timeout + 10,
        )

    def wait_for_group_invitation(self, timeout=30):
        return self._run(
            self._client.wait_for_group_invitation(timeout=timeout),
            timeout=timeout + 10,
        )

    def get_group_messages(self, group_id: str, limit=None):
        return self._run(
            self._client.get_group_messages(group_id, limit=limit)
        )

    def leave_group(self, group_id: str):
        self._run(self._client.leave_group(group_id))

    def disconnect(self):
        try:
            self._run(self._client.disconnect(), timeout=10)
        except Exception as e:
            logger.warning("Disconnect failed: %s", e)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)


@pytest.fixture(scope="function")
def headless_bob():
    """Headless client acting as Bob for cross-platform tests.

    Connects to the signaling server, auto-accepts pair requests.
    Tests use headless_bob.pairing_code to pair Alice (app) with Bob.
    """
    if not SIGNALING_URL:
        pytest.skip("SIGNALING_URL not set -- headless tests require a signaling server")

    turn_url = os.environ.get("TURN_URL", "")
    turn_user = os.environ.get("TURN_USER", "")
    turn_pass = os.environ.get("TURN_PASS", "")

    ice_servers = None
    if turn_url:
        # NOTE: This STUN URL is also defined in:
        #   - packages/headless-client/zajel/webrtc.py (DEFAULT_ICE_SERVERS)
        #   - packages/app/lib/core/constants.dart (defaultIceServers)
        # Keep all three in sync when changing.
        ice_servers = [
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": turn_url, "username": turn_user, "credential": turn_pass},
        ]

    bob = HeadlessBob(
        signaling_url=SIGNALING_URL,
        name="HeadlessBob",
        auto_accept_pairs=True,
        log_level="DEBUG",
        ice_servers=ice_servers,
    )
    bob.connect()
    yield bob
    bob.disconnect()
