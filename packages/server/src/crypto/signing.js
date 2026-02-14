/**
 * Ed25519 signing utilities for bootstrap server responses.
 *
 * Uses Web Crypto API (available in Cloudflare Workers runtime).
 */

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Import an Ed25519 signing key from a 32-byte hex-encoded seed.
 *
 * The seed is wrapped in PKCS8 format since Web Crypto requires it.
 * @param {string} hexSeed - 64-character hex string (32 bytes)
 * @returns {Promise<CryptoKey>}
 */
export async function importSigningKey(hexSeed) {
  const seed = hexToBytes(hexSeed);

  // PKCS8 prefix for Ed25519: ASN.1 wrapper around the 32-byte seed
  // RFC 8410 / RFC 5958 structure
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, // SEQUENCE (46 bytes)
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x05, // SEQUENCE (5 bytes)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
    0x04, 0x22, // OCTET STRING (34 bytes)
    0x04, 0x20, // OCTET STRING (32 bytes) — the actual key seed
  ]);

  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  return crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
}

/**
 * Sign a UTF-8 string payload and return a base64 signature.
 * @param {CryptoKey} key - Ed25519 private key
 * @param {string} payload - UTF-8 string to sign
 * @returns {Promise<string>} Base64-encoded signature
 */
export async function signPayload(key, payload) {
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign('Ed25519', key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
