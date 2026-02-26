"""
E2E Test Configuration -- Platform-dispatched.

Re-exports all config values from the platform-specific config module
based on ZAJEL_TEST_PLATFORM environment variable.

For backward compatibility, Android config values are still importable
directly (e.g., `from config import SIGNALING_URL`).
"""

from platforms import get_platform

_platform = get_platform()

if _platform == "android":
    from platforms.android_config import *  # noqa: F401,F403
elif _platform in ("linux", "linux-a11y"):
    from platforms.linux_config import *  # noqa: F401,F403
elif _platform == "windows":
    from platforms.windows_config import *  # noqa: F401,F403
elif _platform == "macos":
    from platforms.macos_config import *  # noqa: F401,F403
elif _platform == "ios":
    from platforms.ios_config import (  # noqa: F401
        APP_PATH, SIMULATOR_UDID, SIGNALING_URL,
        APP_LAUNCH_TIMEOUT, ELEMENT_WAIT_TIMEOUT, CONNECTION_TIMEOUT,
        P2P_CONNECTION_TIMEOUT,
    )
else:
    raise ValueError(f"Unknown platform: {_platform}")
