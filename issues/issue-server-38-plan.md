# Plan: Version comparison does not handle non-semver input

**Issue**: issue-server-38.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/crypto/attestation.js`

## Analysis

In `packages/server/src/crypto/attestation.js`, the `compareVersions` function (lines 182-193) assumes strict semver format:

```js
export function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const va = partsA[i] || 0;
    const vb = partsB[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
```

Issues:
1. `Number("3-beta")` returns `NaN`, and `NaN || 0` becomes `0`. So `"1.2.3-beta"` compares as `"1.2.0"`.
2. No validation that inputs are strings.
3. `"..."` produces `[NaN, NaN, NaN, NaN]` which all become `0`.
4. Non-string inputs like `null` or `123` would crash on `.split()`.

This function is called from `checkVersionPolicy` (lines 599-633) in `attestation-registry-do.js`:
- Line 610: `compareVersions(version, policy.minimum_version)`
- Line 621: `compareVersions(version, policy.recommended_version)`

Where `version` comes from the client's build token and `policy.*_version` comes from stored version policy.

## Fix Steps

1. **Add input validation** to `compareVersions` in `packages/server/src/crypto/attestation.js` (lines 182-193):

```js
export function compareVersions(a, b) {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  if (typeof a !== 'string' || typeof b !== 'string') {
    throw new Error('Version must be a string');
  }
  if (!semverRegex.test(a)) {
    throw new Error(`Invalid semver version format: "${a}"`);
  }
  if (!semverRegex.test(b)) {
    throw new Error(`Invalid semver version format: "${b}"`);
  }

  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (partsA[i] < partsB[i]) return -1;
    if (partsA[i] > partsB[i]) return 1;
  }
  return 0;
}
```

2. **Handle the thrown error in `checkVersionPolicy`** in `attestation-registry-do.js` (line 599). The `checkVersionPolicy` method should catch version format errors and treat them as a policy failure:

```js
checkVersionPolicy(version, policy) {
  // Check blocked list first (exact string match, no parsing needed)
  if (policy.blocked_versions && policy.blocked_versions.includes(version)) {
    return {
      blocked: true,
      status: 'blocked',
      reason: `Version ${version} has been blocked`,
    };
  }

  try {
    // Check minimum version
    if (policy.minimum_version && compareVersions(version, policy.minimum_version) < 0) {
      return {
        blocked: true,
        status: 'below_minimum',
        reason: `Version ${version} is below minimum required version ${policy.minimum_version}`,
      };
    }

    // Check if update is recommended
    if (policy.recommended_version && compareVersions(version, policy.recommended_version) < 0) {
      return { blocked: false, status: 'update_recommended' };
    }
  } catch (e) {
    // Invalid version format - reject the client
    return {
      blocked: true,
      status: 'invalid_version',
      reason: `Invalid version format: ${version}`,
    };
  }

  return { blocked: false, status: 'current' };
}
```

3. **Also validate version format in `handleSetVersions`** (attestation-registry-do.js line 537) to prevent storing invalid policy versions:

After line 562 (where `minimum_version` and `recommended_version` are extracted from the body), add:
```js
const semverRegex = /^\d+\.\d+\.\d+$/;
if (minimum_version && !semverRegex.test(minimum_version)) {
  return this.jsonResponse({ error: 'Invalid minimum_version format (expected X.Y.Z)' }, 400, corsHeaders);
}
if (recommended_version && !semverRegex.test(recommended_version)) {
  return this.jsonResponse({ error: 'Invalid recommended_version format (expected X.Y.Z)' }, 400, corsHeaders);
}
```

## Testing

- Test `compareVersions` with valid versions: `"1.0.0"` vs `"2.0.0"`, `"1.2.3"` vs `"1.2.3"`.
- Test with pre-release versions: `"1.2.3-beta"` should throw an error.
- Test with incomplete versions: `"1.2"` should throw an error.
- Test with non-string inputs: `null`, `undefined`, `123` should throw.
- Test with empty string should throw.
- Test `checkVersionPolicy` catches the error and returns `blocked: true`.
- Test `handleSetVersions` rejects invalid version formats.

## Risk Assessment

- **Low risk for normal usage**: Legitimate clients send proper semver versions. The validation only catches malformed input.
- **Breaking change**: If any client currently sends non-standard version strings (e.g., `"1.2.3-beta.1"`), they will now be rejected. Review client version formats before deploying.
- **Policy validation**: Adding validation to `handleSetVersions` prevents administrators from accidentally storing invalid version formats that would cause errors later.
