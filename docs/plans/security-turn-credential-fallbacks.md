# Security Remediation: TURN Credential Hardcoded Fallbacks in CI

## Issue Summary

The PR pipeline workflow (`pr-pipeline.yml`) contains hardcoded TURN credential
fallback values that are used when GitHub secrets `TURN_USER` and `TURN_PASS`
are not set. Since these secrets are **not configured** in the repository, the
fallback values `ci-turn` / `ci-turn-pass` are always used. These plaintext
credentials appear in CI logs, are baked into APK artifacts, and the repository
is **public**.

**Severity**: Medium
**CVSS 3.1 Estimate**: 4.3 (Medium) -- credentials are CI-only, scoped to an
ephemeral coturn instance, but the pattern sets a bad precedent and the coturn
config is printed to logs on a public repository.

---

## Current State Analysis

### Where TURN Credentials Appear

| Location | File | Lines | Exposure |
|----------|------|-------|----------|
| APK build step | `.github/workflows/pr-pipeline.yml` | 337-338 | Baked into APK binary via `--dart-define` |
| coturn setup env block | `.github/workflows/pr-pipeline.yml` | 1649-1650 | Expanded into env vars from secrets fallback |
| coturn config write | `.github/workflows/pr-pipeline.yml` | 1668 | Written to `/etc/turnserver.conf` as `user=ci-turn:ci-turn-pass` |
| coturn config dump | `.github/workflows/pr-pipeline.yml` | 1692 | `sudo cat /etc/turnserver.conf` prints config to CI log including credentials |
| GITHUB_ENV export | `.github/workflows/pr-pipeline.yml` | 1699-1700 | Written to `$GITHUB_ENV` as plaintext (not masked) |
| E2E test env | `.github/workflows/pr-pipeline.yml` | 1774-1775 | Passed to HeadlessBob Python process |
| HeadlessBob conftest | `e2e-tests/conftest.py` | 583-584 | Read from environment, passed to aiortc ICE config |
| Flutter app providers | `packages/app/lib/core/providers/app_providers.dart` | 124-125, 825-826 | Compiled as const strings via `String.fromEnvironment` |
| CI pipeline wiki | `packages/wiki/CI-Pipeline.md` | 176 | Documents credentials as "Random per-run" -- this is inaccurate |

### Secret Configuration Status

Confirmed via `gh secret list`: **No `TURN_USER` or `TURN_PASS` secrets exist**
in the repository. The `|| 'ci-turn'` and `|| 'ci-turn-pass'` fallbacks are
**always** used.

### Log Exposure Vectors

1. **Line 1692**: `sudo cat /etc/turnserver.conf` dumps the entire coturn
   config to the CI log, including the `user=ci-turn:ci-turn-pass` line. Since
   the values are not GitHub secrets, GitHub's log masking does not redact them.

2. **Lines 1699-1700**: `echo "TURN_USER=ci-turn" >> "$GITHUB_ENV"` writes
   credentials to the environment file. Without `::add-mask::`, these values
   appear unredacted in all subsequent step logs.

3. **Line 1896**: On test failure, `cat /tmp/coturn.log >> test-artifacts/coturn.log`
   captures the coturn verbose log which may contain authentication events with
   credential references. This file is then uploaded as a public artifact
   (`e2e-test-artifacts`, retention 3 days).

### APK Artifact Exposure

- The APK built at line 331-338 includes `--dart-define=TURN_USER=ci-turn` and
  `--dart-define=TURN_PASS=ci-turn-pass`. Dart `--dart-define` values are
  compiled as const strings into the AOT snapshot, making them extractable via
  `strings` or decompilation.

- The APK is uploaded as artifact `android-build` with `retention-days: 1`.
  On a public repository, any GitHub user with read access can download workflow
  artifacts during the retention window.

- **Release builds are NOT affected**: The release workflow (`release.yml` line
  186) does not pass `TURN_USER` or `TURN_PASS` to `flutter build apk`.

