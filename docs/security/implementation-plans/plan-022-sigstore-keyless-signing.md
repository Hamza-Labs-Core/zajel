# Implementation Plan 022: Sigstore Keyless/Ephemeral Signing

## Summary

This plan implements Sigstore keyless signing to eliminate long-lived signing keys and provide tamper-evident audit trails for build artifacts and bootstrap server responses. The implementation is divided into four phases:

1. **Phase 1**: GitHub Actions artifact attestation using Sigstore + SLSA provenance
2. **Phase 2**: Cosign integration for artifact signing and verification
3. **Phase 3**: Bootstrap signing key rotation mechanism
4. **Phase 4**: Verification client library for Flutter app

The current system uses long-lived Ed25519 keys (`BOOTSTRAP_SIGNING_KEY`) and platform-specific signing certificates (Android keystore, Windows PFX, iOS P12) stored as GitHub Actions secrets. These keys have no expiration, rotation policy, or audit trail. Sigstore's keyless signing model binds ephemeral signing keys to verifiable OIDC identities (GitHub Actions workflow identity), eliminating the need for long-lived secret storage and providing a public transparency log (Rekor) for forensic analysis.

**Key Benefits:**
- No long-lived signing keys to protect or rotate
- Verifiable build provenance tied to source repository and commit SHA
- Public transparency log (Rekor) for post-incident forensics
- SLSA compliance for supply chain security
- Reduced attack surface from secret exfiltration

**Non-Goals:**
- This plan does NOT replace platform-specific signing requirements (Android keystore, Windows cert, iOS cert) - these remain necessary for app store distribution
- Sigstore attestation is layered on top of platform signing
- Full Sigstore keyless signing in Cloudflare Workers (no Fulcio access) - Phase 3 implements key rotation instead

## Files to Modify

### Phase 1: GitHub Actions Artifact Attestation

#### 1. `.github/workflows/release.yml`

**Lines 481-483** - Add `id-token: write` permission for OIDC token:
```yaml
# BEFORE:
permissions:
  contents: write

# AFTER:
permissions:
  contents: write
  id-token: write  # Required for Sigstore keyless signing
  attestations: write  # Required for artifact attestations
```

**After line 509** (after "Rename artifacts" step) - Add attestation generation step:
```yaml
# NEW STEP (insert after line 509):
- name: Generate SLSA provenance attestations
  uses: actions/attest-build-provenance@v2
  with:
    subject-path: |
      release-files/zajel-*.apk
      release-files/zajel-*.aab
      release-files/zajel-*.ipa
      release-files/zajel-*.dmg
      release-files/zajel-*.zip
      release-files/zajel-*.tar.gz
      release-files/zajel-*.msix
```

### Phase 2: Cosign Integration

#### 1. `.github/workflows/release.yml`

**After attestation step** (after Phase 1 addition) - Add cosign signing:
```yaml
# NEW STEPS (insert after attestation step):
- name: Install Cosign
  uses: sigstore/cosign-installer@v3
  with:
    cosign-release: 'v2.2.3'

- name: Sign artifacts with Cosign
  env:
    COSIGN_YES: "true"  # Auto-approve signing
  run: |
    # Sign each artifact and generate a bundle
    for artifact in release-files/zajel-*; do
      echo "Signing $artifact..."
      cosign sign-blob "$artifact" \
        --bundle "${artifact}.sigstore.json" \
        --yes
    done

- name: Verify signatures
  run: |
    # Verify each signature was generated correctly
    for artifact in release-files/zajel-*; do
      if [ -f "${artifact}.sigstore.json" ]; then
        echo "Verifying $artifact..."
        cosign verify-blob "$artifact" \
          --bundle "${artifact}.sigstore.json" \
          --certificate-identity-regexp "^https://github.com/${{ github.repository }}/" \
          --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
      fi
    done
```

**Line 516** - Update release files to include Sigstore bundles:
```yaml
# BEFORE:
files: release-files/*

# AFTER:
files: |
  release-files/*
  release-files/*.sigstore.json
```

#### 2. `docs/RELEASE_VERIFICATION.md` (NEW FILE)

Create documentation for users to verify artifact signatures:
```markdown
# Verifying Zajel Release Artifacts

All Zajel release artifacts are signed using [Sigstore](https://www.sigstore.dev/) for supply chain security.

## Prerequisites

Install `cosign`:

```bash
# macOS
brew install cosign

# Linux
wget https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign

# Windows
# Download from https://github.com/sigstore/cosign/releases
```

## Verification

Each release artifact has a corresponding `.sigstore.json` bundle. Download both the artifact and the bundle:

```bash
# Example: Verify Android APK
wget https://github.com/zajel/zajel/releases/download/v1.0.0/zajel-1.0.0-android.apk
wget https://github.com/zajel/zajel/releases/download/v1.0.0/zajel-1.0.0-android.apk.sigstore.json

cosign verify-blob zajel-1.0.0-android.apk \
  --bundle zajel-1.0.0-android.apk.sigstore.json \
  --certificate-identity-regexp "^https://github.com/zajel/zajel/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

**Expected output:**
```
Verified OK
```

This confirms:
1. The artifact was built by the official Zajel GitHub repository
2. The build was triggered by a tag push (not a PR or manual workflow)
3. The signature is logged in the public Rekor transparency log

## Inspecting Provenance

View the SLSA provenance metadata:

```bash
gh attestation verify zajel-1.0.0-android.apk --owner zajel
```

This shows:
- Source commit SHA
- Workflow name and path
- Build environment (runner, timestamp)
- All inputs and dependencies

## Transparency Log

All signatures are recorded in the Rekor transparency log:

```bash
rekor-cli get --artifact zajel-1.0.0-android.apk
```

This provides a tamper-evident audit trail of all signing events.
```

### Phase 3: Bootstrap Signing Key Rotation

#### 1. `packages/server/src/crypto/signing.js`

**Lines 45-64** - Add support for key versioning:
```javascript
// BEFORE:
export async function importSigningKey(hexSeed) {
  const seed = hexToBytes(hexSeed);
  // ... PKCS8 wrapping ...
  return crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
}

// AFTER:
/**
 * Import an Ed25519 signing key with version metadata.
 * @param {string} hexSeed - 64-character hex string (32 bytes)
 * @param {string} version - Key version identifier (e.g., "v1", "v2")
 * @returns {Promise<{key: CryptoKey, version: string}>}
 */
export async function importSigningKeyWithVersion(hexSeed, version = 'v1') {
  const seed = hexToBytes(hexSeed);

  // PKCS8 prefix for Ed25519: ASN.1 wrapper around the 32-byte seed
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);

  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  return { key, version };
}

// Keep legacy function for backward compatibility
export async function importSigningKey(hexSeed) {
  const result = await importSigningKeyWithVersion(hexSeed, 'v1');
  return result.key;
}
```

**Lines 67-77** - Add versioned signing function:
```javascript
// NEW FUNCTION (add after signPayload):
/**
 * Sign a UTF-8 string payload with key version metadata.
 * @param {{key: CryptoKey, version: string}} keyWithVersion
 * @param {string} payload - UTF-8 string to sign
 * @returns {Promise<{signature: string, version: string}>}
 */
