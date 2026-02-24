"""
Platform detection and helper factory for unified E2E tests.

Detects the target platform from the ZAJEL_TEST_PLATFORM environment variable
(default: "android") and provides factory functions to create the appropriate
platform helper and load platform-specific configuration.

Supported platforms:
- android: Appium + UiAutomator2 (emulator or real device)
- linux: Shelf HTTP client (headless CI)
- linux-a11y: Shelf HTTP + pyautogui real cursor (desktop with display)
- windows: pywinauto + UIA (desktop)
- macos: atomacos + pyautogui real cursor (desktop)
- ios: Appium + XCUITest (simulator)
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
    elif platform in ("linux", "linux-a11y"):
        from . import linux_config
        return linux_config
    elif platform == "windows":
        from . import windows_config
        return windows_config
    elif platform == "macos":
        from . import macos_config
        return macos_config
    elif platform == "ios":
        from . import ios_config
        return ios_config
    else:
        raise ValueError(f"Unknown platform: {platform}")


def create_helper(platform: str = None, **kwargs):
    """Create a platform-specific helper instance.

    Args:
        platform: Override for ZAJEL_TEST_PLATFORM (default: auto-detect).
        **kwargs: Platform-specific arguments:
            - android: driver (Appium Remote driver)
            - linux: app_path, data_dir, name (optional)
            - linux-a11y: app_path, data_dir, name (optional)
            - windows: app_path
            - macos: app_path, data_dir (optional), name (optional)
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
    elif platform == "linux-a11y":
        from .linux_a11y_helper import LinuxDesktopHelper
        return LinuxDesktopHelper(
            kwargs["app_path"],
            kwargs["data_dir"],
            kwargs.get("name", "zajel"),
        )
    elif platform == "windows":
        from .windows_helper import WindowsAppHelper
        return WindowsAppHelper(kwargs["app_path"])
    elif platform == "macos":
        from .macos_helper import MacosAppHelper
        return MacosAppHelper(
            kwargs["app_path"],
            kwargs.get("data_dir"),
            kwargs.get("name", "zajel"),
        )
    elif platform == "ios":
        from .ios_helper import IosAppHelper
        return IosAppHelper(kwargs["driver"])
    else:
        raise ValueError(f"Unknown platform: {platform}")
