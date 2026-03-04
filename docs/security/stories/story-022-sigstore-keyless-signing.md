# Story 022: Sigstore Keyless/Ephemeral Signing

## Priority: LONG-TERM
## Severity: MEDIUM
## Component: packages/server, .github/workflows

## Summary

The Zajel release pipeline and bootstrap server use long-lived Ed25519 keys for signing. The bootstrap signing key (`BOOTSTRAP_SIGNING_KEY`) is a static secret stored in Cloudflare Workers, and the Android/Windows/iOS build signing keys are stored as GitHub Actions secrets. These long-lived keys are vulnerable to compromise through secret exfiltration, insider threats, or supply chain attacks. Sigstore's keyless signing model eliminates long-lived key material by binding ephemeral signing keys to verifiable OIDC identities (e.g., GitHub Actions workflow identity), producing transparency log entries in Rekor that provide a public, tamper-evident audit trail.

## Current Behavior

### Bootstrap Response Signing

**Key storage** (`packages/server/wrangler.jsonc`): The `BOOTSTRAP_SIGNING_KEY` is a Cloudflare Workers secret containing a 64-character hex-encoded Ed25519 seed. This key has no expiration, no rotation schedule, and no audit trail of its use.

**Key generation** (`scripts/generate-bootstrap-keys.mjs`, lines 16-35): Keys are generated manually by running a Node.js script. The operator must manually store the private seed via `wrangler secret put BOOTSTRAP_SIGNING_KEY`. There is no provenance record of when or by whom the key was generated.

```javascript
// scripts/generate-bootstrap-keys.mjs:28-35
console.log('Private key seed (hex) -- store as Wrangler secret:');
console.log(`  wrangler secret put BOOTSTRAP_SIGNING_KEY`);
console.log(`  Then paste: ${seedHex}\n`);
console.log('Public key (base64) -- hardcode in Flutter app:');
console.log(`  ${publicKeyBase64}\n`);
console.log('IMPORTANT: Run this script twice (once for production, once for QA).');
console.log('Keep the private key seeds safe and never commit them.');
```

**Signing operation** (`packages/server/src/crypto/signing.js`, lines 27-58): The key is imported from the hex seed on every request that hits `GET /servers`. There is no key versioning, no rotation mechanism, and no way to determine which key version produced a given signature.

**Client verification** (`packages/app/lib/core/crypto/bootstrap_verifier.dart`, lines 14-16): Two static public keys are hardcoded (production and QA). Key rotation requires an app update.

### CI/CD Build Signing

**Android signing** (`.github/workflows/release.yml`, lines 161-180): A Java keystore is stored as `ANDROID_KEYSTORE_BASE64` with passwords in `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. These are long-lived GitHub Actions secrets with no rotation policy.

```yaml
# .github/workflows/release.yml:161-165
- name: Decode keystore
  if: ${{ env.ANDROID_KEYSTORE_BASE64 != '' }}
  env:
    ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
  run: echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > android/app/upload-keystore.jks
```

**Windows signing** (`.github/workflows/release.yml`, lines 385-402): A PFX certificate is stored as `WINDOWS_CERTIFICATE_BASE64` with `WINDOWS_CERTIFICATE_PASSWORD`. The signing uses `signtool.exe` with SHA256.

```yaml
# .github/workflows/release.yml:393-401
- name: Sign executable
  if: ${{ env.WINDOWS_CERTIFICATE_BASE64 != '' }}
  env:
    WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
  run: |
    $signtool = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits" -Recurse -Filter signtool.exe
    & $signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f "$env:RUNNER_TEMP\certificate.pfx" /p "$env:WINDOWS_CERTIFICATE_PASSWORD" "build\windows\x64\runner\Release\zajel.exe"
