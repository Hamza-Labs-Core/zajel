# CI Attestation Integration Guide

## Overview

This document describes how to integrate app attestation (build token generation + reference binary upload) into the existing CI pipeline. The attestation tooling consists of three scripts:

| Script | Purpose |
|--------|---------|
| `scripts/generate-attestation-keys.mjs` | One-time: generate Ed25519 keypair |
| `scripts/generate-build-token.mjs` | CI: sign a build token for each release binary |
| `scripts/upload-reference-binary.mjs` | CI: upload region hashes to bootstrap for challenge verification |

## Required CI Secrets

Configure these in GitHub Settings > Secrets and variables > Actions:

| Secret | Description | How to Generate |
|--------|-------------|-----------------|
| `ATTESTATION_SIGNING_KEY` | Base64 Ed25519 private key seed (32 bytes) | `node scripts/generate-attestation-keys.mjs` |
| `CI_UPLOAD_SECRET` | Bearer token for bootstrap `/attest/upload-reference` endpoint | Generate a random token, configure it on the bootstrap CF Worker |
| `BOOTSTRAP_URL` | Bootstrap server URL (e.g., `https://bootstrap.zajel.app`) | Already configured as `QA_BOOTSTRAP_URL` for QA |

## Initial Setup

### 1. Generate Attestation Keys

Run once per environment (production + QA):

```bash
node scripts/generate-attestation-keys.mjs
```

This outputs:
- **Private key seed (base64)** — store as `ATTESTATION_SIGNING_KEY` secret
- **Public key (base64)** — embed in Flutter app and bootstrap server config

### 2. Store the Private Key

```bash
# For CF Worker (bootstrap server):
cd packages/server
wrangler secret put ATTESTATION_SIGNING_KEY
# Paste the base64 seed

# For GitHub Actions:
# Go to Settings > Secrets > Actions > New repository secret
# Name: ATTESTATION_SIGNING_KEY
# Value: <base64 seed>
```

### 3. Embed Public Key in App

Add the public key to the app's attestation verifier (similar to bootstrap public keys):

```dart
// lib/core/security/attestation_verifier.dart
class AttestationVerifier {
  static const publicKeys = [
    '<base64-public-key-production>',
    '<base64-public-key-qa>',
  ];
}
```

## Pipeline Integration

### Where to Add Build Token Generation

Build token generation should happen **after** `flutter build` and **before** artifact upload in each platform build job.

### PR Pipeline (`pr-pipeline.yml`)

Add build token generation to each build job. Example for the `build-android` job:

```yaml
build-android:
  name: Build Android
  needs: [tag-prerelease]
  runs-on: ubuntu-latest
  env:
    VERSION: ${{ needs.tag-prerelease.outputs.version }}
  steps:
    - uses: actions/checkout@v4

    # ... existing Java, Flutter, dependency setup ...

    # Step 1: Build APK WITHOUT build token (first pass)
    - name: Build APK
      working-directory: packages/app
      run: |
        flutter build apk --release \
          --dart-define=ENV=qa \
          --dart-define=VERSION=${{ env.VERSION }} \
          --dart-define=BOOTSTRAP_URL=${{ vars.QA_BOOTSTRAP_URL }} \
          --dart-define=SIGNALING_URL=${{ vars.VPS_QA_WS_URL || '' }} \
          --dart-define=E2E_TEST=true

    # Step 2: Generate build token from the built binary
    - name: Generate build token
      id: attestation
      working-directory: packages/app
      env:
        ATTESTATION_SIGNING_KEY: ${{ secrets.ATTESTATION_SIGNING_KEY }}
      run: |
        APK_PATH="build/app/outputs/flutter-apk/app-release.apk"
        OUTPUT=$(node ../../scripts/generate-build-token.mjs \
          --version "${{ env.VERSION }}" \
          --platform android \
          --binary-path "$APK_PATH")

        # Parse output
        BUILD_TOKEN=$(echo "$OUTPUT" | grep '^BUILD_TOKEN=' | cut -d= -f2-)
        BUILD_HASH=$(echo "$OUTPUT" | grep '^BUILD_HASH=' | cut -d= -f2-)

        echo "build_token=$BUILD_TOKEN" >> $GITHUB_OUTPUT
        echo "build_hash=$BUILD_HASH" >> $GITHUB_OUTPUT

    # Step 3: Rebuild with build token embedded
    - name: Rebuild APK with build token
      working-directory: packages/app
      run: |
        flutter build apk --release \
          --dart-define=ENV=qa \
          --dart-define=VERSION=${{ env.VERSION }} \
          --dart-define=BOOTSTRAP_URL=${{ vars.QA_BOOTSTRAP_URL }} \
          --dart-define=SIGNALING_URL=${{ vars.VPS_QA_WS_URL || '' }} \
          --dart-define=E2E_TEST=true \
          --dart-define=BUILD_TOKEN=${{ steps.attestation.outputs.build_token }}

    # Step 4: Upload reference binary metadata
    - name: Upload reference binary
      if: ${{ env.CI_UPLOAD_SECRET != '' }}
      working-directory: packages/app
      env:
        CI_UPLOAD_SECRET: ${{ secrets.CI_UPLOAD_SECRET }}
      run: |
        node ../../scripts/upload-reference-binary.mjs \
          --version "${{ env.VERSION }}" \
          --platform android \
          --binary-path "build/app/outputs/flutter-apk/app-release.apk" \
          --bootstrap-url "${{ vars.QA_BOOTSTRAP_URL }}"

    # ... existing artifact upload steps ...
```

