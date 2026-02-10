# Plan: Add TURN Relay to CI for WebRTC E2E Tests

## Context

Android E2E Phases C (app+headless) and E (emulator+emulator) fail because the Android emulator lives on a virtual 10.0.2.x network behind NAT. STUN-only ICE can't establish direct WebRTC connections between the emulator and the host. A TURN relay provides a reachable intermediary both sides can route through.

**Approach**: Run coturn locally on the CI runner during the E2E job. Determine the host's real IP (reachable by both the emulator through NAT and the headless client directly). The Flutter app already supports `--dart-define=TURN_URL/TURN_USER/TURN_PASS` and forces relay mode in E2E builds (`app_providers.dart:112`).

---

## Changes (4 files)

### 1. `packages/headless-client/zajel/client.py` — Add `ice_servers` param

**Lines 99-124**: Add `ice_servers` optional param to `ZajelHeadlessClient.__init__`, convert dict-format servers to `RTCIceServer` objects, pass to `WebRTCService`.

```python
def __init__(
    self,
    signaling_url: str,
    name: str = "HeadlessBot",
    log_level: str = "INFO",
    auto_accept_pairs: bool = False,
    media_dir: str = "./test_media",
    receive_dir: str = "./received_files",
    db_path: str = "zajel_headless.db",
    ice_servers: Optional[list] = None,     # NEW
):
    ...
    # Convert ice_servers dicts to RTCIceServer objects if provided
    rtc_ice_servers = None
    if ice_servers:
        from aiortc import RTCIceServer
        rtc_ice_servers = [
            RTCIceServer(**s) if isinstance(s, dict) else s
            for s in ice_servers
        ]
    self._webrtc = WebRTCService(ice_servers=rtc_ice_servers)
```

- `WebRTCService.__init__` already accepts `ice_servers: Optional[list[RTCIceServer]]` (webrtc.py:48-53)
- `HeadlessBob.__init__` uses `**kwargs` so no changes needed there

### 2. `e2e-tests/conftest.py` — Read TURN env in `headless_bob` fixture

**Lines 1093-1111**: Read `TURN_URL`, `TURN_USER`, `TURN_PASS` from env, build `ice_servers` list, pass to `HeadlessBob`.

```python
@pytest.fixture(scope="function")
def headless_bob():
    if not SIGNALING_URL:
        pytest.skip("SIGNALING_URL not set")

    turn_url = os.environ.get("TURN_URL", "")
    turn_user = os.environ.get("TURN_USER", "")
    turn_pass = os.environ.get("TURN_PASS", "")

    ice_servers = None
    if turn_url:
        ice_servers = [
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": turn_url, "username": turn_user, "credential": turn_pass},
        ]

    bob = HeadlessBob(
        signaling_url=SIGNALING_URL,
        name="HeadlessBob",
        auto_accept_pairs=True,
        log_level="DEBUG",
        ice_servers=ice_servers,
    )
    bob.connect()
    yield bob
    bob.disconnect()
```

`os` is already imported at line 5.

### 3. `.github/workflows/pr-pipeline.yml` — coturn setup + wiring

**A. New step** (after "Resolve signaling URL" at line 1020, before "Build E2E APK"):

```yaml
- name: Setup TURN relay (coturn)
  run: |
    sudo apt-get update -qq && sudo apt-get install -y -qq coturn
    HOST_IP=$(hostname -I | awk '{print $1}')
    echo "Host IP for TURN: $HOST_IP"

    sudo tee /etc/turnserver.conf > /dev/null <<CONF
    listening-ip=0.0.0.0
    listening-port=3478
    relay-ip=$HOST_IP
    external-ip=$HOST_IP
    min-port=49152
    max-port=49252
    realm=zajel-ci
    user=test:test
    lt-cred-mech
    no-tls
    no-dtls
    no-cli
    fingerprint
    log-file=/tmp/coturn.log
    CONF

    sudo turnserver -c /etc/turnserver.conf &
    sleep 2

    if ss -tlnp | grep -q ':3478'; then
      echo "coturn running on port 3478"
    else
      echo "ERROR: coturn failed to start"; cat /tmp/coturn.log; exit 1
    fi

    echo "TURN_URL=turn:${HOST_IP}:3478" >> "$GITHUB_ENV"
    echo "TURN_USER=test" >> "$GITHUB_ENV"
    echo "TURN_PASS=test" >> "$GITHUB_ENV"
```