```

**iOS signing** (`.github/workflows/release.yml`, lines 231-254): Apple distribution certificate (`IOS_CERTIFICATE_BASE64`), provisioning profile, and App Store Connect API key are all long-lived secrets.

**No artifact attestation**: None of the build jobs produce Sigstore-compatible attestations or SLSA provenance metadata. There is no transparency log entry that records what was built, by whom, or from which source commit.

## Expected Behavior

Build artifacts and bootstrap responses should be signed using Sigstore's keyless signing model:

1. **CI builds**: Each GitHub Actions workflow run should obtain an ephemeral signing key backed by the workflow's OIDC identity token, sign the build artifacts, and publish the signature and certificate to the Rekor transparency log. Verification requires checking the Rekor entry and validating that the OIDC identity matches the expected GitHub repository and workflow.

2. **Bootstrap responses**: The Cloudflare Worker should use a short-lived signing key that is rotated automatically. While full Sigstore integration may not be feasible in the CF Workers runtime (no Fulcio CA access), the signing key should be ephemeral and tied to a verifiable identity.

3. **Verification**: Clients should be able to verify artifact provenance by checking Rekor transparency log entries, eliminating the need to trust a single hardcoded public key.

## Root Cause Analysis

The current signing model has several inherent weaknesses:

1. **Key lifetime**: The `BOOTSTRAP_SIGNING_KEY` has no expiration. Once generated, it remains valid indefinitely. The Android keystore and Windows certificate similarly have long lifetimes (years). The longer a key exists, the more opportunities for compromise.

2. **No provenance binding**: The signing keys are not tied to any verifiable identity. Anyone with access to the hex seed can produce valid signatures. There is no way to determine whether a signature was produced by the legitimate CI pipeline or by an attacker who exfiltrated the secret.

3. **Secret sprawl**: Signing secrets are spread across multiple systems: Cloudflare Workers secrets, GitHub Actions secrets, and potentially developer machines (for initial key generation). Each location is a potential compromise vector.

4. **No audit trail**: There is no public record of what was signed, when, or by whom. If a key is compromised, there is no way to distinguish legitimate signatures from malicious ones retroactively.

5. **GitHub Actions secret exposure**: GitHub Actions secrets are available to any workflow run triggered by events with write access. A compromised dependency or malicious PR (in some configurations) could potentially exfiltrate these secrets.

The signing flow in the CI pipeline (`.github/workflows/release.yml`) follows a linear path:

1. Tag push triggers the workflow (line 3-6).
2. Build jobs decode secrets from environment variables into files on the runner.
3. Platform-specific signing tools consume the key material.
4. Signed artifacts are uploaded to a GitHub Release (lines 499-508).
5. No attestation or transparency log entry is produced.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `scripts/generate-bootstrap-keys.mjs` | 1-35 | Manual key generation with no provenance |
| `packages/server/src/crypto/signing.js` | 27-58 | Long-lived key import and signing |
| `packages/server/src/index.js` | 92-101 | Bootstrap response signing with static key |
| `packages/app/lib/core/crypto/bootstrap_verifier.dart` | 14-16 | Hardcoded public keys |
| `.github/workflows/release.yml` | 161-180 | Android keystore decoding from secret |
| `.github/workflows/release.yml` | 385-402 | Windows certificate signing |
| `.github/workflows/release.yml` | 231-254 | iOS certificate and provisioning |
| `.github/workflows/release.yml` | 499-508 | Release creation without attestation |

## Reproduction Steps

1. Examine the GitHub Actions secrets configured for the repository -- these contain long-lived signing credentials for Android, Windows, and iOS.
2. Run `node scripts/generate-bootstrap-keys.mjs` -- observe that it produces a key pair with no expiration, no identity binding, and no transparency log entry.
3. Deploy the bootstrap server with `BOOTSTRAP_SIGNING_KEY` set.
4. Make a `GET /servers` request -- the `X-Bootstrap-Signature` header contains a signature that cannot be traced to any specific signing event or identity.
5. Trigger a release workflow -- observe that signed artifacts are produced without any SLSA provenance or Sigstore attestation.

## Impact Assessment

- **Key compromise window is unbounded**: Since keys have no expiration, a compromised key remains valid until manually rotated. An attacker who silently exfiltrates a key can produce valid signatures indefinitely.
- **No forensic capability**: Without transparency log entries, there is no way to audit which signatures were produced legitimately and which were produced by an attacker. Post-compromise analysis is impossible.
- **Supply chain vulnerability**: An attacker who compromises the CI pipeline (e.g., via a malicious dependency) can sign and release trojanized builds that appear legitimate to all verification checks.
- **Slow rotation**: Rotating the bootstrap signing key requires updating hardcoded values in client code and pushing an app update. This creates a strong disincentive to rotate keys, extending the compromise window.
- **No SLSA compliance**: The project cannot achieve any SLSA level without build provenance attestations.

## Proposed Fix

### Phase 1: GitHub Actions Artifact Attestation (Sigstore + SLSA)

Add Sigstore-based attestation to the release workflow using GitHub's built-in artifact attestation:

```yaml
- name: Attest build provenance
  uses: actions/attest-build-provenance@v2
  with:
    subject-path: 'release-files/*'