### Two-Pass Build Strategy

The attestation flow requires a **two-pass build**:

1. **First build**: Produce the binary without a build token
2. **Generate token**: Hash the binary and sign a build token
3. **Second build**: Rebuild with `--dart-define=BUILD_TOKEN=<token>` embedded

This is necessary because:
- The build token contains a hash of the binary
- The binary changes if the build token is embedded
- Therefore: hash the token-less binary, sign it, then embed the token in the final binary
- The reference binary metadata upload uses the SECOND build (the one users actually get)

**Important**: The reference binary upload must use the binary from the SECOND build, since that's the binary users will actually have.

An alternative (simpler) approach is to use a single build:
1. Build the binary
2. Sign the binary hash as the build token
3. Store the build token externally (not in the binary)
4. Upload reference binary metadata
5. App retrieves its build token from a config endpoint at first launch

This avoids the two-pass problem entirely. Choose based on your needs.

### Platform-Specific Binary Paths

| Platform | Binary Path (relative to `packages/app`) |
|----------|------------------------------------------|
| Android APK | `build/app/outputs/flutter-apk/app-release.apk` |
| Android AAB | `build/app/outputs/bundle/release/app-release.aab` |
| iOS | `build/ios/iphoneos/Runner.app` (or the created `.ipa`) |
| Linux | `build/linux/x64/release/bundle/zajel` |
| macOS | `build/macos/Build/Products/Release/zajel.app` |
| Windows | `build/windows/x64/runner/Release/zajel.exe` |
| Web | `build/web/main.dart.js` |

### Release Pipeline (`release.yml`)

The same pattern applies. Add build token generation after each platform build step, before artifact upload. In the release pipeline, use the production `ATTESTATION_SIGNING_KEY` and production `BOOTSTRAP_URL`.

## Testing the Integration

### Local Testing

```bash
# 1. Generate test keys
node scripts/generate-attestation-keys.mjs

# 2. Run the self-test suite
node scripts/test-attestation-scripts.mjs

# 3. Test with a real binary
ATTESTATION_SIGNING_KEY=<base64-seed> \
node scripts/generate-build-token.mjs \
  --version 1.0.0 \
  --platform linux \
  --binary-path /path/to/binary

# 4. Test reference upload (dry run)
node scripts/upload-reference-binary.mjs \
  --version 1.0.0 \
  --platform linux \
  --binary-path /path/to/binary \
  --dry-run
```

### CI Testing

Add a test step to validate the scripts work in CI before using them in production:

```yaml
test-attestation-scripts:
  name: Test Attestation Tooling
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
    - name: Run attestation self-tests
      run: node scripts/test-attestation-scripts.mjs
```

## Security Considerations

1. **ATTESTATION_SIGNING_KEY** must be stored as a GitHub Actions secret (never in code).
2. **CI_UPLOAD_SECRET** must be a strong random token, also stored as a secret.
3. The public key is safe to embed in source code (it's public by design).
4. Build tokens are signed but not encrypted — they contain version/platform/hash info.
5. The reference binary region hashes are stored on bootstrap; compromise of bootstrap storage would allow an attacker to know the expected hashes but not produce correct HMAC responses without the actual binary bytes.

## Troubleshooting

### "ATTESTATION_SIGNING_KEY must decode to 32 bytes"

The secret is malformed. Regenerate with `node scripts/generate-attestation-keys.mjs` and ensure you copy the full base64 string.

### "Cannot read binary at ..."

The binary path is wrong. Check the platform-specific paths table above. Ensure the build step completed successfully before the token generation step.

### Upload returns 401/403

The `CI_UPLOAD_SECRET` doesn't match what's configured on the bootstrap server. Verify the secret matches.

### Upload returns 404

The bootstrap server doesn't have the `/attest/upload-reference` endpoint yet. This endpoint needs to be implemented as part of Plan 06 Phase 2.