### Wiki Inaccuracy

`packages/wiki/CI-Pipeline.md` line 176 states credentials are
"Random per-run credentials" -- this is false. They are static hardcoded values.

---

## Risk Assessment

### What an Attacker Gains

The TURN credentials authenticate to a coturn instance that:
- Runs only during the CI E2E job (ephemeral, ~55 minute lifetime)
- Listens on the CI runner's private IP (not internet-reachable)
- Uses `lt-cred-mech` (long-term credentials, no HMAC-based auth)

### Realistic Attack Scenarios

1. **Direct exploitation: Very Low**. The coturn server is ephemeral and runs on
   a GitHub-hosted runner with no inbound internet access. An attacker cannot
   connect to it even with valid credentials.

2. **Credential reuse: Low but concerning**. If the same `ci-turn` / `ci-turn-pass`
   values are ever used in non-CI environments (staging, VPS, production), this
   becomes a real vulnerability. The pattern encourages copy-paste reuse.

3. **Pattern proliferation: Medium**. The `|| 'fallback'` pattern for secrets is
   a bad practice that may be replicated for more sensitive credentials.
   Developers may assume this is acceptable for all CI secrets.

4. **APK artifact extraction: Low**. While the APK contains these credentials as
   compiled constants, extraction requires downloading the CI artifact within
   its 1-day retention and decompiling the Dart AOT snapshot. The credentials
   only work against the ephemeral CI coturn.

### Mitigating Factors

- coturn instance is ephemeral and non-internet-reachable
- Release builds do not include TURN credentials
- The credentials are scoped to a no-tls, no-dtls relay (testing only)
- APK artifact retention is 1 day

---

## Remediation Plan

### Phase 1: Generate Random Per-Run Credentials (Immediate)

Replace the hardcoded fallbacks with credentials generated at runtime. This
eliminates the static credential problem entirely.

**Step 1.1**: Remove fallback values from the APK build step and the coturn
setup step. Generate a random credential pair early in the E2E job and use it
consistently.

**Files to modify**:
- `.github/workflows/pr-pipeline.yml`

**Changes to the build-android job** (lines ~337-338):

The APK build happens in a separate job (`build-android`) before the E2E job
runs, so the APK and the coturn instance must agree on credentials. There are
two options:

**Option A (Recommended): Generate credentials in build-android, pass via artifact**

```yaml
# In build-android job, before the build step:
- name: Generate TURN credentials for E2E
  id: turn-creds
  run: |
    TURN_USER="ci-$(openssl rand -hex 4)"
    TURN_PASS="$(openssl rand -hex 16)"
    echo "::add-mask::${TURN_USER}"
    echo "::add-mask::${TURN_PASS}"
    echo "user=${TURN_USER}" >> "$GITHUB_OUTPUT"
    echo "pass=${TURN_PASS}" >> "$GITHUB_OUTPUT"

# In the build step, replace hardcoded fallbacks:
- name: Build APK with QA config
  run: |
    flutter build apk --release \
      --dart-define=ENV=qa \
      --dart-define=VERSION=${{ env.VERSION }} \
      --dart-define=BOOTSTRAP_URL=${{ vars.QA_BOOTSTRAP_URL }} \
      --dart-define=E2E_TEST=true \
      --dart-define=TURN_URL=turn:10.0.2.2:3478 \
      --dart-define=TURN_USER=${{ steps.turn-creds.outputs.user }} \
      --dart-define=TURN_PASS=${{ steps.turn-creds.outputs.pass }}

# Save credentials alongside the APK artifact:
- name: Save TURN credentials for E2E
  run: |
    echo "${{ steps.turn-creds.outputs.user }}" > packages/app/build/app/outputs/flutter-apk/.turn-user
    echo "${{ steps.turn-creds.outputs.pass }}" > packages/app/build/app/outputs/flutter-apk/.turn-pass

# Update the upload-artifact path to include the credential files:
- name: Upload Android artifact
  uses: actions/upload-artifact@v4
  with:
    name: android-build
    path: |
      packages/app/build/app/outputs/flutter-apk/zajel-${{ env.VERSION }}-android.apk
      packages/app/build/app/outputs/flutter-apk/.build-sha
      packages/app/build/app/outputs/flutter-apk/.turn-user
      packages/app/build/app/outputs/flutter-apk/.turn-pass
    retention-days: 1
```

