# Implementation Plan 016: SLSA L2 Build Provenance

## Summary

This plan implements SLSA Level 2 build provenance for all Flutter app releases (Android, iOS, macOS, Windows, Linux) distributed via GitHub Releases. Currently, the release workflow builds and publishes artifacts with code signing (Android keystore, Windows Authenticode) but produces no structured attestation linking artifacts to their source code, build environment, and build configuration. This gap creates a supply-chain attack surface: a compromised CI environment could produce tampered artifacts indistinguishable from legitimate releases.

The implementation adds:
1. SHA-256 hash computation for all release artifacts
2. SLSA provenance attestation generation using `slsa-framework/slsa-github-generator`
3. Sigstore cosign keyless signing of the hash file
4. Verification instructions in release notes
5. Build artifact outputs for provenance generation

This is an additive security enhancement with no breaking changes to existing release artifacts or workflows.

## Files to Modify

### 1. `.github/workflows/release.yml`

**Path**: `/home/meywd/zajel-ddos/.github/workflows/release.yml`

**Changes**:
- Add hash computation outputs to each platform build job
- Add hash aggregation and SHA256SUMS generation to release job
- Add SLSA provenance generation job
- Add Sigstore cosign signing job
- Update release job permissions and outputs
- Add verification instructions to release notes

### 2. `packages/app/build.gradle` (optional verification)

**Path**: `/home/meywd/zajel-ddos/packages/app/android/app/build.gradle`

**Changes**: No changes required (existing signing configuration is sufficient)

## Implementation Steps

### Step 1: Add Hash Computation Outputs to Build Jobs

Each platform build job needs to compute hashes of its artifacts and expose them as job outputs for the provenance generator.

#### 1.1 Android Build Job

**Location**: `.github/workflows/release.yml` lines 141-226

**Before** (lines 191-201):
```yaml
      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: packages/app/build/app/outputs/flutter-apk/app-release.apk

      - name: Upload AAB
        uses: actions/upload-artifact@v4
        with:
          name: android-aab
          path: packages/app/build/app/outputs/bundle/release/app-release.aab
```

**After**:
```yaml
      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: android-apk
          path: packages/app/build/app/outputs/flutter-apk/app-release.apk

      - name: Upload AAB
        uses: actions/upload-artifact@v4
        with:
          name: android-aab
          path: packages/app/build/app/outputs/bundle/release/app-release.aab

      - name: Compute artifact hashes
        id: hash
        run: |
          cd packages/app
          sha256sum build/app/outputs/flutter-apk/app-release.apk > apk.sha256
          sha256sum build/app/outputs/bundle/release/app-release.aab > aab.sha256
          echo "apk=$(cat apk.sha256)" >> $GITHUB_OUTPUT
          echo "aab=$(cat aab.sha256)" >> $GITHUB_OUTPUT
```

**Add job outputs** (after line 144):
```yaml
  build-android:
    runs-on: ubuntu-latest
    needs: [check-changes, test, changelog]
    if: needs.check-changes.outputs.app_changed == 'true'
    outputs:
      apk_hash: ${{ steps.hash.outputs.apk }}
      aab_hash: ${{ steps.hash.outputs.aab }}
    defaults:
      run:
        working-directory: packages/app
```

#### 1.2 iOS Build Job

**Location**: `.github/workflows/release.yml` lines 228-320

**Before** (lines 299-306):
```yaml
      - name: Upload iOS build
        uses: actions/upload-artifact@v4
        with:
          name: ios-build
          path: |
            packages/app/build/ios/ipa/*.ipa
            packages/app/zajel-ios.ipa
          if-no-files-found: ignore
```

