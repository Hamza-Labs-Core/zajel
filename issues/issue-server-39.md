# [LOW] signPayload uses spread operator on large signatures risking stack overflow

**Area**: Server
**File**: packages/server/src/crypto/signing.js:57, packages/server/src/crypto/attestation.js:101
**Type**: Best Practice

**Description**: Both `signPayload` and `signPayloadEd25519` convert signature bytes to a base64 string using the spread operator:
```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```
The spread operator converts the typed array into individual function arguments to `String.fromCharCode()`. For Ed25519 signatures (64 bytes), this is fine. However, this pattern is fragile -- if ever reused for larger data (e.g., RSA signatures at 256+ bytes, or HMAC output), the spread operator with `String.fromCharCode.apply` can hit the JavaScript engine's maximum argument count limit.

**Impact**: Currently no practical impact since Ed25519 signatures are always 64 bytes. However, the pattern is a maintenance hazard. If copied for other uses with larger data, it will cause `RangeError: Maximum call stack size exceeded`.

**Fix**: Use a loop or reduce pattern that does not rely on spread:
```js
function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
```
