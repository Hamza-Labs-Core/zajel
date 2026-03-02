#!/usr/bin/env node

/**
 * Self-test for attestation CI tooling.
 *
 * Exercises the full attestation flow end-to-end using in-process logic
 * (no external server needed):
 *
 *   1. Generate Ed25519 attestation keypair
 *   2. Create a dummy binary file
 *   3. Generate a build token (sign it)
 *   4. Verify the build token signature
 *   5. Generate region hashes for the binary
 *   6. Simulate a challenge-response flow
 *   7. Verify challenge responses match (genuine binary)
 *   8. Verify challenge responses FAIL for a tampered binary
 *
 * Usage:
 *   node scripts/test-attestation-scripts.mjs
 *
 * Exit code 0 = all tests pass, non-zero = failure.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    console.error(`    Expected: ${expected}`);
    console.error(`    Actual:   ${actual}`);
    failed++;
  }
}

// Ed25519 PKCS8 prefix (16 bytes of ASN.1 header)
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

// ============================================================
// Test 1: Key Generation
// ============================================================

console.log('\n=== Test 1: Key Generation ===');

const keyPair = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);

// Export private key seed
const pkcs8Bytes = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey));
const seed = pkcs8Bytes.slice(-32);
const seedBase64 = Buffer.from(seed).toString('base64');

// Export public key
const publicKeyBytes = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
const publicKeyBase64 = Buffer.from(publicKeyBytes).toString('base64');

assert(seed.length === 32, 'Private key seed is 32 bytes');
assert(publicKeyBytes.length === 32, 'Public key is 32 bytes');
assert(seedBase64.length > 0, 'Private key base64 is non-empty');
assert(publicKeyBase64.length > 0, 'Public key base64 is non-empty');

// Verify we can re-import the seed
const reimportPkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
reimportPkcs8.set(PKCS8_ED25519_PREFIX);
reimportPkcs8.set(seed, PKCS8_ED25519_PREFIX.length);

const reimportedKey = await subtle.importKey('pkcs8', reimportPkcs8, 'Ed25519', false, ['sign']);
assert(reimportedKey !== null, 'Private key seed can be re-imported');

// ============================================================
// Test 2: Create Dummy Binary
// ============================================================

console.log('\n=== Test 2: Create Dummy Binary ===');

// Create a 1MB dummy binary with known content
const BINARY_SIZE = 1024 * 1024;
const dummyBinary = Buffer.alloc(BINARY_SIZE);

// Fill with pseudo-random but deterministic data
for (let i = 0; i < BINARY_SIZE; i++) {
  dummyBinary[i] = (i * 37 + 13) & 0xFF;
}

const tmpBinaryPath = join(tmpdir(), `zajel-test-binary-${process.pid}.bin`);
writeFileSync(tmpBinaryPath, dummyBinary);

const readBack = readFileSync(tmpBinaryPath);
assertEqual(readBack.length, BINARY_SIZE, `Dummy binary is ${BINARY_SIZE} bytes`);

const binaryHash = createHash('sha256').update(dummyBinary).digest('hex');
assert(binaryHash.length === 64, 'Binary SHA-256 hash is 64 hex chars');

// ============================================================
// Test 3: Build Token Generation
// ============================================================

console.log('\n=== Test 3: Build Token Generation ===');

const payload = {
  version: '1.0.0-test',
  platform: 'linux',
  build_hash: binaryHash,
  timestamp: new Date().toISOString(),
};

const payloadJson = JSON.stringify(payload);
const payloadBytes = new TextEncoder().encode(payloadJson);
const payloadBase64 = Buffer.from(payloadBytes).toString('base64');

const signature = new Uint8Array(await subtle.sign('Ed25519', keyPair.privateKey, payloadBytes));
const signatureBase64 = Buffer.from(signature).toString('base64');

const tokenStructure = {
  payload: payloadBase64,
  signature: signatureBase64,
};
const buildToken = Buffer.from(JSON.stringify(tokenStructure)).toString('base64');

assert(signature.length === 64, 'Ed25519 signature is 64 bytes');
assert(buildToken.length > 0, 'Build token is non-empty');

// ============================================================
// Test 4: Build Token Verification
// ============================================================

console.log('\n=== Test 4: Build Token Verification ===');

// Decode the token
const decodedToken = JSON.parse(Buffer.from(buildToken, 'base64').toString('utf8'));
assert(decodedToken.payload !== undefined, 'Token has payload field');
assert(decodedToken.signature !== undefined, 'Token has signature field');

// Decode payload
const decodedPayloadBytes = Buffer.from(decodedToken.payload, 'base64');
const decodedPayload = JSON.parse(decodedPayloadBytes.toString('utf8'));
assertEqual(decodedPayload.version, '1.0.0-test', 'Decoded version matches');
assertEqual(decodedPayload.platform, 'linux', 'Decoded platform matches');
assertEqual(decodedPayload.build_hash, binaryHash, 'Decoded build_hash matches');

// Verify signature with public key
const sigBytes = Buffer.from(decodedToken.signature, 'base64');
const isValid = await subtle.verify('Ed25519', keyPair.publicKey, sigBytes, decodedPayloadBytes);
assert(isValid === true, 'Signature verification succeeds with correct public key');

// Tamper with payload and verify it fails
const tamperedPayload = Buffer.from(decodedPayloadBytes);
tamperedPayload[0] = tamperedPayload[0] ^ 0xFF; // flip a byte
const isTamperedValid = await subtle.verify('Ed25519', keyPair.publicKey, sigBytes, tamperedPayload);
assert(isTamperedValid === false, 'Signature verification fails with tampered payload');

// ============================================================
// Test 5: Region Hash Generation
// ============================================================

console.log('\n=== Test 5: Region Hash Generation ===');

function generateRegionHashes(data, regionCount) {
  const regions = [];
  const totalSize = data.length;
  const MIN_REGION_SIZE = 512;
  const MAX_REGION_SIZE = 16384;

  const hash = createHash('sha256').update(data).digest('hex');
  const evenRegionCount = Math.min(regionCount, Math.ceil(totalSize / MIN_REGION_SIZE));
  const stride = Math.floor(totalSize / evenRegionCount);
  const regionSize = Math.min(MAX_REGION_SIZE, Math.max(MIN_REGION_SIZE, stride));

  for (let i = 0; i < evenRegionCount; i++) {
    const offset = i * stride;
    const length = Math.min(regionSize, totalSize - offset);
    if (length <= 0) break;

    const regionData = data.subarray(offset, offset + length);
    const regionHash = createHash('sha256').update(regionData).digest('hex');
    regions.push({ offset, length, hash: regionHash });
  }

  // Add deterministic random samples
  const extraSamples = Math.min(10, Math.floor(regionCount * 0.1));
  let prngState = 0;
  for (const byte of Buffer.from(hash, 'hex').subarray(0, 8)) {
    prngState = (prngState * 256 + byte) >>> 0;
  }

  for (let i = 0; i < extraSamples; i++) {
    prngState = (prngState * 1664525 + 1013904223) >>> 0;
    const offset = prngState % Math.max(1, totalSize - MIN_REGION_SIZE);
    const length = Math.min(MIN_REGION_SIZE + (prngState % (MAX_REGION_SIZE - MIN_REGION_SIZE)), totalSize - offset);

    const regionData = data.subarray(offset, offset + length);
    const regionHash = createHash('sha256').update(regionData).digest('hex');
    regions.push({ offset, length, hash: regionHash });
  }

  return regions;
}

const regions = generateRegionHashes(dummyBinary, 100);

assert(regions.length > 0, `Generated ${regions.length} region hashes`);
assert(regions.length >= 50, 'Generated at least 50 regions for 1MB binary');

// Verify all regions have required fields
let allRegionsValid = true;
for (const r of regions) {
  if (typeof r.offset !== 'number' || typeof r.length !== 'number' || typeof r.hash !== 'string') {
    allRegionsValid = false;
    break;
  }
  if (r.offset < 0 || r.length <= 0 || r.offset + r.length > BINARY_SIZE) {
    allRegionsValid = false;
    break;
  }
  if (r.hash.length !== 64) {
    allRegionsValid = false;
    break;
  }
}
assert(allRegionsValid, 'All regions have valid offset, length, and hash');

// Verify determinism: same binary produces same regions
const regions2 = generateRegionHashes(dummyBinary, 100);
assertEqual(regions.length, regions2.length, 'Region generation is deterministic (same count)');
let allMatch = true;
for (let i = 0; i < regions.length; i++) {
  if (regions[i].offset !== regions2[i].offset || regions[i].length !== regions2[i].length || regions[i].hash !== regions2[i].hash) {
    allMatch = false;
    break;
  }
}
assert(allMatch, 'Region generation is deterministic (same content)');

// ============================================================
// Test 6: Challenge-Response Flow (Genuine Binary)
// ============================================================

console.log('\n=== Test 6: Challenge-Response Flow (Genuine Binary) ===');

// Simulate bootstrap generating a challenge
const nonce = randomBytes(32).toString('hex');

// Pick 5 random regions from the stored reference
const challengeRegions = [];
for (let i = 0; i < 5; i++) {
  const idx = Math.floor(Math.random() * regions.length);
  challengeRegions.push({
    region_index: idx,
    offset: regions[idx].offset,
    length: regions[idx].length,
  });
}

const challenge = { nonce, regions: challengeRegions };
assert(challenge.regions.length === 5, 'Challenge has 5 regions');

// Simulate app responding: read own binary at specified offsets, compute HMAC(region_bytes, nonce)
function computeChallengeResponse(binary, challenge) {
  const responses = [];
  for (const region of challenge.regions) {
    const regionData = binary.subarray(region.offset, region.offset + region.length);
    const hmac = createHmac('sha256', challenge.nonce).update(regionData).digest('hex');
    responses.push({
      region_index: region.region_index,
      hmac,
    });
  }
  return responses;
}

const appResponses = computeChallengeResponse(dummyBinary, challenge);
assertEqual(appResponses.length, 5, 'App produced 5 challenge responses');

// Simulate bootstrap verifying: re-compute HMACs from stored reference data
// In a real system, bootstrap would read from stored reference binary or stored region data.
// Here we just use the same binary as the reference.
function verifyChallengeResponse(referenceBinary, storedRegions, challenge, responses) {
  for (const response of responses) {
    const region = challenge.regions.find(r => r.region_index === response.region_index);
    if (!region) return false;

    const regionData = referenceBinary.subarray(region.offset, region.offset + region.length);
    const expectedHmac = createHmac('sha256', challenge.nonce).update(regionData).digest('hex');

    if (response.hmac !== expectedHmac) {
      return false;
    }
  }
  return true;
}

const verificationResult = verifyChallengeResponse(dummyBinary, regions, challenge, appResponses);
assert(verificationResult === true, 'Genuine binary passes challenge-response verification');

// ============================================================
// Test 7: Challenge-Response Flow (Tampered Binary)
// ============================================================

console.log('\n=== Test 7: Challenge-Response Flow (Tampered Binary) ===');

// Create a tampered binary (flip some bytes in the middle)
const tamperedBinary = Buffer.from(dummyBinary);
const tamperOffset = Math.floor(BINARY_SIZE / 2);
for (let i = 0; i < 1024; i++) {
  tamperedBinary[tamperOffset + i] = tamperedBinary[tamperOffset + i] ^ 0xFF;
}

// Generate a new challenge that targets the tampered region
const tamperNonce = randomBytes(32).toString('hex');
const tamperChallenge = {
  nonce: tamperNonce,
  regions: [{
    region_index: 0,
    offset: tamperOffset,
    length: 1024,
  }],
};

// Tampered binary responds
const tamperedResponses = computeChallengeResponse(tamperedBinary, tamperChallenge);
// Verify against the genuine binary
const tamperedVerification = verifyChallengeResponse(dummyBinary, regions, tamperChallenge, tamperedResponses);
assert(tamperedVerification === false, 'Tampered binary FAILS challenge-response verification');

// Genuine binary should still pass the same challenge
const genuineResponses = computeChallengeResponse(dummyBinary, tamperChallenge);
const genuineVerification = verifyChallengeResponse(dummyBinary, regions, tamperChallenge, genuineResponses);
assert(genuineVerification === true, 'Genuine binary still passes the same challenge');

// ============================================================
// Test 8: Script Execution (generate-build-token.mjs)
// ============================================================

console.log('\n=== Test 8: Script Execution (generate-build-token.mjs) ===');

const buildTokenScript = join(__dirname, 'generate-build-token.mjs');
try {
  const output = execFileSync('node', [
    buildTokenScript,
    '--version', '1.0.0-test',
    '--platform', 'linux',
    '--binary-path', tmpBinaryPath,
  ], {
    env: { ...process.env, ATTESTATION_SIGNING_KEY: seedBase64 },
    encoding: 'utf8',
    timeout: 30000,
  });

  const lines = output.trim().split('\n');
  const tokenLine = lines.find(l => l.startsWith('BUILD_TOKEN='));
  const hashLine = lines.find(l => l.startsWith('BUILD_HASH='));

  assert(tokenLine !== undefined, 'Script outputs BUILD_TOKEN');
  assert(hashLine !== undefined, 'Script outputs BUILD_HASH');

  const scriptToken = tokenLine.split('=')[1];
  assert(scriptToken.length > 0, 'BUILD_TOKEN is non-empty');

  const scriptHash = hashLine.split('=')[1];
  assertEqual(scriptHash, binaryHash, 'BUILD_HASH matches expected binary hash');

  // Verify the token from the script
  const decodedScriptToken = JSON.parse(Buffer.from(scriptToken, 'base64').toString('utf8'));
  const scriptPayloadBytes = Buffer.from(decodedScriptToken.payload, 'base64');
  const scriptSigBytes = Buffer.from(decodedScriptToken.signature, 'base64');

  // Import the public key for verification
  const verifyKey = await subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify']);
  const scriptTokenValid = await subtle.verify('Ed25519', verifyKey, scriptSigBytes, scriptPayloadBytes);
  assert(scriptTokenValid === true, 'Script-generated token has valid signature');
} catch (err) {
  console.error(`  FAIL: generate-build-token.mjs execution failed: ${err.message}`);
  if (err.stderr) console.error(`  stderr: ${err.stderr}`);
  failed++;
}

// ============================================================
// Test 9: Script Execution (upload-reference-binary.mjs --dry-run)
// ============================================================

console.log('\n=== Test 9: Script Execution (upload-reference-binary.mjs --dry-run) ===');

const uploadScript = join(__dirname, 'upload-reference-binary.mjs');
try {
  const output = execFileSync('node', [
    uploadScript,
    '--version', '1.0.0-test',
    '--platform', 'linux',
    '--binary-path', tmpBinaryPath,
    '--dry-run',
  ], {
    encoding: 'utf8',
    timeout: 30000,
  });

  const manifest = JSON.parse(output);
  assertEqual(manifest.version, '1.0.0-test', 'Manifest version matches');
  assertEqual(manifest.platform, 'linux', 'Manifest platform matches');
  assertEqual(manifest.binary_hash, binaryHash, 'Manifest binary_hash matches');
  assertEqual(manifest.binary_size, BINARY_SIZE, 'Manifest binary_size matches');
  assert(manifest.region_hashes.length > 0, `Manifest has ${manifest.region_hashes.length} region hashes`);
  assert(manifest.uploaded_at !== undefined, 'Manifest has uploaded_at timestamp');
} catch (err) {
  console.error(`  FAIL: upload-reference-binary.mjs --dry-run failed: ${err.message}`);
  if (err.stderr) console.error(`  stderr: ${err.stderr}`);
  failed++;
}

// ============================================================
// Test 10: Script Execution (generate-attestation-keys.mjs)
// ============================================================

console.log('\n=== Test 10: Script Execution (generate-attestation-keys.mjs) ===');

const keysScript = join(__dirname, 'generate-attestation-keys.mjs');
try {
  const output = execFileSync('node', [keysScript], {
    encoding: 'utf8',
    timeout: 30000,
  });

  assert(output.includes('Attestation Signing Keypair'), 'Key generation script produces header');
  assert(output.includes('ATTESTATION_SIGNING_KEY'), 'Key generation mentions ATTESTATION_SIGNING_KEY');
  assert(output.includes('Public key (base64)'), 'Key generation includes public key');

  // Extract the base64 keys from output
  const lines = output.split('\n');
  const seedLine = lines.find(l => l.includes('Then paste:'));
  assert(seedLine !== undefined, 'Output includes private key seed');

  if (seedLine) {
    const extractedSeed = seedLine.trim().split('Then paste: ')[1];
    const seedBytes = Buffer.from(extractedSeed, 'base64');
    assertEqual(seedBytes.length, 32, 'Extracted private key seed is 32 bytes');
  }
} catch (err) {
  console.error(`  FAIL: generate-attestation-keys.mjs execution failed: ${err.message}`);
  if (err.stderr) console.error(`  stderr: ${err.stderr}`);
  failed++;
}

// ============================================================
// Cleanup
// ============================================================

try {
  unlinkSync(tmpBinaryPath);
} catch {
  // Ignore cleanup errors
}

// ============================================================
// Summary
// ============================================================

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(50));

if (failed > 0) {
  console.error('\nSome tests FAILED.');
  process.exit(1);
} else {
  console.log('\nAll tests PASSED.');
  process.exit(0);
}