**After**:
```yaml
      - name: Upload iOS build
        uses: actions/upload-artifact@v4
        with:
          name: ios-build
          path: |
            packages/app/build/ios/ipa/*.ipa
            packages/app/zajel-ios.ipa
          if-no-files-found: ignore

      - name: Compute artifact hash
        id: hash
        run: |
          cd packages/app
          if [ -f build/ios/ipa/*.ipa ]; then
            sha256sum build/ios/ipa/*.ipa > ios.sha256
          elif [ -f zajel-ios.ipa ]; then
            sha256sum zajel-ios.ipa > ios.sha256
          fi
          if [ -f ios.sha256 ]; then
            echo "ipa=$(cat ios.sha256)" >> $GITHUB_OUTPUT
          fi
```

**Add job outputs** (after line 230):
```yaml
  build-ios:
    runs-on: macos-latest
    needs: [check-changes, test, changelog]
    if: needs.check-changes.outputs.app_changed == 'true'
    outputs:
      ipa_hash: ${{ steps.hash.outputs.ipa }}
    defaults:
      run:
        working-directory: packages/app
```

#### 1.3 macOS Build Job

**Location**: `.github/workflows/release.yml` lines 322-374

**Before** (lines 366-373):
```yaml
      - name: Upload macOS build
        uses: actions/upload-artifact@v4
        with:
          name: macos-build
          path: |
            packages/app/zajel-macos.dmg
            packages/app/zajel-macos.zip
          if-no-files-found: ignore
```

**After**:
```yaml
      - name: Upload macOS build
        uses: actions/upload-artifact@v4
        with:
          name: macos-build
          path: |
            packages/app/zajel-macos.dmg
            packages/app/zajel-macos.zip
          if-no-files-found: ignore

      - name: Compute artifact hash
        id: hash
        run: |
          cd packages/app
          if [ -f zajel-macos.dmg ]; then
            sha256sum zajel-macos.dmg > macos.sha256
          elif [ -f zajel-macos.zip ]; then
            sha256sum zajel-macos.zip > macos.sha256
          fi
          if [ -f macos.sha256 ]; then
            echo "macos=$(cat macos.sha256)" >> $GITHUB_OUTPUT
          fi
```

**Add job outputs** (after line 324):
```yaml
  build-macos:
    runs-on: macos-latest
    needs: [check-changes, test, changelog]
    if: needs.check-changes.outputs.app_changed == 'true'
    outputs:
      macos_hash: ${{ steps.hash.outputs.macos }}
    defaults:
      run:
        working-directory: packages/app
```

#### 1.4 Windows Build Job

**Location**: `.github/workflows/release.yml` lines 376-436

**Before** (lines 428-435):
```yaml
      - name: Upload Windows build
        uses: actions/upload-artifact@v4
        with:
          name: windows-build
          path: |
            packages/app/zajel-windows.zip
            packages/app/build/windows/x64/runner/Release/*.msix
          if-no-files-found: ignore
```

**After**:
```yaml
      - name: Upload Windows build
        uses: actions/upload-artifact@v4
        with:
          name: windows-build
          path: |
            packages/app/zajel-windows.zip
            packages/app/build/windows/x64/runner/Release/*.msix
          if-no-files-found: ignore

      - name: Compute artifact hashes
        id: hash
        shell: pwsh
        run: |
          cd packages/app
          $zipHash = (Get-FileHash -Algorithm SHA256 zajel-windows.zip).Hash.ToLower()
          echo "zip=$(echo zajel-windows.zip) $zipHash" >> $env:GITHUB_OUTPUT
          $msixPath = Get-Item build/windows/x64/runner/Release/*.msix -ErrorAction SilentlyContinue
          if ($msixPath) {
            $msixHash = (Get-FileHash -Algorithm SHA256 $msixPath).Hash.ToLower()
            echo "msix=$(echo $msixPath.Name) $msixHash" >> $env:GITHUB_OUTPUT
          }
```

**Add job outputs** (after line 378):
```yaml
  build-windows:
    runs-on: windows-latest
    needs: [check-changes, test, changelog]
    if: needs.check-changes.outputs.app_changed == 'true'
    outputs:
      zip_hash: ${{ steps.hash.outputs.zip }}
      msix_hash: ${{ steps.hash.outputs.msix }}
    defaults:
      run:
        working-directory: packages/app
```