**B. Modify "Build E2E APK"** (line 1026-1030) — add 3 dart-defines:

```
--dart-define=TURN_URL=${{ env.TURN_URL }} \
--dart-define=TURN_USER=${{ env.TURN_USER }} \
--dart-define=TURN_PASS=${{ env.TURN_PASS }}
```

**C. Modify "Run E2E tests" env block** (line 1093-1098) — add:

```yaml
TURN_URL: ${{ env.TURN_URL }}
TURN_USER: ${{ env.TURN_USER }}
TURN_PASS: ${{ env.TURN_PASS }}
```

**D. Promote Phase C to mandatory** (lines 1152-1166) — remove informational comments, remove the warning echo:

```bash
# ── Phase C: Headless-paired tests (mandatory with TURN relay) ──
HEADLESS_RESULT=0
if [ -n "$SIGNALING_URL" ]; then
  echo "=== Running headless-paired tests ==="
  pytest -m "headless and single_device" -v -s --timeout=300 || HEADLESS_RESULT=$?
else
  echo "=== Skipping headless tests (SIGNALING_URL not set) ==="
fi
```

**E. Promote Phase E to mandatory** (lines 1179-1185) — replace `|| true`:

```bash
# ── Phase E: Multi-device pairing test (mandatory with TURN relay) ──
PAIRING_RESULT=0
echo "=== Running two-device pairing test ==="
pytest tests/test_pairing.py::TestPairing::test_two_devices_can_pair -v -s --timeout=300 || PAIRING_RESULT=$?
```

**F. Update failure gate** (lines 1190-1203) — add headless + pairing:

```bash
if [ $HEADLESS_RESULT -ne 0 ]; then
  echo "FAILED: Headless-paired tests"
  FAILED=1
fi
if [ $PAIRING_RESULT -ne 0 ]; then
  echo "FAILED: Multi-device pairing"
  FAILED=1
fi
```

**G. Add coturn logs** to "Collect logs on failure" step:

```bash
cat /tmp/coturn.log >> test-artifacts/coturn.log 2>/dev/null || true
```

### 4. `packages/headless-client/zajel/webrtc.py` — Log force_relay no-op (minor)

**Line 93** (in `create_connection`): aiortc doesn't support `iceTransportPolicy`. Add a log line when `force_relay=True` explaining relay will be used as fallback when direct candidates fail. Informational only — both sides will still connect via TURN relay candidates when host candidates are unreachable.

---

## How It Works

1. **coturn** starts on the CI host, listening on `0.0.0.0:3478`, `external-ip=<HOST_REAL_IP>`
2. **Flutter app** (emulator): built with `TURN_URL=turn:<HOST_IP>:3478`, forces `iceTransportPolicy: relay` in E2E mode → only TURN relay candidates
3. **HeadlessBob** (host): configured with same TURN URL → gathers both host and relay candidates
4. ICE selects the relay candidate pair (through coturn). coturn relays UDP between them.
5. **Phase E**: Both emulators route through coturn via their 10.0.2.x NAT → host IP

## Verification

1. Push, wait for CI
2. **Phase C**: 8+ headless-paired tests pass (previously all failed)
3. **Phase E**: `test_two_devices_can_pair` passes (previously informational)
4. **Phase B/D**: Still pass (unaffected)
5. If failures: check `coturn.log` in test artifacts for TURN allocation logs
