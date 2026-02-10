"""
Platform detection and helper factory for unified E2E tests.

Detects the target platform from the ZAJEL_TEST_PLATFORM environment variable
(default: "android") and provides factory functions to create the appropriate
platform helper and load platform-specific configuration.

Supported platforms:
- android: Appium + UiAutomator2 (emulator or real device)
- linux: dogtail + AT-SPI (desktop)
- windows: pywinauto + UIA (desktop)
"""

import os


def get_platform() -> str:
    """Return the current test platform from ZAJEL_TEST_PLATFORM env var.

    Defaults to "android" if not set.
    """
    return os.environ.get("ZAJEL_TEST_PLATFORM", "android")


def get_config():
    """Return the platform-specific config module."""
    platform = get_platform()
    if platform == "android":
        from . import android_config
        return android_config
    elif platform == "linux":
        from . import linux_config
        return linux_config
    elif platform == "windows":
        from . import windows_config
        return windows_config
    else:
        raise ValueError(f"Unknown platform: {platform}")


def create_helper(platform: str = None, **kwargs):
    """Create a platform-specific helper instance.

    Args:
        platform: Override for ZAJEL_TEST_PLATFORM (default: auto-detect).
        **kwargs: Platform-specific arguments:
            - android: driver (Appium Remote driver)
            - linux: app_path, data_dir, name (optional)
            - windows: app_path
    """
    if platform is None:
        platform = get_platform()

    if platform == "android":
        from .android_helper import AppHelper
        return AppHelper(kwargs["driver"])
    elif platform == "linux":
        from .linux_helper import LinuxAppHelper
        return LinuxAppHelper(
            kwargs["app_path"],
            kwargs["data_dir"],
            kwargs.get("name", "zajel"),
        )
    elif platform == "windows":
        from .windows_helper import WindowsAppHelper
        return WindowsAppHelper(kwargs["app_path"])
    else:
        raise ValueError(f"Unknown platform: {platform}")