#### 1.5 Linux Build Job

**Location**: `.github/workflows/release.yml` lines 438-475

**Before** (lines 470-474):
```yaml
      - name: Upload Linux build
        uses: actions/upload-artifact@v4
        with:
          name: linux-build
          path: packages/app/zajel-linux.tar.gz
```

**After**:
```yaml
      - name: Upload Linux build
        uses: actions/upload-artifact@v4
        with:
          name: linux-build
          path: packages/app/zajel-linux.tar.gz

      - name: Compute artifact hash
        id: hash
        run: |
          cd packages/app
          sha256sum zajel-linux.tar.gz > linux.sha256
          echo "tarball=$(cat linux.sha256)" >> $GITHUB_OUTPUT
```

**Add job outputs** (after line 440):
```yaml
  build-linux:
    runs-on: ubuntu-latest
    needs: [check-changes, test, changelog]
    if: needs.check-changes.outputs.app_changed == 'true'
    outputs:
      tarball_hash: ${{ steps.hash.outputs.tarball }}
    defaults:
      run:
        working-directory: packages/app
```

### Step 2: Update Release Job with Hash Aggregation and Outputs

**Location**: `.github/workflows/release.yml` lines 477-521

**Before** (lines 477-483):
```yaml
  release:
    needs: [check-changes, test, changelog, build-android, build-ios, build-macos, build-windows, build-linux]
    if: ${{ always() && needs.check-changes.outputs.app_changed == 'true' && needs.test.result == 'success' && needs.changelog.result == 'success' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
```

**After**:
```yaml
  release:
    needs: [check-changes, test, changelog, build-android, build-ios, build-macos, build-windows, build-linux]
    if: ${{ always() && needs.check-changes.outputs.app_changed == 'true' && needs.test.result == 'success' && needs.changelog.result == 'success' }}
    runs-on: ubuntu-latest
    outputs:
      hashes: ${{ steps.hash.outputs.hashes }}
      version: ${{ needs.changelog.outputs.version }}
    permissions:
      contents: write
    steps:
```

**Add hash computation step** (after line 509, before "Create Release"):
```yaml
      - name: Compute artifact hashes
        id: hash
        env:
          VERSION: ${{ needs.changelog.outputs.version }}
        run: |
          cd release-files
          # Compute SHA256 hashes for all artifacts
          sha256sum * > SHA256SUMS
          cat SHA256SUMS

          # Create base64-encoded subjects for SLSA provenance
          # Format: sha256:HASH  FILENAME
          HASHES=$(cat SHA256SUMS | awk '{print "{\"name\":\"" $2 "\",\"digest\":{\"sha256\":\"" $1 "\"}}"}' | jq -s -c . | base64 -w0)
          echo "hashes=$HASHES" >> $GITHUB_OUTPUT
```

**Update "Create Release" step** (lines 511-520) to include SHA256SUMS:
```yaml
      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          name: Zajel v${{ needs.changelog.outputs.version }}
          body: |
            ${{ needs.changelog.outputs.changelog }}

            ## Verification

            This release includes SLSA L2 build provenance attestation. To verify:

            ```bash
            # Download artifacts and attestation
            VERSION="${{ needs.changelog.outputs.version }}"
            ARTIFACT="zajel-${VERSION}-android.apk"  # or any other artifact

            # Verify hash
            sha256sum -c SHA256SUMS --ignore-missing

            # Verify SLSA provenance (requires slsa-verifier)
            slsa-verifier verify-artifact "$ARTIFACT" \
              --provenance-path multiple.intoto.jsonl \
              --source-uri github.com/${{ github.repository }} \
              --source-tag ${{ github.ref_name }}

            # Verify Sigstore signature
            cosign verify-blob SHA256SUMS \
              --bundle SHA256SUMS.sigstore \
              --certificate-identity-regexp="^https://github.com/${{ github.repository }}/" \
              --certificate-oidc-issuer=https://token.actions.githubusercontent.com
            ```

            All artifacts are signed and built from commit `${{ github.sha }}` using Flutter ${{ env.FLUTTER_VERSION }}.
          files: |
            release-files/*
            SHA256SUMS
            SHA256SUMS.sigstore
          draft: false
          prerelease: ${{ contains(github.ref, 'alpha') || contains(github.ref, 'beta') || contains(github.ref, 'rc') }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Step 3: Add SLSA Provenance Generation Job

**Location**: Add new job after the `release` job (after line 539)

```yaml
  # Generate SLSA L2 provenance attestation
  provenance:
    needs: [release]
    if: needs.release.result == 'success'
    permissions:
      actions: read      # Required to read workflow path
      id-token: write    # Required for Sigstore keyless signing
      contents: write    # Required to upload attestation to release
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0
    with:
      base64-subjects: "${{ needs.release.outputs.hashes }}"
      upload-assets: true
      upload-tag-name: ${{ github.ref_name }}
      provenance-name: "multiple.intoto.jsonl"
      compile-generator: true
