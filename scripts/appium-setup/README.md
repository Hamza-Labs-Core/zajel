# Appium E2E Testing Server Setup

Scripts to configure Hetzner VPS servers for Android E2E testing with Appium.

## Requirements

- **Server**: Hetzner CCX23 or better (4 vCPUs, 8GB RAM minimum)
- **OS**: Ubuntu 22.04 LTS
- **KVM**: Hardware virtualization support (available on dedicated/CCX servers)

## Quick Setup

```bash
# On each Appium server (as root)
curl -sSL https://raw.githubusercontent.com/YOUR_REPO/main/scripts/appium-setup/setup-server.sh | sudo bash
```

Or manually:

```bash
# Clone the repo
git clone https://github.com/YOUR_REPO/zajel.git
cd zajel/scripts/appium-setup

# Run setup
sudo ./setup-server.sh

# Verify
./verify-setup.sh
```

## Configuration

Environment variables (set before running):

| Variable | Default | Description |
|----------|---------|-------------|
| `ANDROID_SDK_ROOT` | `/opt/android-sdk` | Android SDK installation path |
| `APPIUM_PORT` | `4723` | Port for Appium server |
| `EMULATOR_NAME` | `test_device` | Name of the Android Virtual Device |
| `SYSTEM_IMAGE` | `system-images;android-34;google_apis;x86_64` | Android system image |

## Services

The setup creates two systemd services:

- `android-emulator.service` - Runs the Android emulator in headless mode
- `appium.service` - Runs Appium server (starts after emulator)

### Service Commands

```bash
# Check status
systemctl status android-emulator
systemctl status appium

# View logs
journalctl -u android-emulator -f
journalctl -u appium -f

# Restart services
systemctl restart android-emulator
systemctl restart appium

# Stop services
systemctl stop appium
systemctl stop android-emulator
```

## Verification

```bash
# Check Appium is running
curl http://localhost:4723/status

# Check connected emulators
adb devices

# Run full verification
./verify-setup.sh
```

## GitHub Secrets

Add these secrets to your GitHub repository:

| Secret | Description |
|--------|-------------|
| `APPIUM_SERVERS` | Comma-separated list of Appium server IPs (e.g., `1.2.3.4,5.6.7.8`) |
| `VPS_SSH_KEY` | SSH private key for accessing servers |
| `VPS_USER` | SSH username (usually `root`) |
| `VPS_PORT` | SSH port (usually `22`) |

## Firewall

The setup script opens port 4723. For additional security, restrict access:

```bash
# Allow only GitHub Actions IPs (example)
ufw delete allow 4723/tcp
ufw allow from GITHUB_ACTIONS_IP to any port 4723

# Or use SSH tunneling (recommended)
# In GitHub Actions, create SSH tunnel instead of direct access
```

## Troubleshooting

### Emulator won't start

```bash
# Check KVM support
ls -la /dev/kvm

# Check emulator logs
journalctl -u android-emulator -n 100

# Try starting manually
/opt/android-sdk/emulator/emulator -avd test_device -no-window -no-audio -verbose
```

### Appium not responding

```bash
# Check if Appium is running
ps aux | grep appium

# Check port binding
netstat -tlnp | grep 4723

# Check logs
journalctl -u appium -n 100
```

### ADB can't find device

```bash
# Restart ADB server
adb kill-server
adb start-server
adb devices

# Check emulator is running
ps aux | grep emulator
```
