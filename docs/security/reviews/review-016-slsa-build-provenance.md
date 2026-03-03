# Review: Plan 016 - SLSA L2 Build Provenance

**Verdict: NEEDS REVISION**

The plan is well-structured and demonstrates a solid understanding of SLSA provenance concepts, Sigstore signing, and GitHub Actions workflow design. However, it contains several technical errors that would cause the implementation to fail at runtime. The most critical are an incorrect `base64-subjects` format for the SLSA generator, use of `sha256sum` on macOS runners where it does not exist, and dead code in the per-job hash outputs. These issues are all fixable without changing the overall architecture.

---

## Accuracy

### File Paths

| Referenced Path | Exists | Notes |
|---|---|---|
| `.github/workflows/release.yml` | Yes | Correct |
| `packages/app/android/app/build.gradle` | **No** | File is `build.gradle.kts` (Kotlin DSL). Plan states no changes needed so this is cosmetic, but the path is wrong. |
| `packages/server/src/durable-objects/server-registry-do.js` | Yes | Correct |
| `SECURITY.md` | Yes | Correct |

### Line Number References

All line references in the plan were verified against the actual `release.yml` (559 lines total). The "before" snippets match the source file exactly for:

- Android upload steps (lines 191-201): **Match**
- iOS upload step (lines 299-306): **Match**
- macOS upload step (lines 366-373): **Match**
- Windows upload step (lines 428-435): **Match**
- Linux upload step (lines 470-474): **Match**
- Release job header (lines 477-483): **Match**
- Create Release step (lines 511-520): **Match**
- Server registry build verification (lines 573-598): **Match**
- SECURITY.md future enhancements (lines 296-312): **Match**

The story's signing line references are also accurate:
- Android keystore signing: lines 162-180 (actual: 161-180, off by 1)
- Windows Authenticode: lines 397-414 (actual: 397-414, exact match)
- iOS certificate: lines 243-275 (actual: 243-277, close enough)

### Code Snippet Accuracy

All "before" YAML snippets are verbatim copies of the source file. No discrepancies found.

---

## Correctness Issues (Must Fix)

### 1. CRITICAL: `base64-subjects` format is wrong

**Location**: Plan Step 2, hash computation step

The plan generates `base64-subjects` as a base64-encoded JSON array:

```bash
HASHES=$(cat SHA256SUMS | awk '{print "{\"name\":\"" $2 "\",\"digest\":{\"sha256\":\"" $1 "\"}}"}' | jq -s -c . | base64 -w0)
```

The `slsa-framework/slsa-github-generator` `generator_generic_slsa3.yml` workflow expects `base64-subjects` to decode to plain `sha256sum` output format:

```
HASH  FILENAME
HASH  FILENAME
```

The correct implementation is:

```bash
HASHES=$(sha256sum * | base64 -w0)
echo "hashes=$HASHES" >> $GITHUB_OUTPUT
```

