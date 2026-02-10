"""Configuration for Linux desktop E2E tests."""

import os

# Path to the built Flutter Linux app
APP_PATH = os.environ.get(
    "ZAJEL_APP_PATH",
    os.path.expanduser("~/zajel/packages/app/build/linux/x64/release/bundle/zajel")
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