export async function signPayloadWithVersion(keyWithVersion, payload) {
  const data = new TextEncoder().encode(payload);
  const signatureBytes = await crypto.subtle.sign('Ed25519', keyWithVersion.key, data);
  return {
    signature: bytesToBase64(signatureBytes),
    version: keyWithVersion.version,
  };
}
```

#### 2. `packages/server/src/index.js`

**Lines 117-126** - Update bootstrap response signing to include version:
```javascript
// BEFORE:
if (env.BOOTSTRAP_SIGNING_KEY) {
  try {
    const key = await importSigningKey(env.BOOTSTRAP_SIGNING_KEY);
    headers['X-Bootstrap-Signature'] = await signPayload(key, body);
  } catch (e) {
    console.error('Failed to sign bootstrap response:', e);
  }
}

// AFTER:
if (env.BOOTSTRAP_SIGNING_KEY) {
  try {
    // Support multiple keys for rotation: PRIMARY and SECONDARY
    const primaryKey = await importSigningKeyWithVersion(
      env.BOOTSTRAP_SIGNING_KEY,
      env.BOOTSTRAP_KEY_VERSION || 'v1'
    );

    const signResult = await signPayloadWithVersion(primaryKey, body);
    headers['X-Bootstrap-Signature'] = signResult.signature;
    headers['X-Bootstrap-Key-Version'] = signResult.version;

    // During rotation period, sign with both keys
    if (env.BOOTSTRAP_SIGNING_KEY_SECONDARY) {
      const secondaryKey = await importSigningKeyWithVersion(
        env.BOOTSTRAP_SIGNING_KEY_SECONDARY,
        env.BOOTSTRAP_KEY_VERSION_SECONDARY || 'v2'
      );
      const secondaryResult = await signPayloadWithVersion(secondaryKey, body);
      headers['X-Bootstrap-Signature-Secondary'] = secondaryResult.signature;
      headers['X-Bootstrap-Key-Version-Secondary'] = secondaryResult.version;
    }
  } catch (e) {
    console.error('Failed to sign bootstrap response:', e);
  }
}
```

#### 3. `packages/server/wrangler.jsonc`

**Add comment documenting new secrets** (after line 75):
```jsonc
// NEW COMMENT (add at end of file before closing brace):
  // Bootstrap signing key rotation:
  // - BOOTSTRAP_SIGNING_KEY: Primary key (hex-encoded Ed25519 seed)
  // - BOOTSTRAP_KEY_VERSION: Version identifier (e.g., "v1", "v2")
  // - BOOTSTRAP_SIGNING_KEY_SECONDARY: Secondary key during rotation (optional)
  // - BOOTSTRAP_KEY_VERSION_SECONDARY: Secondary key version (optional)
  //
  // Rotation procedure:
  // 1. Generate new key: node scripts/generate-bootstrap-keys.mjs
  // 2. Store as BOOTSTRAP_SIGNING_KEY_SECONDARY with version "v2"
  // 3. Deploy and wait for app clients to update their key list
  // 4. Promote secondary to primary: swap PRIMARY <- SECONDARY
  // 5. Remove SECONDARY secrets
```

#### 4. `packages/app/lib/core/crypto/bootstrap_verifier.dart`

**Lines 14-17** - Support multiple keys with versions:
```dart
// BEFORE:
static const _productionPublicKey =
    'attUirGAvR2WHcjz00q9lZoQTkWw5QmzJVM0waXwlWQ=';
static const _qaPublicKey = 'aT6HRI0epsGWdhIX2E2I0h/j/h/9ravxrjl09qnGc/A=';

// AFTER:
/// Map of key versions to public keys.
/// Multiple keys are supported during rotation periods.
static const _productionPublicKeys = {
  'v1': 'attUirGAvR2WHcjz00q9lZoQTkWw5QmzJVM0waXwlWQ=',
  // Add v2 key during rotation:
  // 'v2': '<new_public_key_base64>',
};

static const _qaPublicKeys = {
  'v1': 'aT6HRI0epsGWdhIX2E2I0h/j/h/9ravxrjl09qnGc/A=',
  // Add v2 key during rotation:
  // 'v2': '<new_public_key_base64>',
};
```

**Lines 22-37** - Update constructor to support multiple keys:
```dart
// BEFORE:
final SimplePublicKey _publicKey;
final Ed25519 _ed25519 = Ed25519();

BootstrapVerifier._(this._publicKey);

factory BootstrapVerifier() {
  final keyBase64 = Environment.isQA ? _qaPublicKey : _productionPublicKey;
  return BootstrapVerifier.withKey(keyBase64);
}

factory BootstrapVerifier.withKey(String publicKeyBase64) {
  final keyBytes = base64Decode(publicKeyBase64);
  final publicKey = SimplePublicKey(keyBytes, type: KeyPairType.ed25519);
  return BootstrapVerifier._(publicKey);
}

// AFTER:
final Map<String, SimplePublicKey> _publicKeys;
final Ed25519 _ed25519 = Ed25519();

BootstrapVerifier._(this._publicKeys);

factory BootstrapVerifier() {
  final keyMap = Environment.isQA ? _qaPublicKeys : _productionPublicKeys;
  return BootstrapVerifier.withKeys(keyMap);
}

factory BootstrapVerifier.withKeys(Map<String, String> publicKeyBase64Map) {
  final publicKeys = <String, SimplePublicKey>{};
  for (final entry in publicKeyBase64Map.entries) {
    final keyBytes = base64Decode(entry.value);
    publicKeys[entry.key] = SimplePublicKey(keyBytes, type: KeyPairType.ed25519);
  }
  return BootstrapVerifier._(publicKeys);
}

/// For testing: create verifier with a single key (backward compatible)
factory BootstrapVerifier.withKey(String publicKeyBase64) {
  return BootstrapVerifier.withKeys({'v1': publicKeyBase64});
}
```

**Lines 40-75** - Update verify function to support versioned signatures:
```dart
// BEFORE:
Future<bool> verify(String responseBody, String signatureBase64) async {
  try {
    final signatureBytes = base64Decode(signatureBase64);
    final bodyBytes = Uint8List.fromList(utf8.encode(responseBody));

    final signature = Signature(
      signatureBytes,
      publicKey: _publicKey,
    );

    final isValid = await _ed25519.verify(bodyBytes, signature: signature);
    if (!isValid) return false;

    // Check timestamp freshness
    final json = jsonDecode(responseBody) as Map<String, dynamic>;
    final timestamp = json['timestamp'] as int?;
    if (timestamp == null) return false;

    final responseTime = DateTime.fromMillisecondsSinceEpoch(timestamp);
    final age = DateTime.now().difference(responseTime).abs();
    return age <= maxAge;
  } catch (e) {
    logger.warning('BootstrapVerifier',
        'Signature verification threw an exception: $e');
    return false;
  }
}

