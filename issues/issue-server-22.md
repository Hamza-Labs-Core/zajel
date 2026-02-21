# [MEDIUM] HMAC comparison uses non-constant-time string equality

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:487
**Type**: Security

**Description**: In the attestation verification handler, the computed HMAC is compared to the client-provided HMAC using JavaScript's `!==` operator:
```js
if (hmac !== expectedHmac) {
  return this.jsonResponse(
    { valid: false, error: 'HMAC mismatch' },
    200,
    corsHeaders
  );
}
```
This is a non-constant-time string comparison. The comparison short-circuits on the first differing byte, leaking information about how many bytes of the HMAC matched.

**Impact**: An attacker can perform a timing side-channel attack to forge HMAC values byte by byte. Each guess that matches more bytes will take slightly longer to compare, allowing the attacker to discover the correct HMAC incrementally. This directly undermines the attestation challenge-response security.

**Fix**: Use constant-time comparison:
```js
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

if (!(await timingSafeEqual(hmac, expectedHmac))) {
  // HMAC mismatch
}
```
