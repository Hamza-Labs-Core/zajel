/**
 * Build Manifest Loader
 *
 * Loads the build-manifest.json generated at build time by the sign-build script.
 * The manifest contains a SHA-256 hash of the build artifacts and an Ed25519
 * signature proving the build came from a trusted operator.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface BuildManifest {
  version: string;
  buildHash: string;
  timestamp: number;
  signature: string;   // base64-encoded Ed25519 signature over buildHash
  publicKey: string;    // base64-encoded Ed25519 public key of the signer
  fileCount: number;
}

/**
 * Load the build manifest from dist/build-manifest.json.
 * Returns null if the manifest doesn't exist (unsigned build / dev mode).
 */
export function loadBuildManifest(): BuildManifest | null {
  // Resolve relative to this module's compiled location (dist/identity/)
  const thisDir = typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
  const manifestPath = join(thisDir, '..', 'build-manifest.json');

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    const data = JSON.parse(raw);

    // Validate required fields
    if (
      typeof data.version !== 'string' ||
      typeof data.buildHash !== 'string' ||
      typeof data.timestamp !== 'number' ||
      typeof data.signature !== 'string' ||
      typeof data.publicKey !== 'string'
    ) {
      console.warn('[BuildManifest] Invalid manifest format, ignoring');
      return null;
    }

    return data as BuildManifest;
  } catch (err) {
    console.warn('[BuildManifest] Failed to load manifest:', err);
    return null;
  }
}