// AFTER:
/// Verify the signature and freshness of a bootstrap response.
///
/// Supports versioned signatures for key rotation. If [keyVersion] is provided,
/// only that key will be tried. Otherwise, all configured keys are attempted.
///
/// Returns `true` if:
/// 1. The Ed25519 signature over [responseBody] is valid for any known key
/// 2. The `timestamp` field in the JSON is within [maxAge]
Future<bool> verify(
  String responseBody,
  String signatureBase64, {
  String? keyVersion,
}) async {
  try {
    final signatureBytes = base64Decode(signatureBase64);
    final bodyBytes = Uint8List.fromList(utf8.encode(responseBody));

    // If version specified, try only that key
    if (keyVersion != null) {
      final publicKey = _publicKeys[keyVersion];
      if (publicKey == null) {
        logger.warning('BootstrapVerifier',
            'Unknown key version: $keyVersion');
        return false;
      }

      return await _verifyWithKey(bodyBytes, signatureBytes, publicKey, responseBody);
    }

    // Otherwise, try all keys until one succeeds
    for (final publicKey in _publicKeys.values) {
      final isValid = await _verifyWithKey(bodyBytes, signatureBytes, publicKey, responseBody);
      if (isValid) return true;
    }

    logger.warning('BootstrapVerifier',
        'Signature did not match any known public key');
    return false;
  } catch (e) {
    logger.warning('BootstrapVerifier',
        'Signature verification threw an exception: $e');
    return false;
  }
}

/// Internal helper to verify signature with a specific key.
Future<bool> _verifyWithKey(
  Uint8List bodyBytes,
  List<int> signatureBytes,
  SimplePublicKey publicKey,
  String responseBody,
) async {
  final signature = Signature(signatureBytes, publicKey: publicKey);

  final isValid = await _ed25519.verify(bodyBytes, signature: signature);
  if (!isValid) return false;

  // Check timestamp freshness (replay protection)
  final json = jsonDecode(responseBody) as Map<String, dynamic>;
  final timestamp = json['timestamp'] as int?;
  if (timestamp == null) return false;

  final responseTime = DateTime.fromMillisecondsSinceEpoch(timestamp);
  final age = DateTime.now().difference(responseTime).abs();
  return age <= maxAge;
}
```

#### 5. `packages/app/lib/core/network/bootstrap_client.dart` (or wherever bootstrap responses are consumed)

Update the call site to pass key version from response headers:
```dart
// Assuming bootstrap client code looks like this:
final response = await http.get(Uri.parse('$bootstrapUrl/servers'));
final signature = response.headers['x-bootstrap-signature'];
final keyVersion = response.headers['x-bootstrap-key-version'];

// BEFORE:
final isValid = await verifier.verify(response.body, signature);

// AFTER:
final isValid = await verifier.verify(
  response.body,
  signature,
  keyVersion: keyVersion,
);
```

#### 6. `scripts/rotate-bootstrap-keys.mjs` (NEW FILE)

Create a script to automate key rotation:
```javascript
#!/usr/bin/env node

/**
 * Rotate bootstrap signing keys with zero-downtime.
 *
 * Usage:
 *   node scripts/rotate-bootstrap-keys.mjs [--env=production|qa]
 *
 * Steps:
 * 1. Generate a new Ed25519 keypair
 * 2. Display instructions to store as SECONDARY key in Cloudflare Workers
 * 3. Display instructions to add new public key to Flutter app
 * 4. Wait for confirmation that app update has been deployed
 * 5. Display instructions to promote SECONDARY to PRIMARY
 */

const args = process.argv.slice(2);
const env = args.find((a) => a.startsWith('--env='))?.split('=')[1] || 'production';

console.log(`=== Bootstrap Key Rotation (${env}) ===\n`);

// Generate new keypair
const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

const privateKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
);
const seed = privateKeyBytes.slice(-32);
const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

const publicKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey('raw', keyPair.publicKey)
);
const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

