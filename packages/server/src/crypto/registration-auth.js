/**
 * Authentication for server registration and deregistration.
 *
 * Supports two modes:
 * 1. Self-registration: Server signs the registration payload with its Ed25519 key
 * 2. Administrative registration: M-of-N operators sign the registration payload
 *
 * Security features:
 * - Timestamp freshness validation (rejects payloads older than 5 minutes)
 * - Used-key tracking in admin signatures (prevents double-count by same operator)
 * - Canonical JSON serialization with sorted top-level keys
 */

/**
 * Maximum age of a registration timestamp before it is rejected (5 minutes).
 */
const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

/**
 * Verify that a server registration is self-signed.
 * The server must sign the registration payload with the Ed25519 key
 * corresponding to the publicKey field.
 *
 * @param {object} payload - { serverId, endpoint, publicKey, region, timestamp }
 * @param {string} signatureBase64 - Ed25519 signature over canonical JSON
 * @returns {Promise<boolean>}
 */
export async function verifySelfSignedRegistration(payload, signatureBase64) {
  try {
    // Require timestamp -- the server must provide it so it can be signed.
    // Falling back to Date.now() would mean the server generated a timestamp
    // that the client could not have known when signing.
    if (!payload.timestamp || typeof payload.timestamp !== 'number') {
      return false;
    }

    // Reject stale timestamps to prevent replay attacks
    const age = Date.now() - payload.timestamp;
    if (age > MAX_TIMESTAMP_AGE_MS || age < -MAX_TIMESTAMP_AGE_MS) {
      return false;
    }

    // Canonical JSON encoding (sorted keys, no whitespace)
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const message = new TextEncoder().encode(canonical);

    // Decode public key (base64 -> bytes)
    const publicKeyBytes = Uint8Array.from(atob(payload.publicKey), c => c.charCodeAt(0));
    if (publicKeyBytes.length !== 32) return false;

    // SPKI wrapper for Ed25519 public key
    const spkiPrefix = new Uint8Array([
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
      0x03, 0x21, 0x00,
    ]);
    const spki = new Uint8Array(spkiPrefix.length + publicKeyBytes.length);
    spki.set(spkiPrefix);
    spki.set(publicKeyBytes, spkiPrefix.length);

    const cryptoKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);

    // Decode signature
    const signatureBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    if (signatureBytes.length !== 64) return false;

    return await crypto.subtle.verify('Ed25519', cryptoKey, signatureBytes, message);
  } catch {
    return false;
  }
}

/**
 * Verify M-of-N administrative signatures on a registration payload.
 * Used when operators manually register a server (not self-registration).
 *
 * Each signature must come from a distinct authorized operator key.
 * A single operator signing twice will only count once toward the threshold.
 *
 * @param {object} payload - Registration payload
 * @param {string[]} signatures - Array of base64 Ed25519 signatures
 * @param {string[]} operatorKeys - Array of authorized operator public keys (base64)
 * @param {number} threshold - Minimum required signatures
 * @returns {Promise<boolean>}
 */
export async function verifyAdminSignatures(payload, signatures, operatorKeys, threshold) {
  if (signatures.length < threshold) return false;

  // Require timestamp for replay protection
  if (!payload.timestamp || typeof payload.timestamp !== 'number') {
    return false;
  }

  // Reject stale timestamps
  const age = Date.now() - payload.timestamp;
  if (age > MAX_TIMESTAMP_AGE_MS || age < -MAX_TIMESTAMP_AGE_MS) {
    return false;
  }

  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const message = new TextEncoder().encode(canonical);

  let validCount = 0;
  // Track which operator keys have already been matched to prevent
  // a single operator from satisfying multiple signature slots.
  const usedKeys = new Set();

  for (const sigBase64 of signatures) {
    // Try to verify against each operator key
    for (const keyBase64 of operatorKeys) {
      // Skip keys that have already been matched to a previous signature
      if (usedKeys.has(keyBase64)) continue;

      try {
        const keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
        if (keyBytes.length !== 32) continue;

        const spkiPrefix = new Uint8Array([
          0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
          0x03, 0x21, 0x00,
        ]);
        const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
        spki.set(spkiPrefix);
        spki.set(keyBytes, spkiPrefix.length);

        const cryptoKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);
        const sigBytes = Uint8Array.from(atob(sigBase64), c => c.charCodeAt(0));
        if (sigBytes.length !== 64) continue;

        const valid = await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, message);
        if (valid) {
          validCount++;
          usedKeys.add(keyBase64);
          break; // Move to next signature
        }
      } catch {
        continue;
      }
    }
  }

  return validCount >= threshold;
}
