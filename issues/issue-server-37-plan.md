# Plan: Session token format uses base64 (not base64url) which is not URL-safe

**Issue**: issue-server-37.md
**Severity**: LOW
**Area**: Server
**Files to modify**: `packages/server/src/crypto/attestation.js`

## Analysis

In `packages/server/src/crypto/attestation.js`, the `createSessionToken` function (lines 141-146) uses standard base64 via `btoa()`:

```js
export async function createSessionToken(signingKey, tokenData) {
  const payload = JSON.stringify(tokenData);
  const payloadBase64 = btoa(payload);
  const signature = await signPayloadEd25519(signingKey, payload);
  return `${payloadBase64}.${signature}`;
}
```

And `signPayloadEd25519` (line 98-102) also uses `btoa()`:
```js
export async function signPayloadEd25519(privateKey, payload) {
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
```

Standard base64 uses `+`, `/`, and `=` padding characters that are not safe in URLs, cookies, or some HTTP header contexts without additional percent-encoding.

The `verifySessionToken` function (lines 154-174) uses `atob()` for decoding:
```js
const [payloadBase64, signature] = parts;
const payload = atob(payloadBase64);
```

And `verifyBuildTokenSignature` (lines 86-90) also uses `atob()`:
```js
const sigBytes = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
```

## Fix Steps

1. **Add base64url encode/decode helper functions** at the top of `attestation.js` (after the imports, around line 8):

```js
/**
 * Encode a string to base64url (RFC 4648 Section 5).
 * @param {string} str - String to encode
 * @returns {string} base64url-encoded string
 */
function toBase64Url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string (RFC 4648 Section 5).
 * @param {string} b64url - base64url-encoded string
 * @returns {string} Decoded string
 */
function fromBase64Url(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b64.length % 4)) % 4;
  b64 += '='.repeat(pad);
  return atob(b64);
}
```

2. **Update `createSessionToken`** (line 141) to use base64url:

```js
export async function createSessionToken(signingKey, tokenData) {
  const payload = JSON.stringify(tokenData);
  const payloadBase64 = toBase64Url(payload);
  const signature = await signPayloadEd25519(signingKey, payload);
  return `${payloadBase64}.${signature}`;
}
```

3. **Update `signPayloadEd25519`** (line 98) to use base64url for the signature:

```js
export async function signPayloadEd25519(privateKey, payload) {
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return toBase64Url(String.fromCharCode(...new Uint8Array(signature)));
}
```

4. **Update `verifySessionToken`** (line 154) to decode base64url:

```js
export async function verifySessionToken(publicKey, token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadBase64, signature] = parts;
    const payload = fromBase64Url(payloadBase64);

    const valid = await verifyBuildTokenSignature(publicKey, payload, signature);
    if (!valid) return null;
    // ...
  }
}
```

5. **Update `verifyBuildTokenSignature`** (line 86) to handle base64url signatures:

```js
export async function verifyBuildTokenSignature(publicKey, payload, signatureBase64) {
  const sigBytes = Uint8Array.from(fromBase64Url(signatureBase64), (c) => c.charCodeAt(0));
  const data = new TextEncoder().encode(payload);
  return crypto.subtle.verify('Ed25519', publicKey, sigBytes, data);
}
```

6. **Note on backward compatibility**: If there are existing session tokens in the wild using standard base64, `verifySessionToken` should handle both formats during a transition period:

```js
function fromBase64UrlOrBase64(str) {
  try {
    return fromBase64Url(str);
  } catch {
    return atob(str); // fallback to standard base64
  }
}
```

## Testing

- Test that tokens created with `createSessionToken` can be verified with `verifySessionToken`.
- Test that base64url tokens do not contain `+`, `/`, or `=` characters.
- Test that tokens can be safely used in URL query parameters without percent-encoding.
- Test backward compatibility: verify that old base64 tokens are still accepted (during transition).

## Risk Assessment

- **Breaking change**: Existing session tokens signed with standard base64 will not be verifiable with the new base64url decoder unless backward compatibility is implemented. Since session tokens have a 1-hour TTL (line 29), the transition window is short.
- **Build token compatibility**: `verifyBuildTokenSignature` is used for build tokens from CI. If CI already generates standard base64 signatures, the fallback decoder is needed, or CI must be updated simultaneously.
- **Low overall risk**: The actual cryptographic operations are unchanged; only the encoding format changes.
