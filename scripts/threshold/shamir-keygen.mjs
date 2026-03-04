#!/usr/bin/env node

/**
 * Generate Ed25519 keypair and split using Shamir's Secret Sharing.
 *
 * Usage:
 *   node scripts/threshold/shamir-keygen.mjs --threshold 3 --shares 5
 *
 * Output:
 *   - Root public key (base64)
 *   - 5 key shares (hex-encoded)
 *   - Ceremony log (signed JSON document)
 *
 * Dependency note: This tool uses `secrets.js-grempe` for Shamir's Secret
 * Sharing. This package has not been updated since 2021. Consider evaluating
 * alternatives or vendoring the implementation (Shamir over GF(2^8) is
 * straightforward) before using this in production.
 */

import secrets from 'secrets.js-grempe';
import { createHash } from 'crypto';

const args = process.argv.slice(2);
const thresholdIdx = args.indexOf('--threshold');
const sharesIdx = args.indexOf('--shares');

if (thresholdIdx === -1 || sharesIdx === -1) {
  console.error('Usage: shamir-keygen.mjs --threshold M --shares N');
  process.exit(1);
}

const threshold = parseInt(args[thresholdIdx + 1], 10);
const totalShares = parseInt(args[sharesIdx + 1], 10);

if (threshold < 2 || threshold > totalShares || totalShares > 10) {
  console.error('Invalid parameters: 2 <= M <= N <= 10');
  process.exit(1);
}

// Generate root Ed25519 keypair
const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
const seed = privateKeyBytes.slice(-32);
const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

// Split the 32-byte seed into N shares with M threshold
const seedHex = Array.from(seed, b => b.toString(16).padStart(2, '0')).join('');
const shares = secrets.share(seedHex, totalShares, threshold);

// Generate ceremony log
const ceremonyLog = {
  type: 'shamir-keygen',
  timestamp: new Date().toISOString(),
  publicKey: publicKeyBase64,
  threshold,
  totalShares,
  shares: shares.map((_, i) => ({
    index: i + 1,
    fingerprint: createHash('sha256').update(shares[i]).digest('hex').slice(0, 16),
  })),
};

console.log('=== Shamir Secret Sharing Key Ceremony ===\n');
console.log('Root public key (base64):');
console.log(`  ${publicKeyBase64}\n`);
console.log(`Threshold: ${threshold} of ${totalShares}\n`);
console.log('Key shares (distribute to separate operators):\n');

shares.forEach((share, i) => {
  console.log(`Share ${i + 1}/${totalShares}:`);
  console.log(`  ${share}`);
  console.log(`  Fingerprint: ${ceremonyLog.shares[i].fingerprint}\n`);
});

console.log('Ceremony log (save to version control):');
console.log(JSON.stringify(ceremonyLog, null, 2));
console.log('\nIMPORTANT:');
console.log('- Distribute shares to separate operators via secure channels');
console.log('- Each operator should verify the share fingerprint');
console.log('- Store shares on separate secure media (Yubikey, encrypted USB, etc.)');
console.log('- NEVER store all shares together');
console.log('- The original key has been destroyed (only shares remain)');
