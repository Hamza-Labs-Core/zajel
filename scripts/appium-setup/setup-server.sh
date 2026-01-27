#!/bin/bash
# Zajel E2E Testing Server Setup Script
# Run this on a fresh Hetzner VPS (Ubuntu 22.04+ recommended)
# Requirements: At least 4 CPU cores, 8GB RAM, KVM support

set -e

# Configuration
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-/root/.android/avd}"
APPIUM_PORT="${APPIUM_PORT:-4723}"
EMULATOR_NAME="${EMULATOR_NAME:-test_device}"
SYSTEM_IMAGE="${SYSTEM_IMAGE:-system-images;android-34;google_apis;x86_64}"

echo "=========================================="
echo "Zajel E2E Testing Server Setup"
echo "=========================================="
echo "Android SDK: $ANDROID_SDK_ROOT"
echo "AVD Home: $ANDROID_AVD_HOME"
echo "Appium Port: $APPIUM_PORT"
echo "Emulator: $EMULATOR_NAME"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo)"
  exit 1
fi

# Check KVM support
echo ""
echo "[1/8] Checking KVM support..."
if [ ! -e /dev/kvm ]; then
  echo "ERROR: KVM not available. This server doesn't support hardware virtualization."
  echo "Make sure you're using a dedicated server or cloud instance with nested virtualization."
  exit 1
fi
echo "KVM available: OK"

# Install system dependencies
echo ""
echo "[2/8] Installing system dependencies..."
apt-get update
apt-get install -y \
  openjdk-17-jdk \
  unzip \
  wget \
  curl \
  git \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  bridge-utils \
  cpu-checker \
  nodejs \
  npm

# Verify Java
java -version

# Install Node.js 20 if needed
NODE_VERSION=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo "0")
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js version: $(node -v)"

# Download and install Android Command Line Tools
echo ""
echo "[3/8] Installing Android SDK..."
mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools"

if [ ! -d "$ANDROID_SDK_ROOT/cmdline-tools/latest" ]; then
  cd /tmp
  wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline-tools.zip
  unzip -q cmdline-tools.zip
  mv cmdline-tools "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  rm cmdline-tools.zip
fi

# Set up environment variables
export ANDROID_SDK_ROOT="$ANDROID_SDK_ROOT"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export PATH="$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator"

# Persist environment variables
cat > /etc/profile.d/android.sh << EOF
export ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT
export ANDROID_HOME=$ANDROID_SDK_ROOT
export ANDROID_AVD_HOME=$ANDROID_AVD_HOME
export PATH="\$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator"
EOF
chmod +x /etc/profile.d/android.sh

# Accept licenses and install SDK components
echo ""
echo "[4/8] Installing Android SDK components..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true
sdkmanager "platform-tools" "emulator"
sdkmanager "platforms;android-34"
sdkmanager "$SYSTEM_IMAGE"

# Create AVD
echo ""
echo "[5/8] Creating Android Virtual Device..."
mkdir -p "$ANDROID_AVD_HOME"

# Delete existing AVD if present
avdmanager delete avd -n "$EMULATOR_NAME" 2>/dev/null || true

# Create new AVD
echo "no" | avdmanager create avd \
  -n "$EMULATOR_NAME" \
  -k "$SYSTEM_IMAGE" \
  -d "pixel_5" \
  --force

# Configure AVD for CI (headless, more RAM, etc.)
AVD_CONFIG="$ANDROID_AVD_HOME/${EMULATOR_NAME}.avd/config.ini"
cat >> "$AVD_CONFIG" << EOF
hw.ramSize=4096
hw.cpu.ncore=2
hw.keyboard=yes
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
disk.dataPartition.size=4096M
vm.heapSize=512
EOF

echo "AVD created: $EMULATOR_NAME"

# Install Appium
echo ""
echo "[6/8] Installing Appium..."
npm install -g appium@latest
npm install -g appium-doctor

# Install Appium UiAutomator2 driver
appium driver install uiautomator2

# Verify installation
echo ""
echo "Running appium-doctor..."
appium-doctor --android || true

# Create systemd service for emulator
echo ""
echo "[7/8] Creating systemd services..."

cat > /etc/systemd/system/android-emulator.service << EOF
[Unit]
Description=Android Emulator for E2E Testing
After=network.target

[Service]
Type=simple
User=root
Environment="ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT"
Environment="ANDROID_HOME=$ANDROID_SDK_ROOT"
Environment="ANDROID_AVD_HOME=$ANDROID_AVD_HOME"
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/platform-tools"
ExecStart=$ANDROID_SDK_ROOT/emulator/emulator -avd $EMULATOR_NAME -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on -memory 4096 -partition-size 4096
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Create systemd service for Appium
cat > /etc/systemd/system/appium.service << EOF
[Unit]
Description=Appium Server for E2E Testing
After=android-emulator.service
Requires=android-emulator.service

[Service]
Type=simple
User=root
Environment="ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT"
Environment="ANDROID_HOME=$ANDROID_SDK_ROOT"
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$ANDROID_SDK_ROOT/platform-tools"
ExecStartPre=/bin/sleep 30
ExecStart=/usr/bin/appium --address 0.0.0.0 --port $APPIUM_PORT --allow-cors --relaxed-security
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Enable and start services
systemctl daemon-reload
systemctl enable android-emulator
systemctl enable appium

# Configure firewall (if ufw is active)
echo ""
echo "[8/8] Configuring firewall..."
if command -v ufw &> /dev/null && ufw status | grep -q "active"; then
  ufw allow $APPIUM_PORT/tcp
  echo "Firewall: Opened port $APPIUM_PORT"
else
  echo "UFW not active, skipping firewall configuration"
fi

# Start services
echo ""
echo "Starting services..."
systemctl start android-emulator
echo "Waiting for emulator to boot (60 seconds)..."
sleep 60

# Wait for device
$ANDROID_SDK_ROOT/platform-tools/adb wait-for-device
$ANDROID_SDK_ROOT/platform-tools/adb devices

# Start Appium
systemctl start appium

echo ""
echo "=========================================="
echo "Setup Complete!"
echo "=========================================="
echo ""
echo "Services status:"
systemctl status android-emulator --no-pager || true
echo ""
systemctl status appium --no-pager || true
echo ""
echo "Verify Appium is running:"
echo "  curl http://localhost:$APPIUM_PORT/status"
echo ""
echo "View logs:"
echo "  journalctl -u android-emulator -f"
echo "  journalctl -u appium -f"
echo ""
echo "Connected devices:"
$ANDROID_SDK_ROOT/platform-tools/adb devices
echo ""
echo "=========================================="
