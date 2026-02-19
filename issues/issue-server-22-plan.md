# Plan: HMAC comparison uses non-constant-time string equality

**Issue**: issue-server-22.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**: `packages/server/src/durable-objects/attestation-registry-do.js`

## Analysis

In `attestation-registry-do.js`, line 487, the HMAC comparison uses JavaScript's `!==` operator:

```js
if (hmac !== expectedHmac) {
```

This is inside the `handleVerify` method (lines 388-522). The `hmac` value comes from the client request body (`responses[].hmac`), and `expectedHmac` is computed server-side via `computeHmac()` which returns a hex-encoded string. The `!==` operator short-circuits on the first differing character, making timing side-channel attacks theoretically possible.

Cloudflare Workers runtime supports `crypto.subtle.timingSafeEqual` which is the correct API for this use case.

## Fix Steps

1. **Add a `timingSafeEqual` helper function** at the bottom of `attestation-registry-do.js` (near the existing `hexToBytes` helper, around line 669):

```js
async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}
```

2. **Replace the comparison on line 487** from:
```js
if (hmac !== expectedHmac) {
```
to:
```js
if (!(await timingSafeEqual(hmac, expectedHmac))) {
```

Note: The method `handleVerify` is already `async`, so adding `await` here is safe.

## Testing

- Run existing attestation tests to ensure verification still passes for valid HMACs.
- Add a unit test that verifies both matching and non-matching HMACs return the correct result through the `timingSafeEqual` helper.
- Verify that `crypto.subtle.timingSafeEqual` is available in the Cloudflare Workers runtime (it has been available since 2023).

## Risk Assessment

- **Low risk**: This is a drop-in replacement for the string comparison. The only behavioral change is the timing characteristic, which is intentional.
- **Compatibility note**: `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension (not standard Web Crypto). If the code is ever run in a different runtime (Node.js, Deno), a polyfill or alternative (e.g., Node's `crypto.timingSafeEqual`) would be needed.
- The length check before `timingSafeEqual` (`bufA.byteLength !== bufB.byteLength`) does leak whether lengths match, but since both HMAC-SHA256 outputs are always 64 hex characters, this branch is only reached for invalid/malformed input.
