# Issue #36: Modulo Bias in Random Generation

## Summary

The pairing code generation in `packages/web-client/src/lib/signaling.ts` (lines 52-57) uses the modulo operator (`%`) to map random bytes to character indices, which introduces a statistical bias in the generated codes.

## Current Implementation

```typescript
private generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes)
    .map((b) => PAIRING_CODE_CHARS[b % PAIRING_CODE_CHARS.length])
    .join('');
}
```

Where:
- `PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'` (32 characters)
- Random bytes from `crypto.getRandomValues()` range from 0-255 (256 possible values)

## The Modulo Bias Problem

### Explanation

When mapping a uniform random value from a larger range to a smaller range using the modulo operator, some output values will occur more frequently than others if the larger range is not evenly divisible by the smaller range.

### Mathematical Analysis

- **Input range**: 0-255 (256 values from `Uint8Array`)
- **Output range**: 0-31 (32 characters in `PAIRING_CODE_CHARS`)
- **Division**: 256 / 32 = 8 (exactly)

**Good news**: In this specific case, 256 is evenly divisible by 32, so there is **NO modulo bias** with the current character set!

Each of the 32 characters maps to exactly 8 byte values:
- Character 0 (A): bytes 0, 32, 64, 96, 128, 160, 192, 224
- Character 1 (B): bytes 1, 33, 65, 97, 129, 161, 193, 225
- ...and so on...
- Character 31 (9): bytes 31, 63, 95, 127, 159, 191, 223, 255

### When Bias Would Occur

If the character set length were not a power of 2 (and not a divisor of 256), bias would occur. For example:

**Example with 30 characters**:
- 256 / 30 = 8 remainder 16
- Characters 0-15 would each map to 9 byte values (probability: 9/256 = 3.52%)
- Characters 16-29 would each map to 8 byte values (probability: 8/256 = 3.13%)
- **Bias**: Characters 0-15 would be ~12.5% more likely than characters 16-29

**Example with 36 characters (alphanumeric)**:
- 256 / 36 = 7 remainder 4
- Characters 0-3 would each map to 8 byte values (probability: 8/256 = 3.13%)
- Characters 4-35 would each map to 7 byte values (probability: 7/256 = 2.73%)
- **Bias**: Characters 0-3 would be ~14.3% more likely than others

## Bias Calculation Formula

For a random source with `R` possible values and target range of `N` values:

```
remainder = R mod N
biased_count = remainder
unbiased_count = N - remainder

For biased characters: probability = ceil(R/N) / R
For unbiased characters: probability = floor(R/N) / R

Bias ratio = ceil(R/N) / floor(R/N) = (floor(R/N) + 1) / floor(R/N)
```

## Recommended Fix: Rejection Sampling

Even though the current code has no bias (32 divides 256 evenly), implementing rejection sampling is a best practice that protects against future changes to the character set:

### Option 1: Simple Rejection Sampling

```typescript
private generatePairingCode(): string {
  const charsetLength = PAIRING_CODE_CHARS.length;
  // Calculate the largest multiple of charsetLength that fits in 256
  const maxValid = Math.floor(256 / charsetLength) * charsetLength;

  const result: string[] = [];

  while (result.length < PAIRING_CODE_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(1));
    const byte = bytes[0];

    // Reject values that would cause bias
    if (byte < maxValid) {
      result.push(PAIRING_CODE_CHARS[byte % charsetLength]);
    }
  }

  return result.join('');
}
```

### Option 2: Batch Rejection Sampling (More Efficient)

```typescript
private generatePairingCode(): string {
  const charsetLength = PAIRING_CODE_CHARS.length;
  const maxValid = Math.floor(256 / charsetLength) * charsetLength;

  const result: string[] = [];

  while (result.length < PAIRING_CODE_LENGTH) {
    // Request more bytes than needed to reduce iterations
    const needed = PAIRING_CODE_LENGTH - result.length;
    const bytes = crypto.getRandomValues(new Uint8Array(needed + 2));

    for (const byte of bytes) {
      if (byte < maxValid && result.length < PAIRING_CODE_LENGTH) {
        result.push(PAIRING_CODE_CHARS[byte % charsetLength]);
      }
    }
  }

  return result.join('');
}
```

### Option 3: Using Larger Random Values (Negligible Bias)

