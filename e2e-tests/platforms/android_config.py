"""
E2E Test Configuration

Environment variables:
- APPIUM_SERVER_COUNT: Number of Appium servers available
- APK_PATH: Path to the APK on Appium servers (default: /tmp/zajel-test.apk)
- SIGNALING_URL: WebSocket URL for the signaling server (headless client tests)
"""

import os

__all__ = [
    "APPIUM_PORT", "SERVER_COUNT", "APK_PATH", "SIGNALING_URL",
    "APP_LAUNCH_TIMEOUT", "ELEMENT_WAIT_TIMEOUT", "CONNECTION_TIMEOUT",
    "P2P_CONNECTION_TIMEOUT", "CALL_CONNECT_TIMEOUT", "CALL_RING_TIMEOUT",
    "ADB_PATH", "get_server_url", "get_all_servers",
]

# Appium configuration
APPIUM_PORT = 4723
SERVER_COUNT = int(os.environ.get("APPIUM_SERVER_COUNT", "2"))
APK_PATH = os.environ.get("APK_PATH", "/tmp/zajel-test.apk")

# Signaling server for headless client tests.
# If empty, the headless_bob fixture discovers servers from BOOTSTRAP_URL.
SIGNALING_URL = os.environ.get("SIGNALING_URL", "")

# Timeouts (in seconds)
APP_LAUNCH_TIMEOUT = 60
ELEMENT_WAIT_TIMEOUT = 10
CONNECTION_TIMEOUT = 30
P2P_CONNECTION_TIMEOUT = 30
CALL_CONNECT_TIMEOUT = 30
CALL_RING_TIMEOUT = 30

# ADB path — check ANDROID_HOME (CI) before falling back to local dev path
def _find_adb() -> str:
    explicit = os.environ.get("ADB_PATH")
    if explicit:
        return explicit
    android_home = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if android_home:
        return os.path.join(android_home, "platform-tools", "adb")
    return os.path.expanduser("~/Android/Sdk/platform-tools/adb")


ADB_PATH = _find_adb()


def get_server_url(index: int) -> str:
    """Get Appium server URL for given index (0-based).

    When using SSH tunnels, servers are on localhost with incrementing ports.
    Note: Appium 2.x+ uses base path '/' instead of '/wd/hub'
    """
    if index >= SERVER_COUNT:
        raise ValueError(f"Server index {index} exceeds available servers ({SERVER_COUNT})")
    port = APPIUM_PORT + index
    return f"http://localhost:{port}"


def get_all_servers() -> list[str]:
    """Get all available Appium server URLs."""
    return [get_server_url(i) for i in range(SERVER_COUNT)]