```

### Step 4: Add Sigstore Cosign Signing Job

**Location**: Add new job after the `provenance` job

```yaml
  # Sign SHA256SUMS with Sigstore cosign (keyless OIDC)
  sign-hashes:
    needs: [release]
    if: needs.release.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      id-token: write    # Required for Sigstore OIDC
      contents: write    # Required to upload signature to release
    steps:
      - name: Download release artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts

      - name: Reconstruct SHA256SUMS
        env:
          VERSION: ${{ needs.release.outputs.version }}
        run: |
          mkdir release-files
          cp artifacts/android-apk/app-release.apk "release-files/zajel-${VERSION}-android.apk"
          cp artifacts/android-aab/app-release.aab "release-files/zajel-${VERSION}-android.aab"
          find artifacts/ios-build -name "*.ipa" -exec cp {} "release-files/zajel-${VERSION}-ios.ipa" \; 2>/dev/null || true
          cp artifacts/macos-build/zajel-macos.dmg "release-files/zajel-${VERSION}-macos.dmg" 2>/dev/null || \
          cp artifacts/macos-build/zajel-macos.zip "release-files/zajel-${VERSION}-macos.zip" 2>/dev/null || true
          cp artifacts/windows-build/zajel-windows.zip "release-files/zajel-${VERSION}-windows.zip"
          find artifacts/windows-build -name "*.msix" -exec cp {} "release-files/zajel-${VERSION}-windows.msix" \; 2>/dev/null || true
          cp artifacts/linux-build/zajel-linux.tar.gz "release-files/zajel-${VERSION}-linux.tar.gz"
          cd release-files
          sha256sum * > SHA256SUMS

      - name: Install Sigstore cosign
        uses: sigstore/cosign-installer@v3
        with:
          cosign-release: 'v2.2.3'

      - name: Sign SHA256SUMS with Sigstore
        run: |
          cd release-files
          # Keyless signing using GitHub Actions OIDC
          cosign sign-blob --yes SHA256SUMS \
            --bundle SHA256SUMS.sigstore

      - name: Upload signature to release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            release-files/SHA256SUMS
            release-files/SHA256SUMS.sigstore
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Step 5: Update Workflow Environment Variables

**Location**: `.github/workflows/release.yml` line 8-10

**No changes needed** - existing `FLUTTER_VERSION` will be captured in provenance metadata automatically.

## Test Plan

### Test Case 1: Hash Generation and Verification

**Objective**: Verify that SHA256SUMS file is correctly generated and all artifacts can be verified.

**Steps**:
1. Trigger release workflow by pushing a test tag (e.g., `v1.9.9-test`)
2. Wait for workflow completion
3. Download all artifacts from the GitHub Release page
4. Download `SHA256SUMS` file
5. Run `sha256sum -c SHA256SUMS --ignore-missing` for each artifact
6. Verify all artifacts pass hash validation

