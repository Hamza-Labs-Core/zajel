# Story 016: SLSA L2 Build Provenance

## Priority: MEDIUM-TERM
## Severity: MEDIUM
## Component: .github/workflows/release.yml

## Summary

The release workflow builds Flutter apps for all platforms (Android, iOS, macOS, Windows, Linux) and publishes them as GitHub Release artifacts, but produces no structured SLSA (Supply-chain Levels for Software Artifacts) provenance metadata. While the Android build uses keystore signing and Windows uses certificate-based code signing, there is no build provenance attestation that links artifacts to their source code, build environment, and build configuration. An attacker who compromises the CI environment could produce tampered artifacts that are indistinguishable from legitimate releases.

## Current Behavior

**Release workflow** (`.github/workflows/release.yml`):

1. **Build steps** (lines 141-475): Each platform build (`build-android`, `build-ios`, `build-macos`, `build-windows`, `build-linux`) runs on GitHub Actions runners, installs Flutter, builds the app, and uploads artifacts.

2. **Signing**:
   - Android: Keystore-based APK signing (lines 162-180, `upload-keystore.jks` with `key.properties`)
   - Windows: Authenticode code signing with `signtool.exe` (lines 397-414)
   - iOS: Apple certificate + provisioning profile (lines 243-275)
   - macOS: No code signing in the workflow
   - Linux: No code signing

3. **Release creation** (lines 477-518): The `release` job downloads all artifacts, renames them with version suffix, and creates a GitHub Release via `softprops/action-gh-release@v1`.

4. **No hash computation**: The workflow does not compute SHA-256 hashes of the built artifacts.

5. **No provenance metadata**: There is no SLSA provenance JSON, no in-toto attestation, no Sigstore signing of the release artifacts.

6. **No artifact verification**: Users downloading from the GitHub Release page have no way to verify that the artifact was built from the tagged source commit by the official CI pipeline.

**Bootstrap server build verification** (`packages/server/src/durable-objects/server-registry-do.js`, lines 573-598):
The server registry already has infrastructure for `buildHash`, `buildSignature`, and `buildSigningKey` verification. This existing system verifies VPS server builds but does not cover client-side app builds distributed via GitHub Releases.

## Expected Behavior

1. Each build artifact should have a SHA-256 hash published alongside it.
2. A SLSA L2 provenance attestation should be generated, linking each artifact to:
   - Source repository and commit SHA
   - Build workflow file and trigger (tag push)
   - Builder identity (GitHub Actions)
   - Build parameters (Flutter version, platform, signing status)
3. Provenance should be signed using Sigstore (keyless signing via OIDC) and published as a GitHub Release asset.
4. Users and automated tools should be able to verify provenance against the artifact hash.

## Root Cause Analysis

The release workflow was designed for functional artifact distribution, not supply-chain security. Code signing (Android keystore, Windows Authenticode) provides end-user trust that the app comes from a known publisher, but does not prove the build was performed by authorized CI from a specific source commit.

SLSA provenance is a relatively recent standard (SLSA v1.0 released 2023) and the existing build signing system for VPS servers (`BuildVerifier`) was built independently of the SLSA framework.

## Affected Code

| File | Lines | Description |
|------|-------|-------------|
| `.github/workflows/release.yml` | 477-518 | Release job -- no hash or provenance generation |
| `.github/workflows/release.yml` | 141-475 | Platform build jobs -- no attestation |
| `packages/server/src/durable-objects/server-registry-do.js` | 573-598 | Existing build verification (VPS only, not app builds) |

## Reproduction Steps

1. Download any artifact from a GitHub Release page (e.g., `zajel-1.0.0-android.apk`).
2. Attempt to verify that this artifact was built from the tagged commit.
3. There is no provenance file, no hash file, and no signature file to verify against.
4. The only available verification is Android APK signature (proves publisher identity, not source provenance) and Windows Authenticode (same limitation).

## Impact Assessment

- **Supply-chain attack surface**: A compromised CI secret, compromised GitHub Actions runner, or compromised dependency could inject malicious code into the built artifacts. Without provenance, there is no auditable record of the build environment to detect such tampering.
- **User trust gap**: Security-conscious users and organizations cannot verify the integrity chain from source code to distributed binary.
- **Compliance**: SLSA L2 is increasingly required for security-critical software distribution. Projects targeting government or enterprise deployment need provenance attestation.
- **No rollback verification**: If a release is suspected of being compromised, there is no way to compare the build environment of the suspect release against known-good releases.

## Proposed Fix

### 1. Add hash computation step to release job

```yaml
- name: Compute artifact hashes
  run: |
    cd release-files
    sha256sum * > SHA256SUMS
    cat SHA256SUMS
```

### 2. Add SLSA provenance generation using `slsa-framework/slsa-github-generator`

```yaml
provenance:
  needs: [release]
  permissions:
    actions: read
    id-token: write
    contents: write
  uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0
  with:
    base64-subjects: "${{ needs.release.outputs.hashes }}"
    upload-assets: true
    upload-tag-name: ${{ github.ref_name }}
```

### 3. Compute hashes in each build job and pass to provenance generator

```yaml
# In each build job, after creating artifacts:
- name: Compute hashes
  id: hashes
  run: |
    HASH=$(sha256sum release-files/* | base64 -w0)
    echo "hashes=$HASH" >> $GITHUB_OUTPUT
```

### 4. Add verification instructions to release notes

```markdown
## Verification

Download `SHA256SUMS` and `multiple.intoto.jsonl` from this release.

```bash
# Verify hash
sha256sum -c SHA256SUMS

# Verify SLSA provenance
slsa-verifier verify-artifact zajel-1.0.0-android.apk \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/meywd/zajel \
  --source-tag v1.0.0
```
```

### 5. Sign SHA256SUMS with Sigstore cosign

```yaml
- name: Sign hashes with Sigstore
  uses: sigstore/cosign-installer@v3
- run: |
    cosign sign-blob --yes release-files/SHA256SUMS \
      --bundle release-files/SHA256SUMS.sigstore
```

## Acceptance Criteria

- [ ] `SHA256SUMS` file is computed for all release artifacts and uploaded as a release asset
- [ ] SLSA L2 provenance attestation is generated for all release artifacts using `slsa-github-generator`
- [ ] Provenance attestation is uploaded as a release asset (`.intoto.jsonl`)
- [ ] `SHA256SUMS` file is signed with Sigstore cosign (keyless OIDC) and the `.sigstore` bundle is uploaded
- [ ] Release notes include verification instructions
- [ ] `slsa-verifier` can successfully verify the provenance for each artifact
- [ ] The provenance includes: source repo, commit SHA, builder (GitHub Actions), workflow file path, Flutter version

## Test Requirements

1. **Hash verification**: Download artifacts from a test release, verify `sha256sum -c SHA256SUMS` passes
2. **Provenance verification**: Run `slsa-verifier` against each artifact and its provenance
3. **Sigstore verification**: Run `cosign verify-blob` against `SHA256SUMS` with the `.sigstore` bundle
4. **Tampered artifact detection**: Modify a single byte of an artifact, verify hash check fails

## Dependencies

- Related: Story 012 (Key Expiry) -- build signing keys for VPS are a parallel trust mechanism
- Related: Story 017 (Transparency Log) -- provenance metadata could be logged alongside key changes
- Depends on: None (this is additive to the existing release workflow)
