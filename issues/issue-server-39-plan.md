# Plan: signPayload uses spread operator on large signatures risking stack overflow

**Issue**: issue-server-39.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/crypto/signing.js`, `packages/server/src/crypto/attestation.js`

## Analysis

Two functions use the spread operator to convert signature bytes to base64:

1. **`packages/server/src/crypto/signing.js` line 57** (`signPayload`):
```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```

2. **`packages/server/src/crypto/attestation.js` line 101** (`signPayloadEd25519`):
```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```

The spread operator expands the `Uint8Array` into individual arguments to `String.fromCharCode()`. For Ed25519 signatures (always 64 bytes), this produces 64 arguments, which is safe. However, the pattern is fragile: if reused for larger data (e.g., RSA-2048 signatures at 256 bytes, or general-purpose binary-to-base64 conversion), it could hit the JavaScript engine's maximum argument count limit (typically 65,536 to ~125,000 arguments depending on engine).

Currently there is no immediate risk, but this is a known anti-pattern that should be replaced.

## Fix Steps

1. **Add a `bytesToBase64` helper function** in `packages/server/src/crypto/signing.js` (after the `hexToBytes` function, around line 18):

```js
/**
 * Convert an ArrayBuffer or Uint8Array to a base64 string.
 * Uses a loop instead of spread operator to avoid stack overflow on large inputs.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string} Base64-encoded string
 */
export function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
```

2. **Update `signPayload` in `signing.js`** (line 57). Replace:
```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```
With:
```js
return bytesToBase64(signature);
```

3. **Update `signPayloadEd25519` in `attestation.js`** (line 101). First, add the import at the top:
```js
import { hexToBytes, bytesToBase64 } from './signing.js';
```
(modifying the existing import on line 8 to include `bytesToBase64`)

Then replace line 101:
```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```
With:
```js
return bytesToBase64(signature);
```

## Testing

- Test that `signPayload` produces the same base64 signature as before for identical inputs.
- Test that `signPayloadEd25519` produces the same base64 signature as before.
- Test `bytesToBase64` with various input sizes: 0 bytes, 32 bytes, 64 bytes, 1024 bytes.
- Test round-trip: `atob(bytesToBase64(data))` should produce the original data.
- Run existing signing and attestation tests to verify no regressions.

## Risk Assessment

- **Very low risk**: The loop-based approach produces identical output to the spread-based approach. The only difference is the internal mechanism for building the binary string.
- **Performance**: For 64-byte signatures, the performance difference is negligible. For larger inputs, the loop is actually faster because it avoids the overhead of spreading thousands of arguments.
- **No breaking changes**: The function signatures and return values are identical.
