# Plan: Math.random() used for security-sensitive random selection

**Issue**: issue-server-18.md
**Severity**: MEDIUM
**Area**: Server
**Files to modify**:
- `packages/server/src/durable-objects/attestation-registry-do.js`
- `packages/server/src/relay-registry.js`

## Analysis

`Math.random()` is used in two security-relevant contexts:

**1. Attestation challenge region selection** (attestation-registry-do.js):
- Line 346-348: Number of regions selected:
  ```js
  const numRegions = MIN_CHALLENGE_REGIONS + Math.floor(
    Math.random() * (MAX_CHALLENGE_REGIONS - MIN_CHALLENGE_REGIONS + 1)
  );
  ```
- Line 647 (in `selectRandomRegions`):
  ```js
  const idx = Math.floor(Math.random() * available.length);
  ```

**2. Relay selection shuffle** (relay-registry.js):
- Lines 82-84 (Fisher-Yates shuffle):
  ```js
  const j = Math.floor(Math.random() * (i + 1));
  ```

`Math.random()` uses a non-cryptographic PRNG (xorshift128+ in V8). Its output can be predicted if an attacker can observe enough outputs, which in the attestation context weakens the challenge-response protocol.

## Fix Steps

1. **Create a `packages/server/src/crypto/secure-random.js` utility**:
   ```js
   /**
    * Generate a cryptographically secure random integer in [0, max).
    * @param {number} max - Exclusive upper bound
    * @returns {number} Random integer
    */
   export function secureRandomInt(max) {
     if (max <= 0) return 0;
     const arr = new Uint32Array(1);
     crypto.getRandomValues(arr);
     return arr[0] % max;
   }

   /**
    * Cryptographically secure Fisher-Yates shuffle.
    * @param {Array} array - Array to shuffle (mutated in place)
    * @returns {Array} The shuffled array
    */
   export function secureShuffleArray(array) {
     for (let i = array.length - 1; i > 0; i--) {
       const j = secureRandomInt(i + 1);
       [array[i], array[j]] = [array[j], array[i]];
     }
     return array;
   }
   ```

   Note: `crypto.getRandomValues()` is available in Cloudflare Workers runtime.

2. **Update `attestation-registry-do.js`**:
   - Import: `import { secureRandomInt } from '../crypto/secure-random.js';`
   - Replace line 346-348:
     ```js
     const numRegions = MIN_CHALLENGE_REGIONS + secureRandomInt(
       MAX_CHALLENGE_REGIONS - MIN_CHALLENGE_REGIONS + 1
     );
     ```
   - Replace `selectRandomRegions()` method (lines 641-653):
     ```js
     selectRandomRegions(criticalRegions, count) {
       const available = [...criticalRegions];
       const selected = [];
       const selectCount = Math.min(count, available.length);

       for (let i = 0; i < selectCount; i++) {
         const idx = secureRandomInt(available.length);
         selected.push(available[idx]);
         available.splice(idx, 1);
       }

       return selected;
     }
     ```

3. **Update `relay-registry.js`**:
   - Import: `import { secureShuffleArray } from './crypto/secure-random.js';`
   - Replace lines 82-85 (Fisher-Yates shuffle) with:
     ```js
     secureShuffleArray(available);
     ```

4. **Modulo bias note**: The simple `arr[0] % max` approach has a very slight bias when `max` does not evenly divide 2^32. For security-critical applications, this can be eliminated with rejection sampling. However, for selecting 3-5 regions from ~10-20 candidates, the bias is negligible (< 0.0000001%). If desired, add rejection sampling:
   ```js
   export function secureRandomInt(max) {
     const arr = new Uint32Array(1);
     const limit = Math.floor(0x100000000 / max) * max;
     do {
       crypto.getRandomValues(arr);
     } while (arr[0] >= limit);
     return arr[0] % max;
   }
   ```

## Testing

- Verify that `secureRandomInt()` returns values in the correct range [0, max).
- Verify that `selectRandomRegions()` still selects the correct number of regions.
- Verify that relay shuffle still produces randomized output.
- Run existing attestation and relay tests.
- Statistical test: Call `secureRandomInt(6)` 10,000 times and verify roughly uniform distribution.

## Risk Assessment

- **Very low risk**: This is a drop-in replacement for the randomness source. The behavior is identical (random selection/shuffle), only the quality of randomness improves.
- **Performance**: `crypto.getRandomValues()` is slightly slower than `Math.random()`, but this is called at most a few times per request (3-5 region selections, or one shuffle of ~10-20 relays). The overhead is negligible.
- **Import path**: Ensure the import path from `relay-registry.js` to `crypto/secure-random.js` is correct relative to the file location.