```typescript
private generatePairingCode(): string {
  const charsetLength = PAIRING_CODE_CHARS.length;
  // Use 32-bit values for negligible bias (2^32 mod 32 = 0, still no bias for 32 chars)
  const values = crypto.getRandomValues(new Uint32Array(PAIRING_CODE_LENGTH));

  return Array.from(values)
    .map((v) => PAIRING_CODE_CHARS[v % charsetLength])
    .join('');
}
```

## Performance Considerations

| Method | Average Bytes Used | Worst Case | Complexity |
|--------|-------------------|------------|------------|
| Current (modulo) | 6 | 6 | O(1) |
| Rejection (single) | ~7.2 for 30-char set | Unbounded* | O(n) expected |
| Rejection (batch) | ~6.8 for 30-char set | Unbounded* | O(n) expected |
| Uint32Array | 24 | 24 | O(1) |

*Unbounded but probability of needing >20 iterations is vanishingly small (<10^-15).

## Security Impact Assessment

For the current implementation with a 32-character set:
- **No security impact** - there is no bias since 256 mod 32 = 0

If the character set were changed to a non-power-of-2 length:
- The bias would slightly reduce the effective entropy of pairing codes
- For a 30-character set: effective entropy reduction of ~0.04 bits per character
- Total code entropy would drop from ~29.76 bits to ~29.52 bits
- This is a minor reduction but could theoretically make brute-force attacks slightly easier

## Recommendation

1. **Low Priority Fix**: The current code has no modulo bias because the character set length (32) evenly divides 256.

2. **Defense in Depth**: Consider implementing rejection sampling to protect against future character set changes. Option 2 (batch rejection sampling) provides the best balance of correctness and performance.

