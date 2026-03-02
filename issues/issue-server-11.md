# [HIGH] Timing-based secret comparison enables auth token brute-forcing

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:250
**Type**: Security

**Description**: The `CI_UPLOAD_SECRET` is compared using JavaScript's `!==` operator:
```js
if (!authHeader || authHeader !== `Bearer ${this.env.CI_UPLOAD_SECRET}`) {
```
This comparison is not constant-time. JavaScript string comparison short-circuits on the first differing character, leaking timing information about how many characters of the secret matched.

The same pattern appears on line 548 for the version policy admin endpoint.

**Impact**: An attacker can perform a timing side-channel attack to discover the `CI_UPLOAD_SECRET` one character at a time. While Cloudflare Workers' network latency adds noise, sophisticated attackers can average over many requests to extract the signal. Once the secret is known, the attacker can upload malicious reference binaries or modify version policies.

**Fix**: Use `crypto.subtle.timingSafeEqual` (available in Cloudflare Workers) or a constant-time comparison function:
```js
function timingSafeCompare(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}
```
Apply this to both secret comparisons in the file.
