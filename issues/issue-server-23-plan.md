# Plan: hexToBytes does not validate input format

**Issue**: issue-server-23.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/crypto/signing.js`, `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

There are two identical copies of `hexToBytes`:

1. **`packages/server/src/crypto/signing.js` lines 12-18** (exported, used by `importSigningKey` and re-exported to `attestation.js`):
```js
export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
```

2. **`packages/server/src/durable-objects/attestation-registry-do.js` lines 669-675** (private, non-exported, used by `handleVerify` to parse `refRegion.data_hex` on line 484):
```js
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
```

Neither copy validates the input. Invalid hex characters like `'zz'` produce `NaN` via `parseInt`, which becomes `0` in a `Uint8Array`. Odd-length strings silently truncate the last character. `null`/`undefined` inputs cause runtime `TypeError` on `.length`.

The `signing.js` copy is used to parse `BOOTSTRAP_SIGNING_KEY` and `ATTESTATION_SIGNING_KEY` environment variables. The `attestation-registry-do.js` copy is used to parse `data_hex` from reference entries.

## Fix Steps

1. **Fix the exported `hexToBytes` in `packages/server/src/crypto/signing.js`** (lines 12-18). Add input validation at the top of the function:

```js
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
```

2. **Remove the duplicate `hexToBytes` from `attestation-registry-do.js`** (lines 666-675) and import it from `signing.js` instead. At the top of `attestation-registry-do.js`, the existing imports from `../crypto/attestation.js` (line 17-26) do not include `hexToBytes`. Add an import:

```js
import { hexToBytes } from '../crypto/signing.js';
```

Then delete the local `hexToBytes` function definition (lines 666-675).

Alternatively, re-export `hexToBytes` from `attestation.js` (which already imports it from `signing.js` on line 8) and import it from there in `attestation-registry-do.js`.

## Testing

- Add a unit test for `hexToBytes` covering:
  - Valid hex string: `hexToBytes('48656c6c6f')` returns correct bytes.
  - Empty string: `hexToBytes('')` returns empty `Uint8Array`.
  - Odd-length string: throws `Error`.
  - Non-hex characters: `hexToBytes('xyz')` throws `Error`.
  - Non-string input: `hexToBytes(123)` throws `Error`.
  - `null`/`undefined`: throws `Error`.
- Run existing server tests to confirm no regressions in signing or attestation flows.
- Test that a misconfigured `ATTESTATION_SIGNING_KEY` (e.g., with odd length or non-hex chars) now produces a clear error instead of silently using a corrupted key.

## Risk Assessment

- **Low risk for valid inputs**: The validation only rejects inputs that were previously silently corrupted. Valid hex strings will behave identically.
- **Breaking change for corrupted keys**: If any environment variable currently contains invalid hex that was silently accepted (producing a wrong key), the fix will cause an immediate error on startup. This is the desired behavior -- it surfaces the misconfiguration rather than silently using a corrupted key.
- **Code deduplication**: Removing the duplicate function eliminates future divergence risk between the two copies.
