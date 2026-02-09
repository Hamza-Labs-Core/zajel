"""
Pytest fixtures for Linux desktop E2E tests.

Uses AT-SPI via dogtail for Flutter app automation.
Launches two app instances with isolated data directories for P2P testing.
"""

import os
import shutil
import pytest

from linux_helper import LinuxAppHelper
from config import APP_PATH, DATA_DIR_1, DATA_DIR_2


@pytest.fixture(scope="function")
def alice():
    """First app instance (Alice)."""
    # Clean data directory for fresh state
    if os.path.exists(DATA_DIR_1):
        shutil.rmtree(DATA_DIR_1)

    helper = LinuxAppHelper(APP_PATH, DATA_DIR_1, "alice")
    helper.launch()
    helper.wait_for_app_ready()

    yield helper

    helper.stop()


@pytest.fixture(scope="function")
def bob():
    """Second app instance (Bob)."""
    if os.path.exists(DATA_DIR_2):
        shutil.rmtree(DATA_DIR_2)

    helper = LinuxAppHelper(APP_PATH, DATA_DIR_2, "bob")
    helper.launch()
    helper.wait_for_app_ready()

    yield helper

    helper.stop()


@pytest.fixture(scope="function")
def device_pair(alice, bob):
    """Two app instances ready for P2P testing."""
    return {"alice": alice, "bob": bob}