**Expected Result**:
```
zajel-1.9.9-test-android.apk: OK
zajel-1.9.9-test-windows.zip: OK
zajel-1.9.9-test-linux.tar.gz: OK
...
```

**Failure Conditions**:
- Hash mismatch indicates file corruption or build inconsistency
- Missing hash for any artifact indicates incomplete hash computation step

### Test Case 2: SLSA Provenance Verification

**Objective**: Verify that SLSA provenance attestation is correctly generated and verifiable.

**Prerequisites**: Install `slsa-verifier` CLI tool:
```bash
go install github.com/slsa-framework/slsa-verifier/v2/cli/slsa-verifier@latest
```

**Steps**:
1. Download test release artifact (e.g., `zajel-1.9.9-test-android.apk`)
2. Download `multiple.intoto.jsonl` provenance file
3. Run verification:
```bash
slsa-verifier verify-artifact zajel-1.9.9-test-android.apk \
  --provenance-path multiple.intoto.jsonl \
  --source-uri github.com/meywd/zajel-ddos \
  --source-tag v1.9.9-test
```

**Expected Result**:
```
Verified signature against tlog entry index 123456789 at URL: https://rekor.sigstore.dev/api/v1/log/entries/...
Verified build using builder "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@refs/tags/v2.0.0" at commit abc123...
Verifying artifact zajel-1.9.9-test-android.apk: PASSED

PASSED: Verified SLSA provenance
```

**Failure Conditions**:
- "Signature verification failed" indicates provenance was tampered with
- "Source mismatch" indicates provenance references wrong repository/commit
- "Builder mismatch" indicates untrusted builder was used

### Test Case 3: Sigstore Cosign Signature Verification

**Objective**: Verify that SHA256SUMS file signature is verifiable using Sigstore.

**Prerequisites**: Install `cosign` CLI tool:
```bash
go install github.com/sigstore/cosign/v2/cmd/cosign@latest
```

**Steps**:
1. Download `SHA256SUMS` and `SHA256SUMS.sigstore` from test release
2. Run verification:
```bash
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore \
  --certificate-identity-regexp="^https://github.com/meywd/zajel-ddos/" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com
```

**Expected Result**:
```
Verified OK
```

**Failure Conditions**:
- "Signature verification failed" indicates signature was tampered with or expired
- "Certificate identity mismatch" indicates signature came from wrong repository
- "OIDC issuer mismatch" indicates signature not from GitHub Actions

### Test Case 4: Provenance Metadata Inspection

**Objective**: Verify that provenance includes all expected metadata fields.

**Steps**:
1. Download `multiple.intoto.jsonl` from test release
2. Parse the JSONL file:
```bash
cat multiple.intoto.jsonl | jq '.'
```
3. Verify presence of:
   - `subject[]` array with all artifact names and SHA256 digests
   - `predicate.buildType` = "https://slsa.dev/provenance/v1"
   - `predicate.builder.id` pointing to `slsa-github-generator`
   - `predicate.invocation.configSource.repository` = "github.com/meywd/zajel-ddos"
   - `predicate.invocation.configSource.ref` = tag name
   - `predicate.metadata.buildInvocationId` = GitHub workflow run ID

**Expected Result**: All fields present and correct.

**Failure Conditions**:
- Missing fields indicate incomplete provenance generation
- Incorrect values indicate workflow configuration error

### Test Case 5: Tampered Artifact Detection

**Objective**: Verify that hash verification detects tampered artifacts.

**Steps**:
1. Download a test artifact (e.g., `zajel-1.9.9-test-android.apk`)
2. Modify the artifact (add/remove a single byte):
```bash
echo "X" >> zajel-1.9.9-test-android.apk
```
3. Download `SHA256SUMS`
4. Run verification:
```bash
sha256sum -c SHA256SUMS --ignore-missing
```

**Expected Result**:
```
zajel-1.9.9-test-android.apk: FAILED
sha256sum: WARNING: 1 computed checksum did NOT match
```

