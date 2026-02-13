"""
iOS E2E Test Configuration.

Environment variables:
- IOS_APP_PATH: Path to the iOS .app bundle (built with no-codesign)
- IOS_SIMULATOR_UDID: UDID of the target iOS Simulator
- SIGNALING_URL: WebSocket URL for the signaling server
"""

import os

# App configuration
APP_PATH = os.environ.get("IOS_APP_PATH", "")
SIMULATOR_UDID = os.environ.get("IOS_SIMULATOR_UDID", "")

# Signaling server for headless client tests
SIGNALING_URL = os.environ.get("SIGNALING_URL", "")

# Timeouts (in seconds)
APP_LAUNCH_TIMEOUT = 90
ELEMENT_WAIT_TIMEOUT = 15
CONNECTION_TIMEOUT = 30
P2P_CONNECTION_TIMEOUT = 15
