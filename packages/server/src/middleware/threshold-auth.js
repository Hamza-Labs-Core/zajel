/**
 * Threshold authentication middleware for M-of-N operator verification.
 *
 * Provides functions to:
 * 1. Parse threshold policy from environment configuration
 * 2. Verify that M valid signatures from N authorized operator keys are present
 * 3. Integrate with request handling for admin operations
 *
 * Security features:
 * - Used-key tracking prevents the same operator from counting twice
 * - Timestamp freshness validation rejects stale payloads
 * - Canonical JSON serialization for deterministic signature verification
 */

import { verifyAdminSignatures } from '../crypto/registration-auth.js';

/**
 * Default threshold when ADMIN_THRESHOLD is not configured.
 */
const DEFAULT_THRESHOLD = 2;

/**
 * Parse threshold policy from environment variables.
 *
 * Reads OPERATOR_PUBLIC_KEYS (comma-separated base64) and ADMIN_THRESHOLD (number).
 * Returns null if operator keys are not configured.
 *
 * @param {object} env - Worker environment bindings
 * @returns {{ operatorKeys: string[], threshold: number } | null}
 */
export function parseThresholdPolicy(env) {
  if (!env.OPERATOR_PUBLIC_KEYS) return null;

  const operatorKeys = env.OPERATOR_PUBLIC_KEYS
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (operatorKeys.length === 0) return null;

  const threshold = parseInt(env.ADMIN_THRESHOLD || String(DEFAULT_THRESHOLD), 10);

  // Threshold must be between 1 and total operator count
  const clampedThreshold = Math.max(1, Math.min(threshold, operatorKeys.length));

  return { operatorKeys, threshold: clampedThreshold };
}

/**
 * Verify M-of-N operator signatures on a payload.
 *
 * This is a convenience wrapper around verifyAdminSignatures that:
 * 1. Parses threshold policy from env
 * 2. Validates signatures against the policy
 *
 * @param {object} payload - The payload that was signed
 * @param {string[]} signatures - Array of base64 Ed25519 signatures
 * @param {object} env - Worker environment bindings
 * @param {object} [options] - Optional overrides
 * @param {number} [options.threshold] - Override the threshold from env
 * @returns {Promise<{ verified: boolean, validCount: number, threshold: number, operatorCount: number }>}
 */
export async function verifyThresholdSignatures(payload, signatures, env, options = {}) {
  const policy = parseThresholdPolicy(env);

  if (!policy) {
    return {
      verified: false,
      validCount: 0,
      threshold: 0,
      operatorCount: 0,
      error: 'Operator keys not configured',
    };
  }

  const threshold = options.threshold || policy.threshold;

  if (!signatures || !Array.isArray(signatures) || signatures.length === 0) {
    return {
      verified: false,
      validCount: 0,
      threshold,
      operatorCount: policy.operatorKeys.length,
      error: 'No signatures provided',
    };
  }

  const verified = await verifyAdminSignatures(
    payload,
    signatures,
    policy.operatorKeys,
    threshold
  );

  // Count valid signatures for reporting (re-verify individually)
  let validCount = 0;
  const usedKeys = new Set();
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const message = new TextEncoder().encode(canonical);

  for (const sigBase64 of signatures) {
    for (const keyBase64 of policy.operatorKeys) {
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
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return {
    verified,
    validCount,
    threshold,
    operatorCount: policy.operatorKeys.length,
  };
}

/**
 * Create an error response for threshold auth failures.
 *
 * @param {object} result - Result from verifyThresholdSignatures
 * @param {object} corsHeaders - CORS headers
 * @returns {Response}
 */
export function thresholdAuthErrorResponse(result, corsHeaders) {
  const status = result.error === 'Operator keys not configured' ? 503 : 403;
  const message = result.error || `Insufficient valid operator signatures: ${result.validCount} of ${result.threshold} required`;

  return new Response(
    JSON.stringify({
      error: message,
      validSignatures: result.validCount,
      requiredSignatures: result.threshold,
      totalOperators: result.operatorCount,
    }),
    { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
  );
}