**Failure Conditions**:
- If verification passes despite modification, hash computation is broken

### Test Case 6: Cross-Platform Build Verification

**Objective**: Verify all platforms produce valid provenance.

**Steps**:
1. Download artifacts for all platforms from test release
2. Download `multiple.intoto.jsonl`
3. Verify each artifact:
```bash
slsa-verifier verify-artifact zajel-1.9.9-test-android.apk --provenance-path multiple.intoto.jsonl --source-uri github.com/meywd/zajel-ddos --source-tag v1.9.9-test
slsa-verifier verify-artifact zajel-1.9.9-test-windows.zip --provenance-path multiple.intoto.jsonl --source-uri github.com/meywd/zajel-ddos --source-tag v1.9.9-test
slsa-verifier verify-artifact zajel-1.9.9-test-linux.tar.gz --provenance-path multiple.intoto.jsonl --source-uri github.com/meywd/zajel-ddos --source-tag v1.9.9-test
slsa-verifier verify-artifact zajel-1.9.9-test-macos.dmg --provenance-path multiple.intoto.jsonl --source-uri github.com/meywd/zajel-ddos --source-tag v1.9.9-test
slsa-verifier verify-artifact zajel-1.9.9-test-ios.ipa --provenance-path multiple.intoto.jsonl --source-uri github.com/meywd/zajel-ddos --source-tag v1.9.9-test
```

**Expected Result**: All artifacts verify successfully.

**Failure Conditions**:
- Any platform failing verification indicates hash computation issue in that build job

### Test Case 7: Workflow Permissions Validation

**Objective**: Verify that workflow has minimal required permissions.

**Steps**:
1. Review workflow run logs from test release
2. Verify no permission denied errors in `provenance` job
3. Verify no permission denied errors in `sign-hashes` job
4. Check GitHub Actions token scopes in workflow run details

**Expected Result**:
- `provenance` job: `actions: read`, `id-token: write`, `contents: write`
- `sign-hashes` job: `id-token: write`, `contents: write`
- No additional permissions granted

**Failure Conditions**:
- Permission denied errors indicate missing required permission
- Overly broad permissions (e.g., `write-all`) indicate security misconfiguration

## Rollback Risk

**Risk Level**: LOW

**Rationale**:
1. **Non-Breaking Changes**: All modifications are additive. Existing release artifacts (APK, AAB, IPA, MSIX, DMG, ZIP, TAR.GZ) are unchanged in format and signing.
2. **Independent Jobs**: The `provenance` and `sign-hashes` jobs run after the `release` job completes. If they fail, the release still succeeds with all original artifacts published.
3. **No User Impact**: End users who don't verify provenance are unaffected. The existing APK signature (Android) and Authenticode signature (Windows) remain the primary trust mechanisms.
4. **Workflow Failure Isolation**: If SLSA generator or Sigstore fails, only the attestation files are missing. The release can still be used (with reduced supply-chain assurance).

**Rollback Procedure**:
1. If provenance generation causes workflow failures:
   - Comment out the `provenance` and `sign-hashes` jobs
   - Push workflow update to main branch
   - Retag the release to trigger re-execution
2. If hash computation causes issues:
   - Remove the `outputs` blocks and hash computation steps from build jobs
   - Remove the hash aggregation step from release job
   - Keep SHA256SUMS generation but don't expose `hashes` output

**Potential Issues**:
1. **SLSA Generator Dependency**: The `slsa-framework/slsa-github-generator` action is a third-party dependency. If it has breaking changes or outages, provenance generation will fail. Mitigation: Pin to `@v2.0.0` tag (not `@main`).
2. **Sigstore Infrastructure**: Keyless signing relies on Sigstore Rekor transparency log and Fulcio CA. If these services are down, signing will fail. Mitigation: The `--yes` flag skips interactive prompts, and the job will fail gracefully without blocking the release.
3. **Large Artifact Set**: If the number of artifacts grows significantly, the base64-encoded subjects string may exceed GitHub Actions output size limits (1MB). Mitigation: Current release has ~7 artifacts (total hash string < 10KB), well below limits.

