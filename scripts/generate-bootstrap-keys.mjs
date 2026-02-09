#!/usr/bin/env node

/**
 * Generate Ed25519 keypair for signing bootstrap server responses.
 *
 * Usage:
 *   node scripts/generate-bootstrap-keys.mjs
 *
 * Output:
 *   - Hex-encoded private key seed (for `wrangler secret put BOOTSTRAP_SIGNING_KEY`)
 *   - Base64-encoded public key (for hardcoding in Flutter app)
 *
 * Run twice: once for production, once for QA.
 */

const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

// Export raw private key (32-byte seed)
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
// PKCS8-wrapped Ed25519 key: the last 32 bytes are the raw seed
const seed = privateKeyBytes.slice(-32);
const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

// Export raw public key (32 bytes)
const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

console.log('=== Bootstrap Signing Keypair ===\n');
console.log('Private key seed (hex) — store as Wrangler secret:');
console.log(`  wrangler secret put BOOTSTRAP_SIGNING_KEY`);
console.log(`  Then paste: ${seedHex}\n`);
console.log('Public key (base64) — hardcode in Flutter app:');
console.log(`  ${publicKeyBase64}\n`);
console.log('IMPORTANT: Run this script twice (once for production, once for QA).');
console.log('Keep the private key seeds safe and never commit them.');
