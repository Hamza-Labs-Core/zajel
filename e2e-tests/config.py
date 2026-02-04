"""
E2E Test Configuration

Environment variables:
- APPIUM_SERVER_COUNT: Number of Appium servers available
- APK_PATH: Path to the APK on Appium servers (default: /tmp/zajel-test.apk)
"""

import os

# Appium configuration
APPIUM_PORT = 4723
SERVER_COUNT = int(os.environ.get("APPIUM_SERVER_COUNT", "2"))
APK_PATH = os.environ.get("APK_PATH", "/tmp/zajel-test.apk")

# Timeouts (in seconds)
APP_LAUNCH_TIMEOUT = 60
ELEMENT_WAIT_TIMEOUT = 10
CONNECTION_TIMEOUT = 30
P2P_CONNECTION_TIMEOUT = 15
CALL_CONNECT_TIMEOUT = 30
CALL_RING_TIMEOUT = 30

# ADB path (for file transfer tests)
ADB_PATH = os.environ.get(
    "ADB_PATH",
    os.path.expanduser("~/Android/Sdk/platform-tools/adb")
)


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
