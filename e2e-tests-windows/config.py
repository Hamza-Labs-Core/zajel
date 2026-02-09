"""Configuration for Windows desktop E2E tests."""

import os

# Path to the built Flutter Windows app
APP_PATH = os.environ.get(
    "ZAJEL_APP_PATH",
    os.path.join(os.path.expanduser("~"), "zajel", "packages", "app",
                 "build", "windows", "x64", "runner", "Release", "zajel.exe")
)

# Signaling server URL for headless-paired tests
SIGNALING_URL = os.environ.get("SIGNALING_URL", "")

# Timeouts (seconds)
APP_LAUNCH_TIMEOUT = 30
ELEMENT_WAIT_TIMEOUT = 10
CONNECTION_TIMEOUT = 30
P2P_CONNECTION_TIMEOUT = 15
