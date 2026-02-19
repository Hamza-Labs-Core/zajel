# [MEDIUM] Math.random() used for security-sensitive random selection

**Area**: Server
**File**: packages/server/src/durable-objects/attestation-registry-do.js:346-348, packages/server/src/relay-registry.js:82-84
**Type**: Security

**Description**: `Math.random()` is used in two security-relevant contexts:

1. **Attestation challenge region selection** (attestation-registry-do.js:346):
```js
const numRegions = MIN_CHALLENGE_REGIONS + Math.floor(
  Math.random() * (MAX_CHALLENGE_REGIONS - MIN_CHALLENGE_REGIONS + 1)
);
```
And in `selectRandomRegions` (line 647):
```js
const idx = Math.floor(Math.random() * available.length);
```

2. **Relay selection shuffle** (relay-registry.js:82-84):
```js
const j = Math.floor(Math.random() * (i + 1));
```

`Math.random()` uses a non-cryptographic PRNG. In the attestation context, predictable region selection allows an attacker to precompute which regions will be challenged, making it easier to forge responses.

**Impact**: In the attestation flow, predictable region selection weakens the challenge-response protocol. An attacker who can predict which regions will be selected can prepare forged HMAC responses for only those regions. For relay selection, predictable shuffling has lower impact but could enable targeted routing attacks.

**Fix**: Use `crypto.getRandomValues()` for cryptographically secure randomness:
```js
function secureRandomInt(max) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % max;
}
```
