# [LOW] Session token format uses base64 (not base64url) which is not URL-safe

**Area**: Server
**File**: packages/server/src/crypto/attestation.js:141-146
**Type**: Best Practice

**Description**: The `createSessionToken` function uses standard base64 encoding with `btoa()`:
```js
const payloadBase64 = btoa(payload);
const signature = await signPayloadEd25519(signingKey, payload);
return `${payloadBase64}.${signature}`;
```
Standard base64 uses `+`, `/`, and `=` characters that are not safe in URLs, HTTP headers, or cookies without additional encoding. The `signPayload` and `signPayloadEd25519` functions also use `btoa()` for signature encoding.

**Impact**: If a session token is ever passed as a URL parameter, cookie value, or HTTP header value, the `+`, `/`, and `=` characters may be corrupted or require additional percent-encoding. This can cause token verification failures in edge cases.

**Fix**: Use base64url encoding (RFC 4648) which replaces `+` with `-`, `/` with `_`, and strips padding:
```js
function toBase64Url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
```
Update `verifySessionToken` to handle base64url decoding as well.
