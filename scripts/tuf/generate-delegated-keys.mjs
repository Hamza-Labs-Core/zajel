#!/usr/bin/env node

/**
 * Generate Ed25519 keypairs for TUF delegated roles (Targets, Snapshot, Timestamp).
 *
 * Usage:
 *   node scripts/tuf/generate-delegated-keys.mjs --role targets
 *   node scripts/tuf/generate-delegated-keys.mjs --all
 *
 * Output: Prints seed (hex) and public key (base64) for each role.
 * The seed is the SIGNING_KEY secret; the public key is the PUBLIC_KEY env var.
 */

import { webcrypto } from 'node:crypto';

const crypto = webcrypto;

const ROLES = ['targets', 'snapshot', 'timestamp'];

async function generateKeypair(role) {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

  // Export private key as PKCS8 and extract the 32-byte seed
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const seedHex = Array.from(seed, b => b.toString(16).padStart(2, '0')).join('');

  // Export public key as raw 32 bytes
  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const pubBase64 = Buffer.from(pubBytes).toString('base64');

  console.log(`\n=== ${role.toUpperCase()} ROLE ===`);
  console.log(`Signing key (hex seed) — use as ${role.toUpperCase()}_SIGNING_KEY secret:`);
  console.log(`  ${seedHex}`);
  console.log(`Public key (base64) — use as ${role.toUpperCase()}_PUBLIC_KEY env var:`);
  console.log(`  ${pubBase64}`);
  console.log(`\nTo set as wrangler secret:`);
  console.log(`  echo "${seedHex}" | wrangler secret put ${role.toUpperCase()}_SIGNING_KEY`);
  console.log(`  wrangler secret put ${role.toUpperCase()}_PUBLIC_KEY`);

  return { role, seedHex, pubBase64 };
}

async function main() {
  const args = process.argv.slice(2);
  const roleArg = args.find(a => a.startsWith('--role='))?.split('=')[1]
    || (args.indexOf('--role') >= 0 ? args[args.indexOf('--role') + 1] : null);
  const generateAll = args.includes('--all');

  if (!roleArg && !generateAll) {
    console.error('Usage: node generate-delegated-keys.mjs --role <targets|snapshot|timestamp>');
    console.error('       node generate-delegated-keys.mjs --all');
    process.exit(1);
  }

  const rolesToGenerate = generateAll ? ROLES : [roleArg];

  for (const role of rolesToGenerate) {
    if (!ROLES.includes(role)) {
      console.error(`Unknown role: ${role}. Must be one of: ${ROLES.join(', ')}`);
      process.exit(1);
    }
    await generateKeypair(role);
  }

  console.log('\n--- IMPORTANT ---');
  console.log('Store the signing key (hex seed) securely. It is the private key.');
  console.log('Never commit signing keys to version control.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
