#!/bin/bash
# Verify Appium E2E testing setup

set -e

echo "=========================================="
echo "Appium E2E Setup Verification"
echo "=========================================="

ERRORS=0

# Check KVM
echo -n "KVM support: "
if [ -e /dev/kvm ]; then
  echo "OK"
else
  echo "MISSING"
  ERRORS=$((ERRORS + 1))
fi

# Check Android SDK
echo -n "Android SDK: "
if [ -d "${ANDROID_SDK_ROOT:-/opt/android-sdk}/platform-tools" ]; then
  echo "OK"
else
  echo "MISSING"
  ERRORS=$((ERRORS + 1))
fi

# Check ADB
echo -n "ADB command: "
if command -v adb &> /dev/null; then
  echo "OK ($(adb version | head -1))"
else
  echo "MISSING"
  ERRORS=$((ERRORS + 1))
fi

# Check emulator
echo -n "Emulator command: "
if command -v emulator &> /dev/null; then
  echo "OK"
else
  echo "MISSING"
  ERRORS=$((ERRORS + 1))
fi

# Check Appium
echo -n "Appium: "
if command -v appium &> /dev/null; then
  echo "OK ($(appium --version))"
else
  echo "MISSING"
  ERRORS=$((ERRORS + 1))
fi

# Check UiAutomator2 driver
echo -n "UiAutomator2 driver: "
if appium driver list --installed 2>/dev/null | grep -q "uiautomator2"; then
  echo "OK"
else
  echo "MISSING"
  ERRORS=$((ERRORS + 1))
fi

# Check emulator service
echo -n "Emulator service: "
if systemctl is-active --quiet android-emulator; then
  echo "RUNNING"
else
  echo "STOPPED"
  ERRORS=$((ERRORS + 1))
fi

# Check Appium service
echo -n "Appium service: "
if systemctl is-active --quiet appium; then
  echo "RUNNING"
else
  echo "STOPPED"
  ERRORS=$((ERRORS + 1))
fi

# Check connected devices
echo ""
echo "Connected devices:"
adb devices -l

# Check Appium status
echo ""
echo -n "Appium HTTP status: "
APPIUM_PORT="${APPIUM_PORT:-4723}"
if curl -sf "http://localhost:$APPIUM_PORT/status" > /dev/null; then
  echo "OK"
  curl -s "http://localhost:$APPIUM_PORT/status" | head -c 200
  echo ""
else
  echo "FAILED"
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo "=========================================="
if [ $ERRORS -eq 0 ]; then
  echo "All checks passed!"
  exit 0
else
  echo "$ERRORS check(s) failed"
  exit 1
fi
