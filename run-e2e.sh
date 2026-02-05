#!/bin/bash
set -e

PROJ=/home/meywd/zajel
APK=$PROJ/packages/app/build/app/outputs/flutter-apk/app-release.apk

# Ensure ANDROID_HOME is set
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk}
export ANDROID_AVD_HOME=${ANDROID_AVD_HOME:-$HOME/.android/avd}
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$JAVA_HOME/bin:$PATH"

# Preflight checks
if [ ! -d "$ANDROID_HOME" ]; then
  echo "ERROR: Android SDK not found at $ANDROID_HOME"
  echo "Run the setup steps from e2e-setup-plan.md first."
  exit 1
fi

if [ ! -f "$ANDROID_HOME/emulator/emulator" ]; then
  echo "ERROR: Android emulator not found. Install it with: sdkmanager emulator"
  exit 1
fi

command -v appium >/dev/null 2>&1 || { echo "ERROR: appium not found. Install with: npm install -g appium"; exit 1; }

# Build APK if needed
if [ ! -f "$APK" ] || [ "$1" = "--build" ]; then
  echo "Building APK..."
  cd $PROJ/packages/app
  flutter build apk --release --dart-define=ENV=qa --dart-define=E2E_TEST=true
fi

# Start emulators
echo "Starting emulators..."
$ANDROID_HOME/emulator/emulator -avd test-avd-1 -port 5554 -no-snapshot -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim &
EMU1=$!
$ANDROID_HOME/emulator/emulator -avd test-avd-2 -port 5556 -no-snapshot -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim &
EMU2=$!

cleanup() { kill $APPIUM1 $APPIUM2 $EMU1 $EMU2 2>/dev/null; }
trap cleanup EXIT

# Wait for boot
for DEV in emulator-5554 emulator-5556; do
  adb -s $DEV wait-for-device
  timeout 180 adb -s $DEV shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 2; done'
  adb -s $DEV shell settings put global window_animation_scale 0
  adb -s $DEV shell settings put global transition_animation_scale 0
  adb -s $DEV shell settings put global animator_duration_scale 0
  adb -s $DEV install "$APK"
done
echo "Emulators ready"

# Start Appium
appium --address 127.0.0.1 --port 4723 --relaxed-security --default-capabilities '{"appium:udid":"emulator-5554"}' > /tmp/appium1.log 2>&1 &
APPIUM1=$!
appium --address 127.0.0.1 --port 4724 --relaxed-security --default-capabilities '{"appium:udid":"emulator-5556"}' > /tmp/appium2.log 2>&1 &
APPIUM2=$!
sleep 10

# Run tests
cd $PROJ/e2e-tests
export APK_PATH=$APK
export APPIUM_SERVER_COUNT=2
pytest tests/test_pairing.py tests/test_messaging.py tests/test_reconnection.py -v -s --timeout=300
