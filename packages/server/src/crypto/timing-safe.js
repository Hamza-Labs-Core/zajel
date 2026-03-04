/**
 * Constant-time string comparison using HMAC normalization.
 *
 * HMAC both inputs with a random key, producing fixed-length outputs,
 * then XOR-compare the outputs. This eliminates length-dependent timing
 * because HMAC output is always the same size (32 bytes) regardless of input.
 *
 * Security properties:
 * - No early returns based on length mismatch
 * - Always iterates exactly 32 times (HMAC-SHA256 output length)
 * - Timing is independent of input lengths
 * - Random key per comparison prevents oracle attacks
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {Promise<boolean>} Whether the strings are equal
 */
export async function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();

  // Generate a random key per comparison to prevent oracle attacks.
  // Even if an attacker could somehow observe HMAC outputs, the random key
  // makes each comparison independent.
  const key = await crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  // HMAC both inputs — output is always 32 bytes regardless of input length.
  // This normalization step is what makes the comparison timing-safe.
  const [macA, macB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(a)),
    crypto.subtle.sign('HMAC', key, encoder.encode(b)),
  ]);

  // Fixed-length comparison (both are exactly 32 bytes)
  const bufA = new Uint8Array(macA);
  const bufB = new Uint8Array(macB);

  // XOR all 32 bytes. If any byte differs, result will be non-zero.
  // This loop always runs exactly 32 iterations.
  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}
