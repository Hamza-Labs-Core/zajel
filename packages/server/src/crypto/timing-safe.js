/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 *
 * Uses an XOR-based comparison that always processes all bytes,
 * regardless of where the first difference occurs.
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} Whether the strings are equal
 */
export function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  if (bufA.byteLength !== bufB.byteLength) {
    // Still do a full comparison to avoid leaking length info through timing.
    // Compare bufA against itself so the loop takes the same time.
    let dummy = 0;
    for (let i = 0; i < bufA.byteLength; i++) {
      dummy |= bufA[i] ^ bufA[i];
    }
    // Prevent dead-code elimination
    void dummy;
    return false;
  }

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