**Option B (Simpler alternative): Set the GitHub secrets**

Add `TURN_USER` and `TURN_PASS` as repository secrets via:
```bash
gh secret set TURN_USER --body "$(openssl rand -hex 8)"
gh secret set TURN_PASS --body "$(openssl rand -hex 16)"
```

Then remove the `|| 'ci-turn'` fallbacks so the workflow uses actual secrets.
This is simpler but uses static credentials across all runs.

**Recommendation**: Option A is preferred because it generates unique
credentials per run, matching the wiki's documented behavior and providing
better isolation between CI runs.

### Phase 2: Mask Credentials and Stop Logging Config (Immediate)

**Step 2.1**: Add `::add-mask::` directives in the E2E job's coturn setup step.

**Step 2.2**: Remove the `sudo cat /etc/turnserver.conf` line that dumps
credentials to the log.

**Changes to the e2e-android job** (coturn setup step, lines ~1646-1700):

```yaml
- name: Setup TURN relay (coturn)
  run: |
    # Read credentials from artifact (Option A) or secrets (Option B)
    TURN_USER=$(cat android-artifact/.turn-user)
    TURN_PASS=$(cat android-artifact/.turn-pass)

    # Mask credentials so they never appear in logs
    echo "::add-mask::${TURN_USER}"
    echo "::add-mask::${TURN_PASS}"

    sudo apt-get update -qq && sudo apt-get install -y -qq coturn
    HOST_IP=$(hostname -I | awk '{print $1}')
    echo "Host IP for TURN: $HOST_IP"

    sudo tee /etc/turnserver.conf > /dev/null <<CONF
    listening-ip=0.0.0.0
    listening-port=3478
    relay-ip=$HOST_IP
    external-ip=$HOST_IP
    min-port=49152
    max-port=50152
    realm=zajel-ci
    user=${TURN_USER}:${TURN_PASS}
    lt-cred-mech
    no-tls
    no-dtls
    no-cli
    fingerprint
    verbose
    log-file=/tmp/coturn.log
    CONF

    sudo systemctl restart coturn
    sleep 2

    if ss -tlnp | grep -q ':3478'; then
      echo "coturn running on port 3478"
    else
      echo "ERROR: coturn failed to start"
      sudo systemctl status coturn || true
      cat /tmp/coturn.log 2>/dev/null || true
      exit 1
    fi
    # Do NOT dump turnserver.conf -- it contains credentials

    echo "TURN_URL=turn:127.0.0.1:3478" >> "$GITHUB_ENV"
    echo "TURN_URL_EMU=turn:10.0.2.2:3478" >> "$GITHUB_ENV"
    echo "TURN_USER=${TURN_USER}" >> "$GITHUB_ENV"
    echo "TURN_PASS=${TURN_PASS}" >> "$GITHUB_ENV"
```

### Phase 3: Sanitize Uploaded Artifacts (Immediate)

**Step 3.1**: Ensure the coturn log uploaded on failure does not contain
credential strings.

**Changes to "Collect logs on failure" step** (line ~1896):

```yaml
# Sanitize coturn log before uploading
if [ -f /tmp/coturn.log ]; then
  sed 's/user=[^ ]*/user=***REDACTED***/g' /tmp/coturn.log > test-artifacts/coturn.log
fi
```

**Step 3.2**: Ensure `.turn-user` and `.turn-pass` files are not included in
uploaded failure artifacts. The artifact paths in "Upload test artifacts" should
not overlap with the credential files.

