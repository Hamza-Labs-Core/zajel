/**
 * Attestation cryptographic utilities for build token verification,
 * challenge generation, HMAC computation, and session token signing.
 *
 * Uses Web Crypto API (available in Cloudflare Workers runtime).
 */

import { hexToBytes } from './signing.js';

/**
 * Import an Ed25519 public key from a base64-encoded raw key (32 bytes).
 * @param {string} base64Key - Base64-encoded 32-byte Ed25519 public key
 * @returns {Promise<CryptoKey>}
 */
export async function importVerifyKey(base64Key) {
  const keyBytes = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));

  // SPKI prefix for Ed25519: ASN.1 wrapper around the 32-byte public key
  const spkiPrefix = new Uint8Array([
    0x30, 0x2a, // SEQUENCE (42 bytes)
    0x30, 0x05, // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
    0x03, 0x21, 0x00, // BIT STRING (33 bytes, 0 unused bits)
  ]);

  const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
  spki.set(spkiPrefix);
  spki.set(keyBytes, spkiPrefix.length);

  return crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);
}

/**
 * Import an Ed25519 signing key from a hex-encoded 32-byte seed.
 * Uses PKCS8 wrapping same as signing.js.
 * Key is extractable to allow public key derivation for build token verification.
 * @param {string} hexSeed - 64-character hex string (32 bytes)
 * @returns {Promise<CryptoKey>}
 */
export async function importAttestationSigningKey(hexSeed) {
  const seed = hexToBytes(hexSeed);

  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22,
    0x04, 0x20,
  ]);

  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  return crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
}

/**
 * Import an Ed25519 signing key for session tokens (non-extractable).
 * The private key material cannot be exported from this key object.
 * @param {string} hexSeed - 64-character hex string (32 bytes)
 * @returns {Promise<CryptoKey>}
 */
export async function importSessionSigningKey(hexSeed) {
  const seed = hexToBytes(hexSeed);

  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e,
    0x02, 0x01, 0x00,
    0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22,
    0x04, 0x20,
  ]);

  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  return crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
}

/**
 * Extract the public key (base64) from a signing key.
 * @param {CryptoKey} signingKey - Ed25519 private key (must be extractable)
 * @returns {Promise<string>} Base64-encoded raw public key (32 bytes)
 */
export async function exportPublicKeyBase64(signingKey) {
  // Derive the public key by exporting as PKCS8, then re-importing and exporting SPKI
  // Actually, we can generate the keypair from the private key export
  // Simpler: export PKCS8, extract seed, then use generateKey? No.
  // Web Crypto doesn't let us extract just the public key from a private key directly.
  // But we can export the jwk and use the x parameter.
  const jwk = await crypto.subtle.exportKey('jwk', signingKey);
  // jwk.x is the base64url-encoded public key
  // Convert base64url to base64
  const base64url = jwk.x;
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  // Pad if necessary
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return padded;
}

/**
 * Verify an Ed25519 signature on a build token payload.
 * @param {CryptoKey} publicKey - Ed25519 public key for verification
 * @param {string} payload - JSON string payload that was signed
 * @param {string} signatureBase64 - Base64-encoded Ed25519 signature
 * @returns {Promise<boolean>}
 */
export async function verifyBuildTokenSignature(publicKey, payload, signatureBase64) {
  const sigBytes = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
  const data = new TextEncoder().encode(payload);
  return crypto.subtle.verify('Ed25519', publicKey, sigBytes, data);
}

/**
 * Sign a payload with Ed25519 and return base64 signature.
 * @param {CryptoKey} privateKey - Ed25519 private key
 * @param {string} payload - UTF-8 string to sign
 * @returns {Promise<string>} Base64-encoded signature
 */
export async function signPayloadEd25519(privateKey, payload) {
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Generate a cryptographically random nonce (hex string).
 * @param {number} byteLength - Number of random bytes (default 32)
 * @returns {string} Hex-encoded nonce
 */
export function generateNonce(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute HMAC-SHA256 over data with a given key.
 * Used for binary region challenge-response.
 * @param {Uint8Array} data - The data to HMAC
 * @param {string} nonceHex - Hex-encoded nonce used as HMAC key
 * @returns {Promise<string>} Hex-encoded HMAC
 */
export async function computeHmac(data, nonceHex) {
  const keyBytes = hexToBytes(nonceHex);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a signed session token.
 * @param {CryptoKey} signingKey - Ed25519 private key for signing session tokens
 * @param {object} tokenData - { device_id, build_version, expires_at }
 * @returns {Promise<string>} Signed session token in format: base64(payload).base64(signature)
 */
export async function createSessionToken(signingKey, tokenData) {
  const payload = JSON.stringify(tokenData);
  const payloadBase64 = btoa(payload);
  const signature = await signPayloadEd25519(signingKey, payload);
  return `${payloadBase64}.${signature}`;
}

/**
 * Verify and decode a session token.
 * @param {CryptoKey} publicKey - Ed25519 public key for verification
 * @param {string} token - Session token in format: base64(payload).base64(signature)
 * @returns {Promise<object|null>} Decoded token data or null if invalid
 */
export async function verifySessionToken(publicKey, token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadBase64, signature] = parts;
    const payload = atob(payloadBase64);

    const valid = await verifyBuildTokenSignature(publicKey, payload, signature);
    if (!valid) return null;

    const data = JSON.parse(payload);

    // Check expiration
    if (data.expires_at && Date.now() > data.expires_at) return null;

    return data;
  } catch {
    return null;
  }
}

/**
 * Compare semver versions.
 * @param {string} a - Version string (e.g., "1.2.3")
 * @param {string} b - Version string (e.g., "1.3.0")
 * @returns {number} -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const va = partsA[i] || 0;
    const vb = partsB[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}