3. **Documentation**: Add a comment explaining why the current 32-character set was chosen (it's a power of 2 that avoids modulo bias with byte values).

## References

- [Modulo Bias - Wikipedia](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle#Modulo_bias)
- [RFC 4086 - Randomness Requirements for Security](https://tools.ietf.org/html/rfc4086)
- [OWASP Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/)

## Research: How Other Apps Solve This

This section documents how major cryptographic libraries and secure applications handle unbiased random number generation, based on research into their implementations and best practices.

### 1. libsodium: `randombytes_uniform()`

libsodium provides `randombytes_uniform()`, derived from OpenBSD's `arc4random_uniform()` (originally by Damien Miller).

**Implementation** ([source](https://github.com/jedisct1/libsodium/blob/master/src/libsodium/randombytes/randombytes.c)):

```c
uint32_t randombytes_uniform(const uint32_t upper_bound) {
    uint32_t min;
    uint32_t r;

    if (upper_bound < 2) {
        return 0;
    }
    // Calculate 2^32 mod upper_bound using two's complement trick
    min = (1U + ~upper_bound) % upper_bound;
    do {
        r = randombytes_random();
    } while (r < min);
    // r is now in a range whose size mod upper_bound == 0
    return r % upper_bound;
}
```

**How it works:**
1. Computes `min = 2^32 mod upper_bound` using the two's complement identity `(1U + ~upper_bound) % upper_bound`
2. Rejection loop: discards values in `[0, min)` because they would cause bias
3. Returns `r % upper_bound` for values in `[min, 2^32)`
4. Worst case (upper_bound = 2^31 + 1) requires approximately 2 attempts on average

**Key insight:** By rejecting the first `min` values, the remaining range `[min, 2^32)` is evenly divisible by `upper_bound`.

### 2. OpenSSL: `BN_rand_range()`

OpenSSL's BIGNUM library provides `BN_rand_range()` for generating unbiased random integers in arbitrary ranges.

**Implementation** ([source](https://github.com/openssl/openssl/blob/master/crypto/bn/bn_rand.c)):

The function uses a sophisticated rejection sampling approach:

1. **Bit-length analysis:** Determines `n = BN_num_bits(range)` to know how many bits to generate
2. **Conditional strategy:**
   - For power-of-2 ranges: generates `n+1` bits, then applies modulo
   - For other ranges: generates exactly `n` bits
3. **Optimized rejection:** If `r < 3*range`, uses `r mod range`; otherwise rejects
   - Since `3*range = 11...` in binary, each iteration succeeds with probability >= 75%

**Key features:**
- Supports arbitrary-precision integers (BIGNUMs)
- `BN_priv_rand_range()` variant for private/sensitive values
- Uses NIST SP 800-90A compliant DRBG as entropy source

### 3. Signal Protocol

Signal uses platform-native cryptographic random generators and focuses on uniform key generation.

**iOS Implementation** ([source](https://github.com/signalapp/SignalServiceKit/blob/master/src/Util/Cryptography.m)):

```objc
+ (NSData *)generateRandomBytes:(int)numberBytes {
    NSMutableData *randomBytes = [NSMutableData dataWithLength:numberBytes];
    int err = SecRandomCopyBytes(kSecRandomDefault, numberBytes,
                                  [randomBytes mutableBytes]);
    if (err != noErr) {
        @throw [NSException exceptionWithName:@"random problem"
                                       reason:@"problem generating random bytes"
                                     userInfo:nil];
    }
    return randomBytes;
}
```

**Key aspects:**
- Uses `SecRandomCopyBytes` (Apple's cryptographically secure RNG)
- All keys are powers of 2 in size (32 bytes for chain keys, 80 bytes for message keys)
- UUIDs (16 bytes) for user identification
- Registration IDs and pre-keys generated with uniform distribution

**Signal's approach to avoiding bias:**
- Key sizes are always byte-aligned (no modulo reduction needed)
- When reduction is needed, uses libraries that implement proper rejection sampling

### 4. Web Crypto API: Best Practices

The Web Crypto API provides `crypto.getRandomValues()` but requires careful handling to avoid bias.

**Recommended patterns:**

**Pattern 1: Power-of-2 alphabets (no bias)**
```typescript
// 32-character alphabet = no bias with byte values
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const bytes = crypto.getRandomValues(new Uint8Array(length));
return Array.from(bytes).map(b => ALPHABET[b % 32]).join('');
```

**Pattern 2: Rejection sampling for arbitrary alphabets**
```typescript
function uniformRandom(alphabet: string, length: number): string {
  const maxValid = Math.floor(256 / alphabet.length) * alphabet.length;
  const result: string[] = [];

  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length - result.length + 2));
    for (const byte of bytes) {
      if (byte < maxValid && result.length < length) {
        result.push(alphabet[byte % alphabet.length]);
      }
    }
  }
  return result.join('');
}
```

**Pattern 3: Mask-based approach (used by Nano ID)**
```typescript
function nanoidCustom(alphabet: string, size: number): string {
  // Create a bitmask that covers the alphabet size
  const mask = (2 << (31 - Math.clz32((alphabet.length - 1) | 1))) - 1;
  // Over-provision bytes (1.6x multiplier for statistical guarantee)
  const step = Math.ceil((1.6 * mask * size) / alphabet.length);

  let id = '';
  while (id.length < size) {
    const bytes = crypto.getRandomValues(new Uint8Array(step));
    for (let i = 0; i < step && id.length < size; i++) {
      const byte = bytes[i] & mask;
      if (byte < alphabet.length) {
        id += alphabet[byte];
      }
    }
  }
  return id;
}
```

**Important warnings from MDN:**
- Do not use `getRandomValues()` to generate encryption keys directly; use `generateKey()` instead
- No minimum entropy is mandated by the Web Crypto specification
- Implementations use OS-provided CSPRNGs (e.g., `/dev/urandom` on Linux)

### 5. NIST SP 800-90A Guidelines

NIST SP 800-90A Rev. 1 provides authoritative guidance on random number generation.

**Key sections on bias:**

**Appendix B: Converting Random Bits to Random Numbers**

Two approved methods:

1. **Variable-Length Extraction (No Skew):**
   - Use rejection sampling
   - Reject values outside target range
   - Guarantees perfect uniformity

2. **Fixed-Length Extraction (Negligible Skew):**
   - Generate `ceil(log2(p)) + k` bits where `k` is the security level
   - Reduce modulo target range
   - Bias is at most `2^-k` (negligible for `k >= 128`)

**Example: Ed25519 approach:**
- Uses 512-bit random value reduced modulo ~252-bit curve order
- Bias is approximately `2^-260` (effectively zero)
- Immune to Bleichenbacher-style attacks

### 6. Language-Specific Implementations

#### Go: `crypto/rand.Int()`

```go
import (
    "crypto/rand"
    "math/big"
)

// Returns uniform random in [0, max)
n, err := rand.Int(rand.Reader, max)
```

Uses rejection sampling internally, leveraging OS entropy sources (`getrandom(2)` on Linux, `arc4random_buf(3)` on macOS/BSD).

#### Python: `secrets.randbelow()`

```python
import secrets

# Returns uniform random in [0, exclusive_upper_bound)
n = secrets.randbelow(100)
```

Built on `os.urandom()` with internal rejection sampling to ensure uniformity.

#### Java: `SecureRandom.nextInt(bound)`

```java
SecureRandom random = new SecureRandom();
int n = random.nextInt(100); // [0, 100)
```

Implementation from `java.util.Random`:
```java
// Rejection sampling for non-power-of-2 bounds
do {
    bits = next(31);
    val = bits % bound;
} while (bits - val + (bound - 1) < 0);
return val;
```

#### Rust: `rand` crate

```rust
use rand::Rng;

let n: u32 = rand::thread_rng().gen_range(0..100);
```

The `rand` crate:
- Uses rejection sampling for `gen_range()`
- Has an optional `unbiased` feature flag for strict uniformity
- By default accepts bias affecting no more than 1 in 2^48 samples

### 7. When Modulo Bias Matters vs. Doesn't

#### When Bias is CRITICAL:

| Scenario | Risk |
|----------|------|
| ECDSA/Schnorr nonce generation | Even 1 bit of bias can enable private key recovery via lattice attacks |
| Cryptographic key derivation | Reduces effective key strength |
| High-security token generation | Enables statistical prediction attacks |
| Lottery/gambling systems | Legal and fairness implications |

**Real-world attacks:**
- PlayStation 3 private key recovery (2010): ECDSA implementation reused nonces
- GnuPG vulnerabilities: Side-channel leaks combined with bias
- Cryptocurrency wallet attacks: Weak nonce generation

#### When Bias is NEGLIGIBLE:

| Scenario | Why It's OK |
|----------|-------------|
| Session IDs with 128+ bits entropy | Statistical attack requires 2^64+ samples |
| User-facing codes (like pairing codes) | Short-lived, rate-limited |
| Non-cryptographic identifiers | No security implications |
| Power-of-2 alphabet sizes | No bias exists (e.g., 32 characters with byte values) |

**Rule of thumb:** If bias ratio is less than `2^-k` where `k` >= security level (typically 128), it's acceptable.

### 8. Performance Considerations

| Method | Avg. Iterations | Entropy Cost | Complexity |
|--------|-----------------|--------------|------------|
| Direct modulo (biased) | 1 | Minimal | O(1) |
| Rejection sampling | ~1.2-2 typical | 20-100% overhead | O(n) expected |
| Large value + modulo | 1 | 4x bytes | O(1) |
| Mask + rejection (Nano ID) | ~1.6 | Variable | O(n) expected |

**Optimization strategies:**
1. **Batch generation:** Request more bytes than needed to minimize CSPRNG calls
2. **Mask optimization:** Use `2^n - 1` masks to maximize acceptance rate
3. **Pre-computation:** Calculate rejection thresholds once, reuse for multiple generations

### 9. Summary of Best Practices

1. **Use power-of-2 alphabet sizes when possible** (2, 4, 8, 16, 32, 64, 128, 256)
   - Eliminates bias entirely with byte-based random sources

2. **Implement rejection sampling for arbitrary ranges**
   - All major crypto libraries do this
   - Batch requests to minimize performance impact

3. **Use platform-provided functions when available:**
   - `arc4random_uniform()` (BSD/macOS)
   - `randombytes_uniform()` (libsodium)
   - `crypto/rand.Int()` (Go)
   - `secrets.randbelow()` (Python)
   - `SecureRandom.nextInt()` (Java)

4. **Document alphabet size decisions**
   - Explain why specific sizes were chosen
   - Protect against future changes that could introduce bias

5. **For extreme security requirements:**
   - Use oversized random values (512 bits) reduced modulo target
   - Makes bias negligible (~2^-260)

### References

- [libsodium randombytes documentation](https://libsodium.gitbook.io/doc/generating_random_data)
- [OpenSSL BN_rand_range documentation](https://www.openssl.org/docs/man1.0.2/man3/BN_rand.html)
- [Signal Protocol documentation](https://signal.org/docs/)
- [MDN Web Crypto API - getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)
- [NIST SP 800-90A Rev. 1](https://csrc.nist.gov/pubs/sp/800/90/a/r1/final)
- [Nano ID - Secure ID Generator](https://github.com/ai/nanoid)
- [OpenBSD arc4random_uniform](https://man.openbsd.org/arc4random.3)
- [The Definitive Guide to Modulo Bias](https://romailler.ch/2020/07/28/crypto-modulo_bias_guide/)
- [Rust rand crate documentation](https://rust-random.github.io/book/guide-dist.html)
- [Go crypto/rand package](https://pkg.go.dev/crypto/rand)