### Phase 4: Fix Wiki Documentation (Low Priority)

**File**: `packages/wiki/CI-Pipeline.md` line 176

Update the description to match actual behavior (either "Random per-run
credentials" if Option A is implemented, or remove the inaccurate claim).

### Phase 5: Consider HMAC-Based Time-Limited Credentials (Future)

For a more robust approach, coturn supports `use-auth-secret` with HMAC-based
temporary credentials derived from a shared secret. This would allow generating
short-lived TURN credentials without baking long-term credentials into the APK.

However, this requires the Flutter app to compute HMAC credentials at runtime,
which adds complexity. This is not necessary for CI-only usage but could be
valuable if TURN is ever used in production.

---

## Files to Modify

| File | Change |
|------|--------|
| `.github/workflows/pr-pipeline.yml` (lines 337-338) | Remove `\|\| 'ci-turn'` fallbacks; use generated credentials |
| `.github/workflows/pr-pipeline.yml` (lines 1646-1700) | Read credentials from artifact, add `::add-mask::`, remove config dump |
| `.github/workflows/pr-pipeline.yml` (line 1692) | Delete `sudo cat /etc/turnserver.conf` |
| `.github/workflows/pr-pipeline.yml` (line 1896) | Sanitize coturn log before archiving |
| `packages/wiki/CI-Pipeline.md` (line 176) | Update to match actual credential generation method |

---

## Verification Steps

### Pre-Deployment Verification

1. **Confirm no hardcoded fallbacks remain**:
   ```bash
   grep -n "ci-turn" .github/workflows/pr-pipeline.yml
   # Expected: no matches
   ```

2. **Confirm masking is in place**:
   ```bash
   grep -n "::add-mask::" .github/workflows/pr-pipeline.yml
   # Expected: matches for TURN_USER and TURN_PASS masking
   ```

3. **Confirm config dump is removed**:
   ```bash
   grep -n "cat.*turnserver.conf" .github/workflows/pr-pipeline.yml
   # Expected: no matches (the sudo tee write is fine, the cat read is removed)
   ```

4. **Confirm coturn log sanitization**:
   ```bash
   grep -n "REDACTED" .github/workflows/pr-pipeline.yml
   # Expected: match in the log collection step
   ```

### Post-Deployment Verification

1. **Run a PR pipeline** and verify:
   - The CI log does NOT contain `ci-turn` or `ci-turn-pass` anywhere
   - The CI log does NOT dump `/etc/turnserver.conf` contents
   - The `::add-mask::` directives cause credential values to appear as `***`
   - The E2E tests still pass (coturn still works with generated credentials)

2. **Download the APK artifact** and verify:
   - Run `strings` against the APK; confirm `ci-turn` does not appear
   - The TURN credentials baked in are unique to this run

3. **If tests fail, download `e2e-test-artifacts`** and verify:
   - `coturn.log` does not contain plaintext credentials
   - No `.turn-user` or `.turn-pass` files are included

4. **Verify wiki accuracy**:
   - `packages/wiki/CI-Pipeline.md` line 176 matches actual implementation

---

## Appendix: Why This Matters Even for Ephemeral CI Credentials

1. **Public repository exposure**: Any workflow log on a public repository is
   visible to all GitHub users. Even ephemeral credentials in logs create an
   unnecessary attack surface.

2. **Pattern normalization**: Developers who see `|| 'hardcoded-value'` for
   secrets may replicate this pattern for more sensitive credentials (database
   passwords, API keys, signing keys).

3. **Supply chain considerations**: The APK artifact, while retained for only
   1 day, is downloadable by anyone with repository read access. Embedding
   any credential in a distributable artifact is a CWE-798 (Use of Hard-coded
   Credentials) violation, regardless of the credential's scope.

4. **Compliance**: SOC 2 and ISO 27001 controls require that credentials are
   not stored in plaintext in source code or build artifacts. Even CI-only
   credentials should follow this principle for audit readiness.
