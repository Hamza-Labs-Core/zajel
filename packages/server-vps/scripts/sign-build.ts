/**
 * Build Signing Script
 *
 * Generates a cryptographic manifest of the built VPS server artifacts.
 * Signs the content hash with an Ed25519 key so the bootstrap registry
 * can verify that a server is running an authentic, untampered build.
 *
 * Usage:
 *   ZAJEL_BUILD_SIGNING_KEY=<hex-private-key> node --import tsx/esm scripts/sign-build.ts
 *
 * Or with a key file:
 *   ZAJEL_BUILD_SIGNING_KEY_FILE=./build-signing.key node --import tsx/esm scripts/sign-build.ts
 *
 * Outputs: dist/build-manifest.json
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// Configure ed25519
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const DIST_DIR = join(import.meta.dirname, '..', 'dist');
const MANIFEST_PATH = join(DIST_DIR, 'build-manifest.json');
const PACKAGE_JSON = join(import.meta.dirname, '..', 'package.json');

/**
 * Recursively collect all files in a directory, sorted for deterministic hashing.
 */
function collectFiles(dir: string, base: string = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, base));
    } else if (stat.isFile() && entry !== 'build-manifest.json') {
      files.push(relative(base, fullPath));
    }
  }
  return files;
}

/**
 * Compute a deterministic SHA-256 hash of all build artifacts.
 * Hashes file paths + contents in sorted order for reproducibility.
 */
function computeBuildHash(distDir: string): { hash: string; files: string[] } {
  const files = collectFiles(distDir);
  const hasher = createHash('sha256');

  for (const file of files) {
    // Include the file path in the hash so renaming files changes the hash
    hasher.update(`file:${file}\n`);
    const content = readFileSync(join(distDir, file));
    hasher.update(content);
  }

  return {
    hash: hasher.digest('hex'),
    files,
  };
}

async function main() {
  // Validate dist/ exists
  if (!existsSync(DIST_DIR)) {
    console.error('[sign-build] Error: dist/ directory not found. Run "npm run build" first.');
    process.exit(1);
  }

  // Load signing key
  let signingKeyHex = process.env['ZAJEL_BUILD_SIGNING_KEY'];

  if (!signingKeyHex && process.env['ZAJEL_BUILD_SIGNING_KEY_FILE']) {
    const keyPath = process.env['ZAJEL_BUILD_SIGNING_KEY_FILE'];
    if (!existsSync(keyPath)) {
      console.error(`[sign-build] Error: Key file not found: ${keyPath}`);
      process.exit(1);
    }
    signingKeyHex = readFileSync(keyPath, 'utf-8').trim();
  }

  if (!signingKeyHex) {
    console.error('[sign-build] Error: No signing key provided.');
    console.error('  Set ZAJEL_BUILD_SIGNING_KEY=<64-char-hex> or');
    console.error('  Set ZAJEL_BUILD_SIGNING_KEY_FILE=<path-to-key-file>');
    process.exit(1);
  }

  // Validate key format
  if (!/^[0-9a-fA-F]{64}$/.test(signingKeyHex)) {
    console.error('[sign-build] Error: Signing key must be a 64-character hex string (32 bytes).');
    process.exit(1);
  }

  // Read version from package.json
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
  const version = pkg.version;

  // Compute build hash
  console.log('[sign-build] Computing build hash...');
  const { hash: buildHash, files } = computeBuildHash(DIST_DIR);
  console.log(`[sign-build] Build hash: ${buildHash}`);
  console.log(`[sign-build] Files hashed: ${files.length}`);

  // Sign the build hash
  console.log('[sign-build] Signing...');
  const privateKey = hexToBytes(signingKeyHex);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const message = new TextEncoder().encode(buildHash);
  const signature = await ed.signAsync(message, privateKey);

  // Write manifest
  const manifest = {
    version,
    buildHash,
    timestamp: Date.now(),
    signature: Buffer.from(signature).toString('base64'),
    publicKey: Buffer.from(publicKey).toString('base64'),
    fileCount: files.length,
  };

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[sign-build] Manifest written to ${MANIFEST_PATH}`);
  console.log(`[sign-build] Public key: ${manifest.publicKey}`);

  // Verify round-trip
  const verified = await ed.verifyAsync(signature, message, publicKey);
  if (!verified) {
    console.error('[sign-build] FATAL: Round-trip verification failed!');
    process.exit(1);
  }
  console.log('[sign-build] Signature verified successfully.');
}

main().catch((err) => {
  console.error('[sign-build] Fatal error:', err);
  process.exit(1);
});
