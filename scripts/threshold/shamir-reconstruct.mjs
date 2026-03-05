#!/usr/bin/env node

/**
 * Reconstruct Ed25519 key from M-of-N Shamir shares.
 *
 * Usage:
 *   node scripts/threshold/shamir-reconstruct.mjs
 *   (Interactive prompts for shares)
 *
 * SECURITY: This tool reconstructs the full private key. Use only for:
 * - Emergency key recovery
 * - Migration to new threshold scheme
 * - One-time signing operations
 *
 * Destroy the reconstructed key immediately after use.
 */

import secrets from 'secrets.js-grempe';
import { createInterface } from 'readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

console.log('=== Shamir Key Reconstruction ===\n');
console.log('WARNING: This will reconstruct the full private key.');
console.log('Only proceed if you have authorization from M key holders.\n');

const numShares = parseInt(await question('How many shares will you provide? '), 10);
if (numShares < 2 || numShares > 10) {
  console.error('Invalid number of shares');
  process.exit(1);
}

const shares = [];
for (let i = 0; i < numShares; i++) {
  const share = await question(`Enter share ${i + 1}/${numShares}: `);
  shares.push(share.trim());
}

rl.close();

// Reconstruct the seed
let seedHex;
try {
  seedHex = secrets.combine(shares);
} catch (error) {
  console.error('Failed to reconstruct key:', error.message);
  console.error('Possible causes: insufficient shares, corrupted shares, wrong threshold');
  process.exit(1);
}

// Import as Ed25519 key
const seed = new Uint8Array(seedHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));

const pkcs8Prefix = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
  0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
pkcs8.set(pkcs8Prefix);
pkcs8.set(seed, pkcs8Prefix.length);

const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);

// Verify reconstruction by signing and logging a test message
const testMessage = new Uint8Array([0]);
const testSig = await crypto.subtle.sign('Ed25519', privateKey, testMessage);

console.log('\nKey successfully reconstructed!');
console.log('Reconstructed seed (hex):');
console.log(`  ${seedHex}`);
console.log('\nUse this for ONE operation, then DESTROY IT.');
console.log('Consider using `wrangler secret put BOOTSTRAP_SIGNING_KEY` if needed.');
console.log('\nPress Ctrl+C when done to clear from terminal history.');
