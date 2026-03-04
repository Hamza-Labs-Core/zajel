#!/usr/bin/env node

/**
 * Rotate bootstrap signing keys with zero-downtime.
 *
 * Usage:
 *   node scripts/rotate-bootstrap-keys.mjs [--env=production|qa]
 *
 * Steps:
 * 1. Generate a new Ed25519 keypair
 * 2. Display instructions to store as SECONDARY key in Cloudflare Workers
 * 3. Display instructions to add new public key to Flutter app
 * 4. Wait for confirmation that app update has been deployed
 * 5. Display instructions to promote SECONDARY to PRIMARY
 */

const args = process.argv.slice(2);
const env = args.find((a) => a.startsWith('--env='))?.split('=')[1] || 'production';

console.log(`=== Bootstrap Key Rotation (${env}) ===\n`);

// Generate new keypair
const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

const privateKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
);
const seed = privateKeyBytes.slice(-32);
const seedHex = Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');

const publicKeyBytes = new Uint8Array(
  await crypto.subtle.exportKey('raw', keyPair.publicKey)
);
const publicKeyBase64 = btoa(String.fromCharCode(...publicKeyBytes));

console.log('Step 1: Store the new SECONDARY key in Cloudflare Workers\n');
console.log('  wrangler secret put BOOTSTRAP_SIGNING_KEY_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log(`  Then paste: ${seedHex}\n`);
console.log('  wrangler secret put BOOTSTRAP_KEY_VERSION_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log('  Then paste: v2\n');

console.log('Step 2: Add new public key to Flutter app\n');
console.log(`  Edit packages/app/lib/core/crypto/bootstrap_verifier.dart`);
console.log(`  Add to ${env === 'qa' ? '_qaPublicKeys' : '_productionPublicKeys'}:`);
console.log(`    'v2': '${publicKeyBase64}',\n`);

console.log('Step 3: Deploy app update and wait for user adoption\n');
console.log('  - Build and release new app version with v2 key');
console.log('  - Wait for sufficient user adoption (e.g., 1-2 weeks)');
console.log('  - Monitor logs to ensure no v1-only clients are being rejected\n');

console.log('Step 4: Promote v2 to primary\n');
console.log('  wrangler secret put BOOTSTRAP_SIGNING_KEY --env', env === 'qa' ? 'qa' : '');
console.log(`  Then paste: ${seedHex}`);
console.log('  wrangler secret put BOOTSTRAP_KEY_VERSION --env', env === 'qa' ? 'qa' : '');
console.log('  Then paste: v2\n');

console.log('Step 5: Remove old v1 key (after grace period)\n');
console.log('  wrangler secret delete BOOTSTRAP_SIGNING_KEY_SECONDARY --env', env === 'qa' ? 'qa' : '');
console.log('  wrangler secret delete BOOTSTRAP_KEY_VERSION_SECONDARY --env', env === 'qa' ? 'qa' : '');

// Generate audit log record for key rotation event
const auditRecord = {
  event: 'bootstrap-key-rotation',
  timestamp: new Date().toISOString(),
  environment: env,
  newKeyVersion: 'v2',
  publicKeyHash: Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', publicKeyBytes))
  ).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16),
  publicKeyBase64: publicKeyBase64,
  operator: process.env.USER || 'unknown',
};

console.log('\n--- Audit Log Record ---');
console.log('Save this record to the repository or audit log system:');
console.log(JSON.stringify(auditRecord, null, 2));
console.log('\nRecommended: commit this record to docs/security/audit/key-rotations.jsonl');
console.log(`  echo '${JSON.stringify(auditRecord)}' >> docs/security/audit/key-rotations.jsonl`);
console.log('  git add docs/security/audit/key-rotations.jsonl');
console.log('  git commit -m "audit: record bootstrap key rotation to v2"');

console.log('\nRotation complete!\n');
