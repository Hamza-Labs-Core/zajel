#!/usr/bin/env node

/**
 * Generate Ed25519 keypair for attestation signing (build tokens).
 *
 * Usage:
 *   node scripts/generate-attestation-keys.mjs
 *
 * Output:
 *   - Private key seed (base64) — for `ATTESTATION_SIGNING_KEY` CF Worker secret
 *   - Public key (base64) — for embedding in the Flutter app (attestation verification)
 *
 * The private key is used by CI to sign build tokens during the release pipeline.
 * The public key is compiled into the app binary so the app can verify build tokens
 * and the bootstrap server can verify token signatures.
 *
 * Run twice: once for production, once for QA.
 */

import { webcrypto } from 'node:crypto';

// Node.js < 20 compat: use webcrypto.subtle if globalThis.crypto.subtle is unavailable
const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle;

const keyPair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);

// Export PKCS8 private key — last 32 bytes are the raw Ed25519 seed
const pkcs8Bytes = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey));
const seed = pkcs8Bytes.slice(-32);
const seedBase64 = Buffer.from(seed).toString('base64');
const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

// Export raw 32-byte public key
const publicKeyBytes = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
const publicKeyBase64 = Buffer.from(publicKeyBytes).toString('base64');

console.log('=== Attestation Signing Keypair ===\n');
console.log('Private key seed (base64) — store as Wrangler/CI secret:');
console.log(`  wrangler secret put ATTESTATION_SIGNING_KEY`);
console.log(`  Then paste: ${seedBase64}\n`);
console.log('Private key seed (hex) — alternative format:');
console.log(`  ${seedHex}\n`);
console.log('Public key (base64) — embed in Flutter app and bootstrap server:');
console.log(`  ${publicKeyBase64}\n`);
console.log('IMPORTANT: Run this script twice (once for production, once for QA).');
console.log('Keep the private key seeds safe and never commit them.');