## Dependencies on Other Stories

### Story 012: Key Expiry/Crypto-Period Limits for Build Signing Keys

**Relationship**: Parallel trust mechanism

**Impact**: Story 012 implements build signature verification for VPS server registrations using Ed25519 signing keys stored in Durable Object storage. This story (016) implements SLSA provenance for client app builds distributed via GitHub Releases. Both stories address supply-chain security but for different distribution channels:

- **Story 012**: Server-to-server trust (VPS servers registering with bootstrap CF Worker)
- **Story 016**: Client-to-user trust (GitHub Release artifacts downloaded by end users)

**Coordination**: None required. The two systems are independent. However, if Story 012 implements key expiry metadata (e.g., `addedAt`, `expiresAt` fields), the same metadata structure could be applied to Sigstore certificate transparency logs for consistency.

**Priority**: Story 012 is marked THIS SPRINT (HIGH severity). Story 016 is MEDIUM-TERM (MEDIUM severity). No blocking dependency.

### Story 017: Transparency Log for Key Changes

**Relationship**: Complementary logging infrastructure

**Impact**: Story 017 proposes an append-only transparency log for trusted build signing key changes in Durable Object storage. Story 016 uses Sigstore's transparency log (Rekor) for provenance attestations. Both provide tamper-evident audit trails:

- **Story 017**: CF Worker internal audit log for VPS build key management
- **Story 016**: Public Sigstore Rekor log for client app build attestations

**Coordination**: If Story 017 implements a generic append-only log structure, the same pattern could be used to create a self-hosted transparency log for SLSA provenance (in addition to Sigstore Rekor). This would provide redundancy if Sigstore infrastructure becomes unavailable.

**Priority**: Story 017 is MEDIUM-TERM (MEDIUM severity). Story 016 is also MEDIUM-TERM. No blocking dependency, but implementing Story 017 first could provide infrastructure reuse.

**Future Enhancement**: If both stories are implemented, consider:
1. Logging provenance generation events (success/failure, artifact count, commit SHA) to Story 017's transparency log
2. Cross-referencing VPS build signatures (Story 012) with SLSA provenance (Story 016) in a unified audit dashboard

### No Direct Blocking Dependencies

This story can be implemented independently. The existing release workflow is fully functional, and SLSA provenance is an additive enhancement. However, implementing after Story 012 and 017 would allow for unified logging and key management patterns.

## Security Benefits

1. **Supply-Chain Attack Detection**: Provenance attestation links each artifact to its exact source commit, builder identity, and build environment. Any tampering post-build is detectable.
2. **Reproducible Builds Foundation**: SLSA provenance captures build parameters (Flutter version, platform, signing status), enabling future reproducible build verification.
3. **User Trust**: Security-conscious users and organizations can verify the integrity chain from source code to binary, meeting compliance requirements (SLSA L2, NIST SSDF).
4. **Incident Response**: If a release is suspected of compromise, provenance provides a forensic record to compare against known-good builds.
5. **Keyless Signing**: Sigstore OIDC-based signing eliminates long-lived signing key management risks. Identity is bound to GitHub Actions OIDC tokens.

## Performance Impact

**Workflow Duration**: Adds approximately 2-3 minutes to total release workflow time:
- Hash computation per platform: ~5 seconds
- SLSA provenance generation: ~1-2 minutes
- Sigstore cosign signing: ~30 seconds

**Artifact Size**: Adds ~10 KB to release assets:
- `SHA256SUMS`: ~1 KB (hash list)
- `SHA256SUMS.sigstore`: ~5 KB (signature bundle)
- `multiple.intoto.jsonl`: ~3-4 KB (provenance attestation)

**User Download Impact**: None. Verification files are optional downloads. Users who don't verify provenance are unaffected.

## Compliance and Standards

This implementation achieves **SLSA Level 2** certification:

