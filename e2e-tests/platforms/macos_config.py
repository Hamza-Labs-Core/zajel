"""Configuration for macOS desktop E2E tests."""

import os

__all__ = [
    "APP_PATH", "DATA_DIR_1", "DATA_DIR_2", "SIGNALING_URL",
    "APP_LAUNCH_TIMEOUT", "ELEMENT_WAIT_TIMEOUT", "CONNECTION_TIMEOUT",
    "P2P_CONNECTION_TIMEOUT", "CALL_CONNECT_TIMEOUT",
]

# Path to the built Flutter macOS app bundle
APP_PATH = os.environ.get(
    "ZAJEL_APP_PATH",
    os.path.expanduser("~/zajel/packages/app/build/macos/Build/Products/Release/Zajel.app")
)

# Data directory for each app instance (to run two instances simultaneously)
DATA_DIR_1 = os.environ.get("ZAJEL_DATA_DIR_1", "/tmp/zajel-e2e-1")
DATA_DIR_2 = os.environ.get("ZAJEL_DATA_DIR_2", "/tmp/zajel-e2e-2")

# Signaling server URL for headless-paired tests
SIGNALING_URL = os.environ.get("SIGNALING_URL", "")

# Timeouts (seconds)
APP_LAUNCH_TIMEOUT = 60
ELEMENT_WAIT_TIMEOUT = 10
CONNECTION_TIMEOUT = 30
P2P_CONNECTION_TIMEOUT = 15
CALL_CONNECT_TIMEOUT = 30
