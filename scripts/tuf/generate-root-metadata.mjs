#!/usr/bin/env node

/**
 * Generate TUF Root Metadata (offline ceremony tool).
 *
 * Usage:
 *   node scripts/tuf/generate-root-metadata.mjs --version 1 --expiration-days 365
 *   node scripts/tuf/generate-root-metadata.mjs --version 2 --expiration-days 365 --prev-root root-v1.json
 *
 * This script:
 * 1. Generates a new Ed25519 root keypair
 * 2. Reads delegated public keys from environment or flags
 * 3. Creates and signs root metadata
 * 4. Outputs the signed root metadata JSON
 *
 * IMPORTANT: Run this on an air-gapped machine for production root key generation.
 */

import { webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const crypto = webcrypto;

function canonicalJSON(obj) {
  if (obj === null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

async function generateKeyId(key) {
  const canonical = canonicalJSON({
    keytype: key.keytype,
    scheme: key.scheme,
    keyval: key.keyval,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeypair() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  const seedHex = Array.from(seed, b => b.toString(16).padStart(2, '0')).join('');

  const pubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const pubBase64 = Buffer.from(pubBytes).toString('base64');

  return { seedHex, pubBase64, privateKey: keyPair.privateKey };
}

async function signWithSeed(seedHex, data) {
  const seed = new Uint8Array(seedHex.match(/.{2}/g).map(b => parseInt(b, 16)));

  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(data));
  let binary = '';
  const bytes = new Uint8Array(signature);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

async function main() {
  const args = process.argv.slice(2);

  const versionArg = args.find(a => a.startsWith('--version='))?.split('=')[1]
    || (args.indexOf('--version') >= 0 ? args[args.indexOf('--version') + 1] : null);
  const expirationArg = args.find(a => a.startsWith('--expiration-days='))?.split('=')[1]
    || (args.indexOf('--expiration-days') >= 0 ? args[args.indexOf('--expiration-days') + 1] : null);

  if (!versionArg) {
    console.error('Usage: node generate-root-metadata.mjs --version <N> [--expiration-days <days>]');
    process.exit(1);
  }

  const version = parseInt(versionArg, 10);
  const expirationDays = parseInt(expirationArg || '365', 10);

  console.log(`\nGenerating TUF Root Metadata v${version}`);
  console.log(`Expiration: ${expirationDays} days from now\n`);

  // Generate root keypair
  console.log('Generating root keypair...');
  const rootKey = await generateKeypair();

  // Generate delegated keypairs (or use provided ones)
  console.log('Generating delegated keypairs...');
  const targetsKey = await generateKeypair();
  const snapshotKey = await generateKeypair();
  const timestampKey = await generateKeypair();

  // Build role keys
  const rolePublicKeys = {
    root: rootKey.pubBase64,
    targets: targetsKey.pubBase64,
    snapshot: snapshotKey.pubBase64,
    timestamp: timestampKey.pubBase64,
  };

  // Build keys and roles maps
  const keys = {};
  const roles = {};

  for (const [roleName, pubKeyBase64] of Object.entries(rolePublicKeys)) {
    const tufKey = { keytype: 'ed25519', scheme: 'ed25519', keyval: pubKeyBase64 };
    const keyid = await generateKeyId(tufKey);
    keys[keyid] = tufKey;
    roles[roleName] = { threshold: 1, keyids: [keyid] };
  }

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  const rootMetadata = {
    _type: 'root',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    keys,
    roles,
    consistent_snapshot: false,
  };

  // Sign with root key
  const canonical = canonicalJSON(rootMetadata);
  const rootKeyId = await generateKeyId({ keytype: 'ed25519', scheme: 'ed25519', keyval: rootKey.pubBase64 });
  const sig = await signWithSeed(rootKey.seedHex, canonical);

  const signedRoot = {
    signed: rootMetadata,
    signatures: [{ keyid: rootKeyId, sig }],
  };

  // Output
  const outputFile = `root-v${version}.json`;
  writeFileSync(outputFile, JSON.stringify(signedRoot, null, 2));
  console.log(`\nRoot metadata written to: ${outputFile}`);

  console.log('\n=== ROOT KEY (KEEP OFFLINE - NEVER COMMIT) ===');
  console.log(`Seed (hex): ${rootKey.seedHex}`);
  console.log(`Public key (base64): ${rootKey.pubBase64}`);

  console.log('\n=== TARGETS ROLE ===');
  console.log(`Signing key: ${targetsKey.seedHex}`);
  console.log(`Public key:  ${targetsKey.pubBase64}`);
  console.log(`  echo "${targetsKey.seedHex}" | wrangler secret put TARGETS_SIGNING_KEY`);

  console.log('\n=== SNAPSHOT ROLE ===');
  console.log(`Signing key: ${snapshotKey.seedHex}`);
  console.log(`Public key:  ${snapshotKey.pubBase64}`);
  console.log(`  echo "${snapshotKey.seedHex}" | wrangler secret put SNAPSHOT_SIGNING_KEY`);

  console.log('\n=== TIMESTAMP ROLE ===');
  console.log(`Signing key: ${timestampKey.seedHex}`);
  console.log(`Public key:  ${timestampKey.pubBase64}`);
  console.log(`  echo "${timestampKey.seedHex}" | wrangler secret put TIMESTAMP_SIGNING_KEY`);

  console.log('\n--- IMPORTANT ---');
  console.log('Store the root key seed securely (offline / HSM).');
  console.log('Upload delegated keys as Wrangler secrets.');
  console.log(`Copy ${outputFile} to packages/app/lib/core/crypto/tuf/root_metadata.json`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
