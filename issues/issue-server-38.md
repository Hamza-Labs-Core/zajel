# [LOW] Version comparison does not handle non-semver input

**Area**: Server
**File**: packages/server/src/crypto/attestation.js:182-193
**Type**: Bug

**Description**: The `compareVersions` function assumes strict semver format with exactly 3 numeric parts:
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
1. Non-numeric version parts (e.g., "1.2.3-beta") produce `NaN` from `Number()`, and `NaN || 0` becomes `0`, making "1.2.3-beta" compare as "1.2.0".
2. No validation that inputs are strings or have the expected format.
3. Versions with more than 3 parts (e.g., "1.2.3.4") silently ignore extra parts.
4. Empty strings or malformed input like "..." produce `[NaN, NaN, NaN]` which all become `0`.

**Impact**: A malicious client could bypass version policy checks by submitting a version string like "999.0.0-blocked" which would compare as "999.0.0" (above minimum) but would not match the blocked version list (which checks the exact string "999.0.0-blocked"). Conversely, pre-release versions like "2.0.0-beta.1" would wrongly compare equal to "2.0.0".

**Fix**: Add input validation and handle pre-release identifiers:
```js
export function compareVersions(a, b) {
  const semverRegex = /^\d+\.\d+\.\d+$/;
  if (!semverRegex.test(a) || !semverRegex.test(b)) {
    throw new Error('Invalid semver version format');
  }
  // ... existing comparison logic
}
```
