# Plan: Math.random() used for security-sensitive random selection

**Retargeted**: This issue was originally identified in dead CF Worker code. The same vulnerability exists in the VPS server.

**Issue**: issue-server-18.md
**Severity**: MEDIUM
**Area**: Server (VPS)
**Files to modify**:
- `packages/server-vps/src/registry/relay-registry.ts`

## Analysis

`Math.random()` is used in a security-relevant context in the VPS server:

**Relay selection shuffle** (`packages/server-vps/src/registry/relay-registry.ts`):
- Lines 108-111 (Fisher-Yates shuffle in `getAvailableRelays`):
  ```ts
  // Fisher-Yates shuffle for random distribution
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j]!, available[i]!];
  }
  ```

`Math.random()` uses a non-cryptographic PRNG (xorshift128+ in V8). Its output can be predicted if an attacker can observe enough outputs. In the relay selection context, a predictable shuffle could allow an attacker to predict which relay peers are returned, potentially enabling targeted relay positioning attacks.

## Fix Steps

1. **Create a `packages/server-vps/src/crypto/secure-random.ts` utility**:
   ```ts
   import { randomInt } from 'node:crypto';

   /**
    * Generate a cryptographically secure random integer in [0, max).
    * Uses Node.js crypto.randomInt which uses rejection sampling internally
    * to avoid modulo bias.
    * @param max - Exclusive upper bound (must be > 0)
    * @returns Random integer in [0, max)
    */
   export function secureRandomInt(max: number): number {
     if (max <= 0) return 0;
     return randomInt(max);
   }

   /**
    * Cryptographically secure Fisher-Yates shuffle.
    * Mutates the array in place.
    * @param array - Array to shuffle
    * @returns The shuffled array (same reference)
    */
   export function secureShuffleArray<T>(array: T[]): T[] {
     for (let i = array.length - 1; i > 0; i--) {
       const j = secureRandomInt(i + 1);
       [array[i], array[j]] = [array[j]!, array[i]!];
     }
     return array;
   }
   ```

   Note: Node.js `crypto.randomInt()` is available since Node.js 14.10 and internally uses rejection sampling to avoid modulo bias.

2. **Update `packages/server-vps/src/registry/relay-registry.ts`**:
   - Add import at the top (after line 1 or near existing imports):
     ```ts
     import { secureShuffleArray } from '../crypto/secure-random.js';
     ```
   - Replace lines 107-111 (the Fisher-Yates shuffle block):
     ```ts
     // Cryptographically secure shuffle for random distribution
     secureShuffleArray(available);
     ```

## Testing

- Verify that `secureRandomInt()` returns values in the correct range [0, max).
- Verify that relay shuffle still produces randomized output.
- Run existing relay registry tests.
- Statistical test: Call `secureRandomInt(6)` 10,000 times and verify roughly uniform distribution.
- Verify `getAvailableRelays` still correctly excludes self, filters by capacity, and returns the requested count.

## Risk Assessment

- **Very low risk**: This is a drop-in replacement for the randomness source. The behavior is identical (random shuffle), only the quality of randomness improves.
- **Performance**: `crypto.randomInt()` is slightly slower than `Math.random()`, but this is called at most a few times per request (one shuffle of ~10-20 relays). The overhead is negligible.
- **No modulo bias**: Node.js `crypto.randomInt()` uses rejection sampling internally, so there is zero modulo bias unlike a naive `getRandomValues() % max` approach.