Reference: [slsa-github-generator generic builder README](https://github.com/slsa-framework/slsa-github-generator/blob/main/internal/builders/generic/README.md)

### 2. CRITICAL: `sha256sum` does not exist on macOS runners

**Location**: Plan Step 1.2 (iOS, macOS runner) and Step 1.3 (macOS build)

The plan uses `sha256sum` in the iOS and macOS build jobs. GitHub Actions `macos-latest` runners do not ship with GNU coreutils `sha256sum`. The macOS equivalent is `shasum -a 256`.

Options:
- Replace `sha256sum` with `shasum -a 256` in all macOS-runner steps.
- Or add `brew install coreutils` and use `gsha256sum`.

Note: The output format of `shasum -a 256` matches `sha256sum` (hash + two-space + filename), so it is a drop-in replacement.

Reference: [actions/runner-images issue #90](https://github.com/actions/virtual-environments/issues/90)

### 3. HIGH: Per-job hash outputs (Step 1) are dead code

The plan adds `outputs` and hash computation steps to all five build jobs (`build-android`, `build-ios`, `build-macos`, `build-windows`, `build-linux`), producing outputs like `apk_hash`, `aab_hash`, `ipa_hash`, etc. However, **no subsequent job references these outputs**. The `release` job recomputes all hashes from the aggregated artifacts directory via `sha256sum *`.

This is unnecessary complexity. Either:
- Remove Step 1 entirely (the release job already computes hashes correctly), or
- Actually use the per-job outputs in the release job for cross-verification.

### 4. MEDIUM: Windows PowerShell hash output format is backwards

**Location**: Plan Step 1.4

The plan writes:
```powershell
echo "zip=$(echo zajel-windows.zip) $zipHash" >> $env:GITHUB_OUTPUT
```

This produces `FILENAME HASH` format, which is the reverse of `sha256sum` output (`HASH  FILENAME`). Since these outputs are dead code (see issue 3), this does not cause a runtime failure, but if they were ever consumed the format mismatch would cause problems.

### 5. MEDIUM: `sign-hashes` job reconstructs SHA256SUMS instead of downloading from release

**Location**: Plan Step 4

The `sign-hashes` job downloads raw build artifacts and re-runs the rename + hash computation logic. This duplicates the logic in the `release` job and risks producing a different `SHA256SUMS` (e.g., if macOS produced a `.zip` instead of `.dmg`, or if optional artifacts are absent). A mismatch would mean the Sigstore signature does not match the SHA256SUMS uploaded to the release.

The `sign-hashes` job should instead download `SHA256SUMS` directly from the just-created GitHub release using `gh release download`, or the release job should upload SHA256SUMS as an artifact for the signing job to consume.

### 6. LOW: Release notes reference `SHA256SUMS.sigstore` before it exists

**Location**: Plan Step 2, updated "Create Release" step

The release notes template includes:
```yaml
files: |
  release-files/*
  SHA256SUMS
  SHA256SUMS.sigstore
```

At the time the `release` job runs, the `sign-hashes` job has not yet executed (it depends on `release`). The `SHA256SUMS` and `SHA256SUMS.sigstore` files do not exist yet. The `sign-hashes` job later uploads them to the release, but the `release` step itself would produce warnings about missing files.

The `files:` block should only contain `release-files/*`. The SHA256SUMS files are uploaded separately by the `sign-hashes` job.

### 7. LOW: iOS hash step uses glob in `[ -f ]` test

**Location**: Plan Step 1.2

```bash
if [ -f build/ios/ipa/*.ipa ]; then
```

The `[ -f ]` test does not expand globs correctly if multiple `.ipa` files exist (unlikely but possible). Use `ls build/ios/ipa/*.ipa 2>/dev/null` or a `find` command instead.

---

## Completeness

### Acceptance Criteria Coverage

| Acceptance Criterion | Covered in Plan | Covered in Test Plan |
|---|---|---|
| SHA256SUMS computed and uploaded | Yes (Step 2) | Yes (Test 1) |
| SLSA L2 provenance generated | Yes (Step 3) | Yes (Test 2) |
| Provenance uploaded as release asset | Yes (Step 3, `upload-assets: true`) | Yes (Test 2, 4) |
| SHA256SUMS signed with Sigstore cosign | Yes (Step 4) | Yes (Test 3) |
| Release notes include verification instructions | Yes (Step 2) | Not explicitly tested |
| `slsa-verifier` can verify provenance | Yes (architecture supports this) | Yes (Test 2, 6) |
| Provenance includes repo, commit, builder, workflow, Flutter version | Partially (Flutter version not explicitly in provenance subjects) | Yes (Test 4) |

### Missing Items

1. **No automated CI test**: All test cases are manual (push a test tag, download, verify). There is no automated verification step in CI that confirms provenance and signatures are valid before the release is marked as complete. Consider adding a `verify` job that runs after `provenance` and `sign-hashes`.

2. **No `jq` dependency check**: The hash computation step in the release job uses `jq` for JSON formatting. While `jq` is available on GitHub Actions Ubuntu runners, this is not called out as a dependency.

3. **No handling of skipped build jobs**: The release job uses `always()` and handles skipped platform builds. But the hash computation step in the release job runs `sha256sum *` on `release-files/`, which may have missing platform artifacts (e.g., if iOS build was skipped). The `SHA256SUMS` file will correctly only contain hashes for present artifacts, but the SLSA provenance `base64-subjects` will also reflect only the present artifacts. This is actually fine, but should be documented.

4. **Flutter version in provenance**: The acceptance criterion says provenance should include "Flutter version." SLSA provenance from `slsa-github-generator` captures workflow inputs and environment but does not automatically capture the `FLUTTER_VERSION` env var. The plan's Step 5 states "no changes needed -- existing FLUTTER_VERSION will be captured in provenance metadata automatically," but this is not accurate. The environment variable would need to be passed as an explicit workflow input or build parameter to appear in provenance.

5. **SECURITY.md and README.md updates**: The plan references these as "Documentation Updates Required" but they are not part of the implementation steps and have no corresponding test cases.

---

## Risks

### Addressed Risks

- **SLSA generator breaking changes**: Mitigated by pinning to `@v2.0.0`. Note: v2.1.0 is now available; consider using that instead.
- **Sigstore infrastructure outages**: Correctly identified as non-blocking (release still succeeds).
- **Large artifact set exceeding output limits**: Analyzed and found to be well within limits.
- **Rollback procedure**: Clearly documented with specific steps.

### Unaddressed Risks

1. **Race condition between `release` and `sign-hashes`/`provenance` jobs**: Both `provenance` and `sign-hashes` depend on `release` and upload assets to the same GitHub release. If both try to update the release simultaneously, there could be conflicts with the GitHub Release API.

2. **`softprops/action-gh-release@v1` is deprecated**: The action is at v2 now. Using v1 may have compatibility issues with newer GitHub API changes.

3. **Workflow-level permissions**: The plan adds `id-token: write` and `actions: read` permissions to new jobs but does not address whether the workflow's top-level `permissions` block (if any) needs updating. Currently the workflow has no top-level `permissions` block, which means it inherits the repository default. The new jobs declare their own permissions, which should work correctly with job-level permission declarations.

4. **`compile-generator: true` in provenance job**: The plan sets `compile-generator: true` which compiles the SLSA generator from source rather than using prebuilt binaries. This adds build time and introduces a supply-chain risk (compiling from source requires Go toolchain). The default (`false`) uses prebuilt, signed binaries and is more secure.

5. **Tag-triggered workflow and provenance source-tag verification**: The plan uses `upload-tag-name: ${{ github.ref_name }}` for provenance. The `slsa-verifier` verification in the test plan uses `--source-tag`. If the tag is later moved (e.g., force-pushed), the provenance would reference the original commit but the tag would point elsewhere. This is a known SLSA consideration but worth documenting.

---

## Recommended Changes

### Must Fix (Blocking)

1. **Fix `base64-subjects` format**: Replace the JSON/jq pipeline with `sha256sum * | base64 -w0` in the release job's hash computation step.

2. **Fix `sha256sum` on macOS**: Replace `sha256sum` with `shasum -a 256` in the iOS build job (Step 1.2) and macOS build job (Step 1.3), or install coreutils.

3. **Fix `sign-hashes` job**: Download SHA256SUMS from the GitHub release instead of reconstructing it, or upload SHA256SUMS as a GitHub Actions artifact from the release job for the signing job to consume.

4. **Remove SHA256SUMS/SHA256SUMS.sigstore from `release` job files**: These files do not exist when the release job runs. Let the `sign-hashes` job upload them separately.

### Should Fix (Recommended)

5. **Remove dead per-job hash outputs** (Step 1, sections 1.1-1.5): They add complexity without being consumed. If they serve a future purpose, document that purpose.

6. **Remove `compile-generator: true`**: Use prebuilt binaries (the default) for better security and faster execution.

7. **Update `softprops/action-gh-release` to `@v2`**: v1 is deprecated.

8. **Fix `build.gradle` path reference**: Correct to `build.gradle.kts`.

### Nice to Have

9. **Add automated verification job**: A `verify-provenance` job that downloads the release artifacts and runs `slsa-verifier` and `cosign verify-blob` automatically.

10. **Pin `sigstore/cosign-installer` to a specific commit hash** rather than `@v3` tag for supply-chain security consistency with the SLSA generator pinning approach.

11. **Consider upgrading SLSA generator to v2.1.0**: Current latest stable release.

12. **Add test case for release notes verification instructions**: The acceptance criteria require it but the test plan does not cover it.