```

This produces SLSA v1.0 provenance attestations backed by Sigstore. Each attestation:
- Contains an ephemeral signing key obtained via the workflow's OIDC token from Fulcio.
- Is published to the Rekor transparency log with a timestamp.
- Binds the artifact to the specific GitHub repository, workflow, commit SHA, and runner identity.
- Requires no long-lived secrets.

### Phase 2: Cosign Integration for Artifact Verification

Add `cosign` verification to the release process:

```yaml
- name: Sign artifacts with cosign
  uses: sigstore/cosign-installer@v3

- name: Sign each artifact
  run: |
    for artifact in release-files/*; do
      cosign sign-blob --yes "$artifact" \
        --bundle "${artifact}.sigstore.json"
    done
  env:
    COSIGN_EXPERIMENTAL: 1
```

Publish `.sigstore.json` bundles alongside release artifacts so users can verify provenance.

### Phase 3: Bootstrap Signing Key Rotation

While full Sigstore keyless signing is not feasible in the Cloudflare Workers runtime (no Fulcio access), implement key rotation:

1. Support multiple public keys in `BootstrapVerifier` with version identifiers.
2. Add key version metadata to the `X-Bootstrap-Signature` header format.
3. Implement a key rotation script that generates a new key, deploys it to CF Workers, and publishes the public key to a well-known endpoint that clients fetch on startup.
4. Consider a "key discovery" endpoint signed by the root key (see Story 021) that lists currently valid signing keys.

### Phase 4: Verification Client Library

Create a shared verification library that:
1. Fetches and validates Sigstore bundles for downloaded artifacts.
2. Checks Rekor transparency log inclusion proofs.
3. Validates OIDC identity claims (repository, workflow, ref).
4. Can be used by the Flutter app for auto-update verification and by users for manual verification.

## Acceptance Criteria

- [ ] Release workflow produces SLSA provenance attestations for all build artifacts.
- [ ] Attestations are published to the Rekor transparency log.
- [ ] Each attestation binds the artifact to the source commit, workflow, and repository.
- [ ] Cosign bundles (`.sigstore.json`) are published alongside release artifacts.
- [ ] Users can verify artifact provenance using `cosign verify-blob`.
- [ ] Bootstrap signing key supports rotation without requiring app updates.
- [ ] Key rotation events are logged and auditable.
- [ ] No new long-lived signing keys are introduced.
- [ ] Platform-specific signing (Android keystore, Windows cert, iOS cert) remains in place for app store requirements, with Sigstore attestation layered on top.

## Test Requirements

- **CI pipeline tests**: Verify that the release workflow produces valid attestations by running a test release with a pre-release tag.
- **Cosign verification tests**: Verify that published bundles can be validated with `cosign verify-blob --certificate-identity` and `--certificate-oidc-issuer` flags.
- **Rekor inclusion tests**: Verify that transparency log entries exist for each signed artifact.
- **Key rotation tests**: Verify that bootstrap clients accept responses signed with both old and new keys during a rotation window.
- **Negative tests**: Verify that artifacts signed by an unauthorized identity (wrong repository, wrong workflow) are rejected.

## Dependencies

- Story 021 (TUF Role Hierarchy) -- The root key from the TUF hierarchy could anchor trust for Sigstore verification policies (which OIDC identities are trusted).
- Story 023 (Threshold Signing) -- Root key operations that authorize Sigstore identity policies should require threshold signing.

## Research References

- [Sigstore Documentation](https://docs.sigstore.dev/) -- Overview of Fulcio (certificate authority), Rekor (transparency log), and Cosign (signing/verification tool).
- [GitHub Artifact Attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations) -- GitHub's built-in Sigstore integration for GitHub Actions.
- [SLSA Specification](https://slsa.dev/spec/v1.0/) -- Supply chain Levels for Software Artifacts, defines provenance requirements.
- [cosign](https://github.com/sigstore/cosign) -- Container and blob signing tool using Sigstore.
- [Fulcio](https://github.com/sigstore/fulcio) -- Free certificate authority for code signing, issues short-lived certificates bound to OIDC identities.
- [Rekor](https://github.com/sigstore/rekor) -- Tamper-evident transparency log for recording signing events.
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements) -- Real-world example of Sigstore keyless signing in a package registry.
- [Sigstore for Python (PEP 740)](https://peps.python.org/pep-0740/) -- Attestation model for PyPI, relevant architectural reference.
