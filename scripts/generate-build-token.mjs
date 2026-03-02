#!/usr/bin/env node

/**
 * Generate a signed build token for app attestation.
 *
 * Usage:
 *   ATTESTATION_SIGNING_KEY=<base64-seed> \
 *   node scripts/generate-build-token.mjs \
 *     --version 1.2.0 \
 *     --platform android \
 *     --binary-path ./build/app/outputs/flutter-apk/app-release.apk
 *
 * Parameters:
 *   --version       App version string (e.g., "1.2.0" or "1.2.0-build.0042")
 *   --platform      Target platform: android|ios|linux|windows|macos|web
 *   --binary-path   Path to the built binary file
 *
 * Environment:
 *   ATTESTATION_SIGNING_KEY   Base64-encoded Ed25519 private key seed (32 bytes)
 *
 * Output (stdout):
 *   BUILD_TOKEN=<base64>         — signed build token for --dart-define
 *   BUILD_HASH=<hex>             — SHA-256 hash of the binary
 *   BUILD_HASH_BASE64=<base64>   — SHA-256 hash of the binary (base64)
 *
 * The build token is a base64-encoded JSON+signature structure:
 *   base64({ payload: base64(JSON), signature: base64(Ed25519(payload)) })
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';

const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle;

// --- Argument parsing ---

const VALID_PLATFORMS = ['android', 'ios', 'linux', 'windows', 'macos', 'web'];

function usage() {
  console.error(`Usage: ATTESTATION_SIGNING_KEY=<base64> node scripts/generate-build-token.mjs \\
  --version <version> --platform <platform> --binary-path <path>

Platforms: ${VALID_PLATFORMS.join(', ')}

Environment variables:
  ATTESTATION_SIGNING_KEY  Base64-encoded Ed25519 private key seed (32 bytes)`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--version':
        args.version = argv[++i];
        break;
      case '--platform':
        args.platform = argv[++i];
        break;
      case '--binary-path':
        args.binaryPath = argv[++i];
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        usage();
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.version) {
  console.error('Error: --version is required');
  usage();
}
if (!args.platform) {
  console.error('Error: --platform is required');
  usage();
}
if (!VALID_PLATFORMS.includes(args.platform)) {
  console.error(`Error: --platform must be one of: ${VALID_PLATFORMS.join(', ')}`);
  usage();
}
if (!args.binaryPath) {
  console.error('Error: --binary-path is required');
  usage();
}

const signingKeyBase64 = process.env.ATTESTATION_SIGNING_KEY;
if (!signingKeyBase64) {
  console.error('Error: ATTESTATION_SIGNING_KEY environment variable is required');
  usage();
}

// --- Read binary and compute hash ---

const binaryPath = resolve(args.binaryPath);
let binaryData;
try {
  binaryData = readFileSync(binaryPath);
} catch (err) {
  console.error(`Error: Cannot read binary at ${binaryPath}: ${err.message}`);
  process.exit(1);
}

const binaryHash = createHash('sha256').update(binaryData).digest();
const binaryHashHex = binaryHash.toString('hex');
const binaryHashBase64 = binaryHash.toString('base64');

// --- Import signing key ---

const seedBytes = Buffer.from(signingKeyBase64, 'base64');
if (seedBytes.length !== 32) {
  console.error(`Error: ATTESTATION_SIGNING_KEY must decode to 32 bytes, got ${seedBytes.length}`);
  process.exit(1);
}

// Wrap the 32-byte seed in PKCS8 ASN.1 for Web Crypto import
// Ed25519 PKCS8 prefix: 16 bytes of ASN.1 header
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const pkcs8Key = new Uint8Array(PKCS8_ED25519_PREFIX.length + seedBytes.length);
pkcs8Key.set(PKCS8_ED25519_PREFIX);
pkcs8Key.set(seedBytes, PKCS8_ED25519_PREFIX.length);

const privateKey = await subtle.importKey(
  'pkcs8',
  pkcs8Key,
  'Ed25519',
  false,
  ['sign']
);

// --- Build and sign token ---

const payload = {
  version: args.version,
  platform: args.platform,
  build_hash: binaryHashHex,
  timestamp: new Date().toISOString(),
};

const payloadJson = JSON.stringify(payload);
const payloadBytes = new TextEncoder().encode(payloadJson);
const payloadBase64 = Buffer.from(payloadBytes).toString('base64');

const signature = new Uint8Array(await subtle.sign('Ed25519', privateKey, payloadBytes));
const signatureBase64 = Buffer.from(signature).toString('base64');

// The build token is: base64(JSON({ payload: base64, signature: base64 }))
const tokenStructure = {
  payload: payloadBase64,
  signature: signatureBase64,
};
const tokenJson = JSON.stringify(tokenStructure);
const buildToken = Buffer.from(tokenJson).toString('base64');

// --- Output ---

// Machine-readable output suitable for CI parsing
console.log(`BUILD_TOKEN=${buildToken}`);
console.log(`BUILD_HASH=${binaryHashHex}`);
console.log(`BUILD_HASH_BASE64=${binaryHashBase64}`);

// Human-readable summary on stderr (so CI can pipe stdout cleanly)
console.error('');
console.error('=== Build Token Generated ===');
console.error(`  Version:   ${args.version}`);
console.error(`  Platform:  ${args.platform}`);
console.error(`  Binary:    ${binaryPath}`);
console.error(`  Hash:      ${binaryHashHex}`);
console.error(`  Timestamp: ${payload.timestamp}`);
console.error(`  Token:     ${buildToken.substring(0, 40)}...`);
console.error('');
console.error('Usage in flutter build:');
console.error(`  flutter build apk --dart-define=BUILD_TOKEN=${buildToken}`);