console.log('Step 1: Store the new SECONDARY key in Cloudflare Workers\n');
console.log('  wrangler secret put BOOTSTRAP_SIGNING_KEY_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log(`  Then paste: ${seedHex}\n`);
console.log('  wrangler secret put BOOTSTRAP_KEY_VERSION_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log('  Then paste: v2\n');

console.log('Step 2: Add new public key to Flutter app\n');
console.log(`  Edit packages/app/lib/core/crypto/bootstrap_verifier.dart`);
console.log(`  Add to ${env === 'qa' ? '_qaPublicKeys' : '_productionPublicKeys'}:`);
console.log(`    'v2': '${publicKeyBase64}',\n`);

console.log('Step 3: Deploy app update and wait for user adoption\n');
console.log('  - Build and release new app version with v2 key');
console.log('  - Wait for sufficient user adoption (e.g., 1-2 weeks)');
console.log('  - Monitor logs to ensure no v1-only clients are being rejected\n');

console.log('Step 4: Promote v2 to primary\n');
console.log('  wrangler secret put BOOTSTRAP_SIGNING_KEY --env', env === 'qa' ? 'qa' : '');
console.log(`  Then paste: ${seedHex}`);
console.log('  wrangler secret put BOOTSTRAP_KEY_VERSION --env', env === 'qa' ? 'qa' : '');
console.log('  Then paste: v2\n');

console.log('Step 5: Remove old v1 key (after grace period)\n');
console.log('  wrangler secret delete BOOTSTRAP_SIGNING_KEY_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log('  wrangler secret delete BOOTSTRAP_KEY_VERSION_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log('\nRotation complete!\n');
```

### Phase 4: Verification Client Library

#### 1. `packages/app/lib/core/crypto/cosign_verifier.dart` (NEW FILE)

Create a Dart library to verify Cosign signatures:
```dart
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import '../logging/logger_service.dart';

/// Verifies Sigstore/Cosign signatures for downloaded artifacts.
///
/// This uses the cosign CLI under the hood. For a pure Dart implementation,
/// we would need to:
/// 1. Parse the .sigstore.json bundle
/// 2. Verify the certificate chain against Fulcio root
/// 3. Verify the signature against the certificate's public key
/// 4. Check Rekor transparency log inclusion proof
///
/// For now, we shell out to cosign for simplicity.
class CosignVerifier {
  static const _tag = 'CosignVerifier';

  /// Expected GitHub repository for OIDC identity verification
  final String expectedRepository;

  /// Expected OIDC issuer (GitHub Actions)
  static const _expectedOidcIssuer = 'https://token.actions.githubusercontent.com';

  CosignVerifier({required this.expectedRepository});

  /// Verify a downloaded artifact using its Sigstore bundle.
  ///
  /// Returns `true` if:
  /// 1. The signature is cryptographically valid
  /// 2. The certificate's OIDC identity matches [expectedRepository]
  /// 3. The certificate was issued by Fulcio
  /// 4. The signature is logged in Rekor
  Future<bool> verifyArtifact(File artifactFile, File bundleFile) async {
    if (!await artifactFile.exists()) {
      logger.error(_tag, 'Artifact file does not exist: ${artifactFile.path}');
      return false;
    }

    if (!await bundleFile.exists()) {
      logger.error(_tag, 'Bundle file does not exist: ${bundleFile.path}');
      return false;
    }

    try {
      // Check if cosign is installed
      final whichResult = await Process.run('which', ['cosign']);
      if (whichResult.exitCode != 0) {
        logger.error(_tag, 'cosign is not installed. Cannot verify artifact.');
        return false;
      }

      // Run cosign verify-blob
      final result = await Process.run('cosign', [
        'verify-blob',
        artifactFile.path,
        '--bundle',
        bundleFile.path,
        '--certificate-identity-regexp',
        '^https://github.com/$expectedRepository/',
        '--certificate-oidc-issuer',
        _expectedOidcIssuer,
      ]);

      if (result.exitCode == 0) {
        logger.info(_tag, 'Artifact signature verified: ${artifactFile.path}');
        return true;
      } else {
        logger.warning(_tag,
            'Artifact signature verification failed: ${result.stderr}');
        return false;
      }
    } catch (e) {
      logger.error(_tag, 'Exception during signature verification: $e');
      return false;
    }
  }

  /// Download a release artifact and its Sigstore bundle from GitHub.
  ///
  /// Returns a tuple of (artifactFile, bundleFile) on success, or null on failure.
  Future<(File, File)?> downloadArtifact({
    required String releaseTag,
    required String artifactName,
    required Directory downloadDir,
  }) async {
    final artifactUrl =
        'https://github.com/$expectedRepository/releases/download/$releaseTag/$artifactName';
    final bundleUrl = '$artifactUrl.sigstore.json';

    try {
      // Download artifact
      final artifactResponse = await http.get(Uri.parse(artifactUrl));
      if (artifactResponse.statusCode != 200) {
        logger.error(_tag,
            'Failed to download artifact: ${artifactResponse.statusCode}');
        return null;
      }

      // Download bundle
      final bundleResponse = await http.get(Uri.parse(bundleUrl));
      if (bundleResponse.statusCode != 200) {
        logger.error(
            _tag, 'Failed to download bundle: ${bundleResponse.statusCode}');
        return null;
      }

      // Write to files
      final artifactFile = File('${downloadDir.path}/$artifactName');
      final bundleFile = File('${downloadDir.path}/$artifactName.sigstore.json');

      await artifactFile.writeAsBytes(artifactResponse.bodyBytes);
      await bundleFile.writeAsString(bundleResponse.body);

      logger.info(_tag, 'Downloaded artifact and bundle to ${downloadDir.path}');
      return (artifactFile, bundleFile);
    } catch (e) {
      logger.error(_tag, 'Exception during artifact download: $e');
      return null;
    }
  }

  /// Download and verify a release artifact in one call.
  Future<File?> downloadAndVerify({
    required String releaseTag,
    required String artifactName,
    required Directory downloadDir,
  }) async {
    final result = await downloadArtifact(
      releaseTag: releaseTag,
      artifactName: artifactName,
      downloadDir: downloadDir,
    );

    if (result == null) return null;

    final (artifactFile, bundleFile) = result;
    final isValid = await verifyArtifact(artifactFile, bundleFile);

    if (!isValid) {
      logger.error(_tag, 'Artifact verification failed, deleting files');
      await artifactFile.delete();
      await bundleFile.delete();
      return null;
    }

    return artifactFile;
  }
}
```

#### 2. `packages/app/lib/features/attestation/services/version_check_service.dart`

**Add method to verify update artifacts** (add at end of class):
```dart
// NEW METHOD (add at end of VersionCheckService class):
/// Download and verify a new app version using Sigstore.
///
/// This is intended for future auto-update functionality.
Future<File?> downloadVerifiedUpdate({
  required String version,
  required String platform,
}) async {
  final verifier = CosignVerifier(
    expectedRepository: 'zajel/zajel',
  );

  // Determine artifact name based on platform
  final artifactName = switch (platform) {
    'android' => 'zajel-$version-android.apk',
    'windows' => 'zajel-$version-windows.zip',
    'macos' => 'zajel-$version-macos.dmg',
    'linux' => 'zajel-$version-linux.tar.gz',
    _ => throw ArgumentError('Unsupported platform: $platform'),
  };

  final downloadDir = await getTemporaryDirectory();

  logger.info(_tag, 'Downloading verified update: $artifactName');

  return await verifier.downloadAndVerify(
    releaseTag: 'v$version',
    artifactName: artifactName,
    downloadDir: downloadDir,
  );
}
```

## Implementation Steps

### Phase 1: GitHub Actions Artifact Attestation (Week 1)

**Step 1.1**: Add OIDC permissions to release workflow
- Edit `.github/workflows/release.yml` line 481-483
- Add `id-token: write` and `attestations: write` permissions
- Commit: "feat(ci): add OIDC permissions for Sigstore attestation"

**Step 1.2**: Add attestation generation step
- Edit `.github/workflows/release.yml` after line 509
- Add `actions/attest-build-provenance@v2` step
- Commit: "feat(ci): generate SLSA provenance attestations"

**Step 1.3**: Test with a pre-release tag
- Create a test tag: `git tag v0.0.1-test.1 && git push origin v0.0.1-test.1`
- Verify workflow succeeds
- Check that attestations appear in GitHub UI (Actions > Attestations tab)

**Step 1.4**: Verify attestation using GitHub CLI
```bash
gh attestation verify <artifact> --owner zajel
```

### Phase 2: Cosign Integration (Week 2)

**Step 2.1**: Add Cosign installation step
- Edit `.github/workflows/release.yml` after attestation step
- Add `sigstore/cosign-installer@v3` action
- Commit: "feat(ci): install Cosign for artifact signing"

**Step 2.2**: Add Cosign signing and verification steps
- Add sign-blob loop for all artifacts
- Add verify-blob loop to confirm signatures
- Commit: "feat(ci): sign artifacts with Cosign keyless signing"

**Step 2.3**: Update release to include Sigstore bundles
- Edit line 516 to include `*.sigstore.json` files
- Commit: "feat(ci): publish Sigstore bundles with releases"

**Step 2.4**: Create verification documentation
- Create `docs/RELEASE_VERIFICATION.md`
- Include examples for each platform
- Commit: "docs: add Sigstore verification guide"

**Step 2.5**: Test with a pre-release tag
- Create test tag: `git tag v0.0.1-test.2 && git push origin v0.0.1-test.2`
- Download artifacts and bundles from release
- Verify using cosign CLI:
```bash
cosign verify-blob zajel-0.0.1-test.2-android.apk \
  --bundle zajel-0.0.1-test.2-android.apk.sigstore.json \
  --certificate-identity-regexp "^https://github.com/zajel/zajel/" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
```

### Phase 3: Bootstrap Signing Key Rotation (Week 3-4)

**Step 3.1**: Add key versioning to signing utilities
- Edit `packages/server/src/crypto/signing.js`
- Add `importSigningKeyWithVersion()` and `signPayloadWithVersion()`
- Keep legacy functions for backward compatibility
- Commit: "feat(server): add key versioning to bootstrap signing"

**Step 3.2**: Update bootstrap endpoint to use versioned signing
- Edit `packages/server/src/index.js` lines 117-126
- Add support for PRIMARY and SECONDARY keys
- Add version headers: `X-Bootstrap-Key-Version`
- Commit: "feat(server): support dual-key signing for rotation"

**Step 3.3**: Update Flutter verifier to support multiple keys
- Edit `packages/app/lib/core/crypto/bootstrap_verifier.dart`
- Change from single key to key map
- Update verify() to accept optional keyVersion parameter
- Add `_verifyWithKey()` helper
- Commit: "feat(app): support multiple bootstrap signing keys"

**Step 3.4**: Update bootstrap client to pass key version
- Find where bootstrap responses are consumed (likely in `bootstrap_client.dart` or similar)
- Extract `x-bootstrap-key-version` header
- Pass to `verifier.verify()`
- Commit: "feat(app): respect bootstrap key version header"

**Step 3.5**: Add key rotation documentation to wrangler.jsonc
- Edit `packages/server/wrangler.jsonc`
- Add comments explaining rotation procedure
- Commit: "docs(server): document bootstrap key rotation"

**Step 3.6**: Create rotation script
- Create `scripts/rotate-bootstrap-keys.mjs`
- Make executable: `chmod +x scripts/rotate-bootstrap-keys.mjs`
- Commit: "feat(scripts): add bootstrap key rotation tool"

**Step 3.7**: Test key rotation in QA environment
1. Generate new key: `node scripts/rotate-bootstrap-keys.mjs --env=qa`
2. Store as SECONDARY in Cloudflare:
   ```bash
   wrangler secret put BOOTSTRAP_SIGNING_KEY_SECONDARY --env qa
   wrangler secret put BOOTSTRAP_KEY_VERSION_SECONDARY --env qa  # paste "v2"
   ```
3. Update Flutter app with v2 key in `_qaPublicKeys`
4. Build test app and verify it accepts v2 signatures
5. Verify old app still accepts v1 signatures
6. Promote v2 to primary:
   ```bash
   wrangler secret put BOOTSTRAP_SIGNING_KEY --env qa  # paste new seed
   wrangler secret put BOOTSTRAP_KEY_VERSION --env qa  # paste "v2"
   ```
7. Verify both old and new apps work
8. Remove SECONDARY secrets:
   ```bash
   wrangler secret delete BOOTSTRAP_SIGNING_KEY_SECONDARY --env qa
   wrangler secret delete BOOTSTRAP_KEY_VERSION_SECONDARY --env qa
   ```

### Phase 4: Verification Client Library (Week 5)

**Step 4.1**: Create Cosign verifier library
- Create `packages/app/lib/core/crypto/cosign_verifier.dart`
- Implement `verifyArtifact()` using cosign CLI
- Implement `downloadArtifact()` for GitHub releases
- Implement `downloadAndVerify()` convenience method
- Add unit tests in `test/unit/crypto/cosign_verifier_test.dart`
- Commit: "feat(app): add Cosign verification library"

**Step 4.2**: Add pubspec dependencies
- Edit `packages/app/pubspec.yaml`
- Add `path_provider` if not already present (for getTemporaryDirectory)
- Run `flutter pub get`
- Commit: "feat(app): add dependencies for artifact verification"

**Step 4.3**: Integrate with version check service
- Edit `packages/app/lib/features/attestation/services/version_check_service.dart`
- Add `downloadVerifiedUpdate()` method
- Add unit tests in `test/unit/attestation/version_check_service_test.dart`
- Commit: "feat(app): add verified update download"

**Step 4.4**: Add integration test
- Create `test/integration/cosign_verification_test.dart`
- Test downloading and verifying a real release artifact
- Run: `flutter test test/integration/cosign_verification_test.dart`
- Commit: "test(app): add Cosign verification integration test"

**Step 4.5**: Document verification in app
- Update app documentation to explain Sigstore verification
- Add release notes explaining new verification features
- Commit: "docs(app): document Sigstore verification"

## Test Plan

### Unit Tests

#### Test 1: Attestation generation (GitHub Actions)
**Objective**: Verify that SLSA provenance attestations are generated correctly.

**Preconditions**:
- Release workflow has attestation step
- Workflow has `id-token: write` and `attestations: write` permissions

**Steps**:
1. Create a pre-release tag: `git tag v0.0.1-test.attestation && git push origin v0.0.1-test.attestation`
2. Wait for workflow to complete
3. Navigate to GitHub Actions > Attestations tab
4. Verify attestations exist for each artifact (APK, AAB, IPA, DMG, ZIP, TAR.GZ)

**Expected Result**:
- All artifacts have associated attestations
- Attestations contain:
  - Subject: artifact digest (SHA256)
  - Predicate: SLSA provenance v1.0
  - Build metadata: commit SHA, workflow name, runner environment

**Pass Criteria**: All attestations generated successfully, visible in GitHub UI.

---

#### Test 2: Cosign signature generation (GitHub Actions)
**Objective**: Verify that Cosign signs all artifacts and generates bundles.

**Preconditions**:
- Release workflow has Cosign signing step
- Workflow has `id-token: write` permission

**Steps**:
1. Create a pre-release tag: `git tag v0.0.1-test.cosign && git push origin v0.0.1-test.cosign`
2. Wait for workflow to complete
3. Download release artifacts from GitHub
4. Verify each artifact has a corresponding `.sigstore.json` bundle

**Expected Result**:
- Each artifact (APK, AAB, IPA, DMG, ZIP, TAR.GZ) has a `.sigstore.json` bundle
- Bundles contain:
  - Base64 signature
  - PEM-encoded certificate
  - Rekor log entry

**Pass Criteria**: All bundles present and correctly formatted.

---

#### Test 3: Cosign signature verification (CLI)
**Objective**: Verify that signatures can be verified using cosign CLI.

**Preconditions**:
- cosign v2.2.3+ installed
- Artifacts and bundles downloaded from a test release

**Steps**:
1. Run verification for Android APK:
   ```bash
   cosign verify-blob zajel-0.0.1-test.cosign-android.apk \
     --bundle zajel-0.0.1-test.cosign-android.apk.sigstore.json \
     --certificate-identity-regexp "^https://github.com/zajel/zajel/" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   ```
2. Repeat for all artifact types

**Expected Result**:
- Command exits with code 0
- Output: "Verified OK"

**Pass Criteria**: All artifacts verify successfully.

---

#### Test 4: Negative test - tampered artifact
**Objective**: Verify that verification fails for modified artifacts.

**Preconditions**:
- Valid artifact and bundle downloaded

**Steps**:
1. Download `zajel-0.0.1-test.cosign-android.apk` and bundle
2. Modify artifact: `echo "malicious" >> zajel-0.0.1-test.cosign-android.apk`
3. Run cosign verification

**Expected Result**:
- Command exits with non-zero code
- Output indicates signature mismatch

**Pass Criteria**: Verification fails as expected.

---

#### Test 5: Negative test - wrong OIDC identity
**Objective**: Verify that verification fails for artifacts from a different repository.

**Preconditions**:
- Artifact signed by a different GitHub repository (or manually signed with a test key)

**Steps**:
1. Run verification with expected identity:
   ```bash
   cosign verify-blob malicious.apk \
     --bundle malicious.apk.sigstore.json \
     --certificate-identity-regexp "^https://github.com/zajel/zajel/" \
     --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   ```

**Expected Result**:
- Command exits with non-zero code
- Output indicates identity mismatch

**Pass Criteria**: Verification fails for wrong identity.

---

#### Test 6: Bootstrap key rotation - dual signing
**Objective**: Verify that bootstrap server signs responses with both PRIMARY and SECONDARY keys during rotation.

**Preconditions**:
- Both `BOOTSTRAP_SIGNING_KEY` and `BOOTSTRAP_SIGNING_KEY_SECONDARY` set in Cloudflare Workers (QA environment)
- `BOOTSTRAP_KEY_VERSION=v1` and `BOOTSTRAP_KEY_VERSION_SECONDARY=v2`

**Steps**:
1. Make request to QA bootstrap: `curl -i https://signal.zajel.qa.hamzalabs.dev/servers`
2. Check response headers

**Expected Result**:
- Headers include:
  - `X-Bootstrap-Signature: <v1_signature>`
  - `X-Bootstrap-Key-Version: v1`
  - `X-Bootstrap-Signature-Secondary: <v2_signature>`
  - `X-Bootstrap-Key-Version-Secondary: v2`
- Both signatures are different (verify by comparing base64 values)

**Pass Criteria**: Both signatures present and different.

---

#### Test 7: Bootstrap key rotation - old app accepts v1
**Objective**: Verify that app with only v1 key accepts v1-signed responses.

**Preconditions**:
- Flutter app with `_qaPublicKeys = {'v1': '<v1_key>'}`
- QA bootstrap server using v1 as PRIMARY

**Steps**:
1. Run app in QA mode
2. Trigger bootstrap server list fetch
3. Check logs for verification success

**Expected Result**:
- Log: "Artifact signature verified" or similar success message
- App successfully fetches server list

**Pass Criteria**: App accepts v1 signature.

---

#### Test 8: Bootstrap key rotation - new app accepts v2
**Objective**: Verify that app with both v1 and v2 keys accepts v2-signed responses.

**Preconditions**:
- Flutter app with `_qaPublicKeys = {'v1': '<v1_key>', 'v2': '<v2_key>'}`
- QA bootstrap server using v2 as PRIMARY

**Steps**:
1. Run app in QA mode
2. Trigger bootstrap server list fetch
3. Check logs for verification success

**Expected Result**:
- Log indicates v2 signature verified
- App successfully fetches server list

**Pass Criteria**: App accepts v2 signature.

---

#### Test 9: Bootstrap key rotation - new app accepts v1 (backward compatibility)
**Objective**: Verify that app with both v1 and v2 keys still accepts v1-signed responses.

**Preconditions**:
- Flutter app with `_qaPublicKeys = {'v1': '<v1_key>', 'v2': '<v2_key>'}`
- QA bootstrap server using v1 as PRIMARY (simulating old server)

**Steps**:
1. Run app in QA mode
2. Trigger bootstrap server list fetch
3. Check logs for verification success

**Expected Result**:
- Log indicates v1 signature verified (fallback to v1 key)
- App successfully fetches server list

**Pass Criteria**: App accepts v1 signature even when v2 is configured.

---

#### Test 10: Flutter CosignVerifier - valid artifact
**Objective**: Verify that `CosignVerifier.verifyArtifact()` correctly validates a real artifact.

**Preconditions**:
- cosign installed on test machine or CI
- Valid artifact and bundle available

**Steps**:
1. Create unit test in `test/unit/crypto/cosign_verifier_test.dart`:
   ```dart
   test('verifyArtifact returns true for valid signature', () async {
     final verifier = CosignVerifier(expectedRepository: 'zajel/zajel');
     final artifact = File('test/fixtures/zajel-0.0.1-test-android.apk');
     final bundle = File('test/fixtures/zajel-0.0.1-test-android.apk.sigstore.json');

     final isValid = await verifier.verifyArtifact(artifact, bundle);

     expect(isValid, true);
   });
   ```
2. Run test: `flutter test test/unit/crypto/cosign_verifier_test.dart`

**Expected Result**:
- Test passes
- Logs show "Artifact signature verified"

**Pass Criteria**: Test passes.

---

#### Test 11: Flutter CosignVerifier - invalid artifact
**Objective**: Verify that `CosignVerifier.verifyArtifact()` rejects a tampered artifact.

**Preconditions**:
- cosign installed
- Tampered artifact and valid bundle

**Steps**:
1. Create unit test:
   ```dart
   test('verifyArtifact returns false for tampered artifact', () async {
     final verifier = CosignVerifier(expectedRepository: 'zajel/zajel');

     // Create tampered artifact
     final artifact = File('test/fixtures/zajel-0.0.1-test-android.apk');
     await artifact.writeAsBytes([0, 1, 2, 3]); // Invalid APK

     final bundle = File('test/fixtures/zajel-0.0.1-test-android.apk.sigstore.json');

     final isValid = await verifier.verifyArtifact(artifact, bundle);

     expect(isValid, false);
   });
   ```
2. Run test

**Expected Result**:
- Test passes
- Logs show "Artifact signature verification failed"

**Pass Criteria**: Test passes, verification correctly fails.

---

#### Test 12: Flutter CosignVerifier - download and verify
**Objective**: Verify that `downloadAndVerify()` successfully downloads and verifies a release artifact.

**Preconditions**:
- Valid test release tag published
- Network access to GitHub

**Steps**:
1. Create integration test:
   ```dart
   test('downloadAndVerify succeeds for valid release', () async {
     final verifier = CosignVerifier(expectedRepository: 'zajel/zajel');
     final downloadDir = await getTemporaryDirectory();

     final artifact = await verifier.downloadAndVerify(
       releaseTag: 'v0.0.1-test.cosign',
       artifactName: 'zajel-0.0.1-test.cosign-android.apk',
       downloadDir: downloadDir,
     );

     expect(artifact, isNotNull);
     expect(await artifact!.exists(), true);
   });
   ```
2. Run test

**Expected Result**:
- Test passes
- Artifact downloaded and verified
- File exists in temp directory

**Pass Criteria**: Test passes.

### Integration Tests

#### Test 13: End-to-end release verification
**Objective**: Verify the complete release pipeline from tag to verified artifact.

**Preconditions**:
- All Phase 1-4 changes deployed
- cosign installed locally

**Steps**:
1. Create production-like pre-release: `git tag v0.0.1-rc.1 && git push origin v0.0.1-rc.1`
2. Wait for workflow to complete
3. Download all artifacts and bundles from release
4. Verify each artifact:
   ```bash
   for artifact in zajel-0.0.1-rc.1-*; do
     echo "Verifying $artifact..."
     cosign verify-blob "$artifact" \
       --bundle "${artifact}.sigstore.json" \
       --certificate-identity-regexp "^https://github.com/zajel/zajel/" \
       --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
   done
   ```
5. Check GitHub Attestations tab

**Expected Result**:
- All artifacts verify successfully
- All attestations present in GitHub UI
- Rekor log entries exist for all signatures

**Pass Criteria**: All artifacts verified, no errors.

---

#### Test 14: Production key rotation
**Objective**: Verify key rotation works in production without breaking clients.

**Preconditions**:
- Production bootstrap server operational
- Flutter app deployed with v1 key

**Steps**:
1. Generate v2 key: `node scripts/rotate-bootstrap-keys.mjs --env=production`
2. Store as SECONDARY in production Cloudflare Workers
3. Verify production server responds with both signatures:
   ```bash
   curl -i https://signal.zajel.hamzalabs.dev/servers
   ```
4. Deploy new Flutter app version with v1 + v2 keys
5. Test old app (v1 only) still works
6. Test new app (v1 + v2) still works
7. Wait for 90% user adoption (check analytics)
8. Promote v2 to primary in Cloudflare Workers
9. Verify both old and new apps still work
10. Wait additional grace period (1 week)
11. Remove SECONDARY key
12. Verify new apps work, old apps continue to work (cached v1 still valid)

**Expected Result**:
- Zero downtime during rotation
- Both old and new app versions work at all stages
- After v1 removal, old apps eventually fail (expected after cache expiry)

**Pass Criteria**: Key rotation completes without breaking active clients.

### Performance Tests

#### Test 15: Attestation performance impact
**Objective**: Measure the time added to the release workflow by attestation generation.

**Steps**:
1. Run release workflow without attestation (baseline)
2. Measure total time
3. Run release workflow with attestation
4. Measure total time
5. Calculate difference

**Expected Result**:
- Attestation adds < 30 seconds to workflow
- No impact on artifact size

**Pass Criteria**: Acceptable performance overhead (< 5% of total workflow time).

---

#### Test 16: Cosign verification performance (Flutter app)
**Objective**: Measure the time to verify a downloaded artifact in the Flutter app.

**Steps**:
1. Create benchmark test:
   ```dart
   test('cosign verification performance', () async {
     final verifier = CosignVerifier(expectedRepository: 'zajel/zajel');
     final artifact = File('test/fixtures/zajel-0.0.1-test-android.apk');
     final bundle = File('test/fixtures/zajel-0.0.1-test-android.apk.sigstore.json');

     final stopwatch = Stopwatch()..start();
     await verifier.verifyArtifact(artifact, bundle);
     stopwatch.stop();

     print('Verification time: ${stopwatch.elapsedMilliseconds}ms');
     expect(stopwatch.elapsedMilliseconds, lessThan(5000)); // < 5 seconds
   });
   ```
2. Run on various devices (Android, iOS, desktop)

**Expected Result**:
- Verification completes in < 5 seconds on modern devices
- No UI blocking (should run on background isolate)

**Pass Criteria**: Acceptable verification time.

## Rollback Risk

### Risk Level: MEDIUM

### Rollback Scenarios

#### Scenario 1: Attestation generation fails
**Symptoms**: Release workflow fails at attestation step.

**Impact**: Releases cannot be published.

**Rollback**:
1. Remove attestation step from `.github/workflows/release.yml`
2. Force push to `main`: `git revert <commit> && git push origin main`
3. Re-run failed workflow

**Prevention**:
- Test attestation in a separate workflow before adding to release workflow
- Add `continue-on-error: true` to attestation step initially (remove after validation)

---

#### Scenario 2: Cosign signing fails
**Symptoms**: Release workflow fails at cosign step.

**Impact**: Releases cannot be published, or bundles are incomplete.

**Rollback**:
1. Remove cosign steps from workflow
2. Force push to `main`
3. Re-run failed workflow

**Prevention**:
- Test cosign in a separate workflow first
- Add `continue-on-error: true` initially
- Monitor cosign service status (https://status.sigstore.dev/)

---

#### Scenario 3: Bootstrap key rotation breaks clients
**Symptoms**: Apps cannot fetch server list, fail to connect.

**Impact**: Users cannot use the app.

**Rollback**:
1. Immediately revert to v1 key in Cloudflare Workers:
   ```bash
   wrangler secret put BOOTSTRAP_SIGNING_KEY --env production
   # Paste old v1 seed
   wrangler secret put BOOTSTRAP_KEY_VERSION --env production
   # Paste "v1"
   wrangler secret delete BOOTSTRAP_SIGNING_KEY_SECONDARY --env production
   wrangler secret delete BOOTSTRAP_KEY_VERSION_SECONDARY --env production
   ```
2. Verify apps can fetch server list again

**Prevention**:
- Always test rotation in QA environment first
- Deploy app update with new key before promoting on server
- Monitor error rates during rotation
- Keep old key as SECONDARY for extended grace period (2-4 weeks)

---

#### Scenario 4: Flutter CosignVerifier causes app crashes
**Symptoms**: App crashes when attempting to verify artifacts.

**Impact**: Auto-update feature broken, potential app crashes.

**Rollback**:
1. Disable auto-update feature in app configuration
2. Push hotfix that removes or disables `CosignVerifier` calls
3. Release emergency update

**Prevention**:
- Extensive unit and integration testing before release
- Feature flag for auto-update (disabled by default initially)
- Catch all exceptions in `CosignVerifier` and fail gracefully
- Monitor crash reports after rollout

---

#### Scenario 5: Rekor transparency log unavailable
**Symptoms**: Cosign verification fails with "failed to verify transparency log entry".

**Impact**: Verification fails for all artifacts, auto-update broken.

**Rollback**:
1. Add `--insecure-ignore-tlog=true` flag to cosign verification (NOT RECOMMENDED for production, temporary only)
2. Or: Disable verification temporarily via feature flag
3. Monitor Sigstore status page: https://status.sigstore.dev/

**Prevention**:
- Implement retry logic with exponential backoff
- Cache successful verification results
- Fail open (allow update without verification) with user warning if Rekor unavailable
- Monitor Sigstore service health

## Dependencies on Other Stories

### Story 021: TUF Role Hierarchy for Registry Trust
**Relationship**: The root key from the TUF hierarchy could anchor trust for Sigstore verification policies.

**Integration Point**: In Phase 3, the bootstrap key rotation could be governed by TUF root key signatures. Specifically:
- The list of valid bootstrap signing keys could be published in a TUF targets metadata file
- Key rotation requires a signature from the TUF root key
- Clients verify that new keys are authorized by the TUF root before accepting them

**Implementation Impact**:
- Phase 3 Step 3.3 would be extended to fetch the TUF targets metadata
- `BootstrapVerifier` would check that the key version is listed in the TUF metadata
- Key rotation script would generate TUF metadata updates

**Blocking**: No - Story 022 can be implemented independently. TUF integration is an enhancement.

---

### Story 023: Threshold Signing for Root Key Operations
**Relationship**: Root key operations that authorize Sigstore identity policies should require threshold signing.

**Integration Point**: In a TUF + Sigstore integration (with Story 021), the following operations would require threshold signatures:
- Adding a new bootstrap signing key to the TUF targets metadata
- Revoking a compromised bootstrap signing key
- Updating the list of trusted OIDC identities (e.g., allowing a new repository fork)

**Implementation Impact**:
- Key rotation script (`rotate-bootstrap-keys.mjs`) would generate threshold signature requests
- Multiple keyholders would need to approve key additions
- Reduces single point of failure for key rotation authorization

**Blocking**: No - Story 022 can be implemented independently. Threshold signing is an enhancement.

---

### Story 019: Client-Side Attestation Verification
**Relationship**: Phase 4 (Verification Client Library) overlaps with client-side attestation verification.

**Integration Point**: The `CosignVerifier` library created in Phase 4 could be extended to:
- Verify VPS server attestations (if they are Sigstore-signed in the future)
- Check that VPS server binaries were built by trusted CI pipelines

**Implementation Impact**:
- Story 019 could use the same `CosignVerifier` infrastructure
- Reduces code duplication

**Blocking**: No - Independent implementation.

---

### Current Project State
**Active Work**: Story 006 (App Attestation and Content Safety) is in progress. Story 022 is marked as LONG-TERM priority.

**Recommendation**: Implement Phase 1-2 (GitHub Actions attestation) immediately as low-hanging fruit. Phases 3-4 can be deferred until Story 021 is completed for a more integrated approach.

## Security Considerations

### Keyless Signing Assumptions
- **OIDC Trust**: Sigstore keyless signing relies on GitHub's OIDC token issuer. If GitHub's OIDC implementation is compromised, an attacker could obtain valid signing certificates.
- **Fulcio CA Trust**: Clients must trust the Fulcio root certificate. Fulcio is operated by the Sigstore project (funded by Linux Foundation).
- **Rekor Transparency**: Rekor provides tamper-evidence, not tamper-prevention. An attacker could still produce a valid signature, but it would be publicly logged.

### Platform-Specific Signing Interaction
- Android keystore, Windows cert, and iOS cert are STILL REQUIRED for app store distribution.
- Sigstore attestation is layered on top - it does not replace platform signing.
- Users verifying artifacts must check both:
  1. Platform signature (for app store legitimacy)
  2. Sigstore signature (for build provenance)

### Key Rotation Window
- During Phase 3 rotation, there is a window where both old and new keys are valid.
- An attacker who compromised the old key could still produce valid signatures during this period.
- Recommendation: Keep rotation window as short as possible (1-2 weeks).

### Cosign CLI Dependency
- Phase 4 relies on the cosign CLI being installed on user devices.
- This is NOT suitable for end-user auto-update (CLI not available on mobile).
- For mobile auto-update, a pure Dart implementation of Cosign verification is needed (future work).

## Future Enhancements

### 1. Pure Dart Sigstore Verification
Replace cosign CLI dependency with a native Dart implementation:
- Parse `.sigstore.json` bundles directly
- Verify X.509 certificate chain against Fulcio root
- Verify Ed25519/ECDSA signature against certificate public key
- Verify Rekor transparency log inclusion proof

**Benefit**: Enable auto-update verification on mobile devices without CLI dependency.

### 2. SLSA v3+ Compliance
Add build provenance for non-hermetic build steps:
- Track Flutter SDK version and source
- Track Android SDK and NDK versions
- Generate Software Bill of Materials (SBOM) for all dependencies

**Benefit**: Higher supply chain security posture.

### 3. Sigstore Signature Verification in VPS Servers
Sign VPS server binaries with Sigstore and verify in bootstrap server:
- VPS servers publish their own attestations during registration
- Bootstrap server checks that VPS binary was built by a trusted CI pipeline
- Prevents compromised VPS servers from joining federation

**Benefit**: Defense in depth for federation trust.

### 4. Policy-as-Code for OIDC Identities
Define a policy file (e.g., `sigstore-policy.yaml`) that specifies:
- Allowed GitHub repositories (e.g., `zajel/zajel`, `zajel/zajel-enterprise`)
- Allowed workflow names (e.g., `release.yml`)
- Allowed branch patterns (e.g., `refs/tags/v*`)

**Benefit**: Centralized governance of signing identities.

### 5. Automated Key Rotation Schedule
Implement a cron job or GitHub Actions workflow that:
- Generates a new bootstrap signing key every 90 days
- Automates the rotation procedure (currently manual)
- Publishes the new key to TUF metadata (if Story 021 implemented)

**Benefit**: Reduces compromise window, enforces rotation discipline.

## Appendix: Sigstore Architecture Overview

### Components

1. **Fulcio** (Certificate Authority)
   - Issues short-lived code signing certificates (10 minutes)
   - Binds certificates to OIDC identities (email, GitHub workflow identity, etc.)
   - Root certificate is distributed out-of-band (hardcoded in cosign CLI)

2. **Rekor** (Transparency Log)
   - Append-only cryptographic log (Merkle tree)
   - Records all signing events with timestamps
   - Provides inclusion proofs (proves a signature was logged at a specific time)
   - Publicly auditable: anyone can search for signed artifacts

3. **Cosign** (Signing Tool)
   - CLI tool for signing and verifying artifacts
   - Supports keyless signing (via Fulcio + Rekor)
   - Supports traditional key-based signing (out of scope for this story)
   - Generates "bundles" (signature + certificate + Rekor inclusion proof)

### Signing Flow

1. CI workflow requests OIDC token from GitHub Actions (`id-token: write` permission)
2. Cosign sends OIDC token to Fulcio
3. Fulcio verifies OIDC token and issues a short-lived certificate containing:
   - Public key (ephemeral, generated by cosign)
   - OIDC identity claims (repository, workflow, commit SHA)
   - Validity period (10 minutes)
4. Cosign signs the artifact with the ephemeral private key
5. Cosign uploads the signature + certificate to Rekor
6. Rekor returns an inclusion proof (signed timestamp)
7. Cosign bundles: signature + certificate + inclusion proof → `.sigstore.json`

### Verification Flow

1. User downloads artifact + `.sigstore.json` bundle
2. Cosign verifies:
   - Certificate chain: bundle cert → Fulcio root cert (hardcoded)
   - Signature: artifact digest matches signature, signed by cert's public key
   - OIDC claims: certificate's identity matches expected (repository, workflow)
   - Rekor inclusion: bundle's signature is logged in Rekor
3. If all checks pass: "Verified OK"

### Trust Model

**Trust Anchors**:
- Fulcio root certificate (hardcoded in cosign CLI)
- Rekor public key (hardcoded in cosign CLI)

**Threats Mitigated**:
- Secret exfiltration: No long-lived keys to exfiltrate
- Insider threats: Signing requires OIDC authentication (GitHub login)
- Supply chain attacks: Build provenance tied to source commit

**Threats NOT Mitigated**:
- Compromised CI pipeline: If attacker controls GitHub Actions runner, they can obtain valid OIDC tokens
- Compromised source code: Sigstore proves "this artifact was built from commit X", not "commit X is trustworthy"
- Fulcio/Rekor compromise: If Sigstore infrastructure is compromised, attacker could issue valid certificates

### GitHub Actions Integration

GitHub provides first-class Sigstore support via `actions/attest-build-provenance`:
- Automatically generates SLSA provenance metadata
- Automatically signs with keyless Sigstore
- Automatically uploads to Rekor
- No configuration required (just `id-token: write` permission)

This is simpler than using cosign directly, but less flexible (can only attest builds, not arbitrary artifacts).

## References

- [Sigstore Documentation](https://docs.sigstore.dev/)
- [GitHub Artifact Attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
- [SLSA Specification v1.0](https://slsa.dev/spec/v1.0/)
- [Cosign GitHub Repository](https://github.com/sigstore/cosign)
- [Fulcio GitHub Repository](https://github.com/sigstore/fulcio)
- [Rekor GitHub Repository](https://github.com/sigstore/rekor)
- [npm Provenance Documentation](https://docs.npmjs.com/generating-provenance-statements)
- [Sigstore Blog: Keyless Signing](https://blog.sigstore.dev/zero-friction-keyless-signing-with-github-actions-and-sigstore/)
- [OpenSSF Best Practices: Supply Chain Security](https://openssf.org/blog/2023/07/18/sigstore-in-github-attestations/)
