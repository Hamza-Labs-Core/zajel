# [MEDIUM] hexToBytes does not validate input format

**Area**: Server
**File**: packages/server/src/crypto/signing.js:12-18, packages/server/src/durable-objects/attestation-registry-do.js:669-675
**Type**: Security

**Description**: The `hexToBytes` function in both files converts a hex string to a `Uint8Array` without validating the input:
```js
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
```
Issues:
1. No check that `hex` is a string.
2. No check that `hex.length` is even.
3. No check that characters are valid hex digits. `parseInt('zz', 16)` returns `NaN`, which becomes `0` when stored in a `Uint8Array`.
4. If `hex` is `undefined` or `null`, `hex.length` throws a TypeError that propagates up.

This function is used to parse the `BOOTSTRAP_SIGNING_KEY`, `ATTESTATION_SIGNING_KEY`, nonce values, and `data_hex` from reference entries.

**Impact**: Malformed hex input silently produces incorrect byte arrays rather than throwing an error. A misconfigured signing key hex string would silently produce a wrong key, potentially making signatures unverifiable or using a weak key. Malformed `data_hex` in reference entries would produce incorrect HMAC computations, causing all attestation verifications to fail.

**Fix**: Add input validation:
```js
function hexToBytes(hex) {
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