| SLSA L2 Requirement | Implementation |
|---------------------|----------------|
| Source - Version controlled | Yes (GitHub repository) |
| Source - Verified history | Yes (signed commits optional, not required for L2) |
| Build - Scripted build | Yes (Flutter build in GitHub Actions workflow) |
| Build - Build service | Yes (GitHub Actions hosted runners) |
| Build - Build as code | Yes (workflow defined in `.github/workflows/release.yml`) |
| Provenance - Available | Yes (uploaded to GitHub Release as `multiple.intoto.jsonl`) |
| Provenance - Authenticated | Yes (signed by Sigstore) |
| Provenance - Service generated | Yes (generated by `slsa-github-generator`) |
| Provenance - Non-falsifiable | Yes (built by isolated GitHub Actions runner) |
| Common - Security | GitHub Actions security hardening applied |
| Common - Access | GitHub organization access controls |
| Common - Superusers | Repository admins (minimal set) |

**Future Path to SLSA L3**:
- Add hermetic builds (pinned dependencies, isolated build environment)
- Add reproducible builds verification
- Add two-party approval for releases

## Documentation Updates Required

1. **SECURITY.md** (line 296-312): Add SLSA provenance section:
```markdown
### Medium-term (Native Mobile Only)

1. **Certificate Pinning (Mobile)**: Implement on native Android/iOS builds
   - Android: Network Security Configuration or OkHttp CertificatePinner
   - iOS: TrustKit or custom URLSession delegate

2. **SLSA L2 Build Provenance** (Implemented): All GitHub Release artifacts include SLSA provenance attestation and Sigstore signatures. See release notes for verification instructions.
```

2. **README.md**: Add verification instructions link in releases section

3. **Release notes template**: Already included in Step 2 implementation above

## Additional Notes

1. **Windows Hash Computation**: PowerShell's `Get-FileHash` outputs uppercase hex by default. The `.ToLower()` call ensures consistency with GNU `sha256sum` output format.

2. **Conditional iOS Build**: iOS artifacts may not exist if signing secrets are unavailable. Hash computation checks for file existence before computing hashes.

3. **SLSA Generator Version Pinning**: Using `@v2.0.0` tag instead of `@main` ensures stable behavior. Upgrade to newer versions via explicit PR after testing.

4. **Sigstore Keyless Signing**: The `--yes` flag bypasses interactive prompts. Certificate identity is bound to GitHub Actions OIDC token, which includes repository name and workflow path.

5. **Multiple Artifacts in Single Provenance**: The SLSA generator supports multiple subjects via base64-encoded JSON array. This produces a single `multiple.intoto.jsonl` file covering all platforms.

6. **No macOS Code Signing**: The story notes macOS builds have no code signing in the current workflow. SLSA provenance provides supply-chain integrity even without platform-specific code signing.

## Implementation Checklist

- [ ] Add hash computation outputs to `build-android` job
- [ ] Add hash computation outputs to `build-ios` job
- [ ] Add hash computation outputs to `build-macos` job
- [ ] Add hash computation outputs to `build-windows` job
- [ ] Add hash computation outputs to `build-linux` job
- [ ] Update `release` job with outputs and hash aggregation step
- [ ] Add verification instructions to release notes template
- [ ] Add `provenance` job using SLSA GitHub generator
- [ ] Add `sign-hashes` job using Sigstore cosign
- [ ] Test with test tag release (e.g., `v1.9.9-test`)
- [ ] Verify SHA256SUMS generation
- [ ] Verify SLSA provenance with `slsa-verifier`
- [ ] Verify Sigstore signature with `cosign`
- [ ] Update SECURITY.md documentation
- [ ] Update README.md with verification instructions link
- [ ] Delete test release after verification
- [ ] Deploy to production release workflow

## Estimated Implementation Time

- Workflow modifications: 2 hours
- Testing and verification: 2 hours
- Documentation updates: 1 hour
- Code review and adjustments: 1 hour

**Total: 6 hours** (single developer, one sprint)
