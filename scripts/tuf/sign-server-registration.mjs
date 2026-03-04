#!/usr/bin/env node

/**
 * Sign a VPS server registration payload for proof-of-key-ownership.
 *
 * Usage:
 *   node scripts/tuf/sign-server-registration.mjs \
 *     --server-id "ed25519:<pubkey>" \
 *     --endpoint "wss://your-server.example.com:8443" \
 *     --public-key "<base64-ed25519-public-key>" \
 *     --private-key "<hex-ed25519-seed>"
 *
 * Output: JSON with the registration payload and signature, ready to POST to /servers.
 *
 * The signature proves the registrant controls the private key corresponding
 * to the claimed publicKey, preventing unauthorized registrations.
 */

import { webcrypto } from 'node:crypto';

const crypto = webcrypto;

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {};

  const flags = ['--server-id', '--endpoint', '--public-key', '--private-key'];

  for (const flag of flags) {
    // Try --flag=value format
    const eqArg = args.find(a => a.startsWith(flag + '='));
    if (eqArg) {
      result[flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = eqArg.split('=').slice(1).join('=');
      continue;
    }
    // Try --flag value format
    const idx = args.indexOf(flag);
    if (idx >= 0 && idx + 1 < args.length) {
      result[flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[idx + 1];
    }
  }

  return result;
}

async function signPayload(hexSeed, payload) {
  const seed = new Uint8Array(hexSeed.match(/.{2}/g).map(b => parseInt(b, 16)));

  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05,
    0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  const data = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign('Ed25519', key, data);

  const bytes = new Uint8Array(signature);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, 'binary').toString('base64');
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.serverId || !args.endpoint || !args.publicKey || !args.privateKey) {
    console.error('Usage: node sign-server-registration.mjs \\');
    console.error('  --server-id "ed25519:<pubkey>" \\');
    console.error('  --endpoint "wss://your-server.example.com:8443" \\');
    console.error('  --public-key "<base64-ed25519-public-key>" \\');
    console.error('  --private-key "<hex-ed25519-seed>"');
    console.error('');
    console.error('The signature proves you control the private key corresponding to the claimed public key.');
    process.exit(1);
  }

  const { serverId, endpoint, publicKey, privateKey } = args;

  // The payload format must match server-registry-do.js verifyRegistrationSignature
  const payload = `zajel-server-registration|${serverId}|${endpoint}|${publicKey}`;

  console.log('\nSigning registration payload...');
  console.log(`  serverId:  ${serverId}`);
  console.log(`  endpoint:  ${endpoint}`);
  console.log(`  publicKey: ${publicKey}`);
  console.log(`  payload:   ${payload}`);

  const signature = await signPayload(privateKey, payload);

  console.log(`\n  signature: ${signature}`);

  const registrationBody = {
    serverId,
    endpoint,
    publicKey,
    registrationSignature: signature,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
  };

  console.log('\n--- Registration JSON (POST to /servers) ---');
  console.log(JSON.stringify(registrationBody, null, 2));

  console.log('\n--- curl command ---');
  console.log(`curl -X POST https://signal.zajel.hamzalabs.dev/servers \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -H "Authorization: Bearer <SERVER_REGISTRY_SECRET>" \\`);
  console.log(`  -d '${JSON.stringify(registrationBody)}'`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
