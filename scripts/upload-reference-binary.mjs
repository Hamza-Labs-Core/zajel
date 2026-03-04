#!/usr/bin/env node

/**
 * Upload reference binary metadata (region hashes) to the bootstrap attestation registry.
 *
 * Usage:
 *   CI_UPLOAD_SECRET=<secret> \
 *   node scripts/upload-reference-binary.mjs \
 *     --version 1.2.0 \
 *     --platform android \
 *     --binary-path ./build/app/outputs/flutter-apk/app-release.apk \
 *     --bootstrap-url https://bootstrap.zajel.app
 *
 * Parameters:
 *   --version        App version string
 *   --platform       Target platform: android|ios|linux|windows|macos|web
 *   --binary-path    Path to the built binary file
 *   --bootstrap-url  Bootstrap server URL (e.g., https://bootstrap.zajel.app)
 *   --region-count   Number of regions to hash (default: 100)
 *   --dry-run        Compute and display region hashes without uploading
 *
 * Environment:
 *   CI_UPLOAD_SECRET   Bearer token for authenticating with bootstrap server
 *
 * What this does:
 *   - Reads the binary file
 *   - Divides it into ~100 evenly-spaced regions
 *   - Computes SHA-256 hash for each region
 *   - Uploads the region hash manifest to POST /attest/upload-reference
 *   - Bootstrap stores these for challenge-response verification
 *
 * The full binary is NOT uploaded — only region offsets, lengths, and hashes.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// --- Argument parsing ---

const VALID_PLATFORMS = ['android', 'ios', 'linux', 'windows', 'macos', 'web'];
const DEFAULT_REGION_COUNT = 100;

function usage() {
  console.error(`Usage: CI_UPLOAD_SECRET=<secret> node scripts/upload-reference-binary.mjs \\
  --version <version> --platform <platform> --binary-path <path> --bootstrap-url <url>

Options:
  --region-count <n>   Number of regions to hash (default: ${DEFAULT_REGION_COUNT})
  --dry-run            Compute hashes without uploading

Platforms: ${VALID_PLATFORMS.join(', ')}

Environment variables:
  CI_UPLOAD_SECRET  Bearer token for bootstrap authentication`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { regionCount: DEFAULT_REGION_COUNT, dryRun: false };
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
      case '--bootstrap-url':
        args.bootstrapUrl = argv[++i];
        break;
      case '--region-count':
        args.regionCount = parseInt(argv[++i], 10);
        break;
      case '--dry-run':
        args.dryRun = true;
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
if (!args.dryRun && !args.bootstrapUrl) {
  console.error('Error: --bootstrap-url is required (or use --dry-run)');
  usage();
}
if (!args.dryRun && !process.env.CI_UPLOAD_SECRET) {
  console.error('Error: CI_UPLOAD_SECRET environment variable is required (or use --dry-run)');
  usage();
}
if (args.regionCount < 1 || args.regionCount > 10000 || isNaN(args.regionCount)) {
  console.error('Error: --region-count must be between 1 and 10000');
  usage();
}

// --- Read binary ---

const binaryPath = resolve(args.binaryPath);
let binaryData;
try {
  binaryData = readFileSync(binaryPath);
} catch (err) {
  console.error(`Error: Cannot read binary at ${binaryPath}: ${err.message}`);
  process.exit(1);
}

const binarySize = binaryData.length;
const binaryHash = createHash('sha256').update(binaryData).digest('hex');

console.error(`Binary: ${binaryPath}`);
console.error(`Size:   ${binarySize} bytes (${(binarySize / 1024 / 1024).toFixed(2)} MB)`);
console.error(`Hash:   ${binaryHash}`);

// --- Generate region hashes ---

/**
 * Generate evenly-spaced region hashes covering the entire binary.
 *
 * Strategy:
 * 1. Divide the binary into `regionCount` equal-ish segments
 * 2. For each segment, compute a hash of that region
 * 3. Add a few random-offset samples for extra coverage
 *
 * The regions are deterministic given the same binary size and region count,
 * which is important: bootstrap needs to reproduce the same regions to
 * verify challenge responses.
 */
function generateRegionHashes(data, regionCount) {
  const regions = [];
  const totalSize = data.length;

  if (totalSize === 0) {
    console.error('Error: Binary file is empty');
    process.exit(1);
  }

  // Minimum region size: 512 bytes (unless binary is smaller)
  const MIN_REGION_SIZE = 512;
  // Maximum region size: 16KB
  const MAX_REGION_SIZE = 16384;

  // Calculate evenly-spaced regions
  const evenRegionCount = Math.min(regionCount, Math.ceil(totalSize / MIN_REGION_SIZE));
  const stride = Math.floor(totalSize / evenRegionCount);
  const regionSize = Math.min(MAX_REGION_SIZE, Math.max(MIN_REGION_SIZE, stride));

  for (let i = 0; i < evenRegionCount; i++) {
    const offset = i * stride;
    const length = Math.min(regionSize, totalSize - offset);
    if (length <= 0) break;

    const regionData = data.subarray(offset, offset + length);
    const hash = createHash('sha256').update(regionData).digest('hex');

    regions.push({ offset, length, hash });
  }

  // Add seeded pseudo-random samples to cover gaps and provide unpredictability.
  // Use a deterministic seed based on the binary hash so the same binary
  // always produces the same regions (required for verification).
  const extraSamples = Math.min(10, Math.floor(regionCount * 0.1));
  let prngState = 0;
  for (const byte of Buffer.from(binaryHash, 'hex').subarray(0, 8)) {
    prngState = (prngState * 256 + byte) >>> 0;
  }

  for (let i = 0; i < extraSamples; i++) {
    // Simple LCG PRNG (deterministic)
    prngState = (prngState * 1664525 + 1013904223) >>> 0;
    const offset = prngState % Math.max(1, totalSize - MIN_REGION_SIZE);
    const length = Math.min(MIN_REGION_SIZE + (prngState % (MAX_REGION_SIZE - MIN_REGION_SIZE)), totalSize - offset);

    const regionData = data.subarray(offset, offset + length);
    const hash = createHash('sha256').update(regionData).digest('hex');

    regions.push({ offset, length, hash });
  }

  return regions;
}

const regionHashes = generateRegionHashes(binaryData, args.regionCount);

console.error(`Regions: ${regionHashes.length} (${args.regionCount} requested)`);
console.error('');

// --- Build upload payload ---

const payload = {
  version: args.version,
  platform: args.platform,
  binary_hash: binaryHash,
  binary_size: binarySize,
  region_count: regionHashes.length,
  region_hashes: regionHashes,
  uploaded_at: new Date().toISOString(),
};

// --- Dry run: just output the manifest ---

if (args.dryRun) {
  console.error('=== Dry Run — Region Hash Manifest ===');
  console.error('');

  // Show first 10 regions as summary
  const preview = regionHashes.slice(0, 10);
  for (const r of preview) {
    console.error(`  offset=0x${r.offset.toString(16).padStart(8, '0')}  length=${String(r.length).padStart(5)}  hash=${r.hash.substring(0, 16)}...`);
  }
  if (regionHashes.length > 10) {
    console.error(`  ... and ${regionHashes.length - 10} more regions`);
  }

  console.error('');
  console.error('Full manifest written to stdout (pipe to file if needed):');

  // Write full payload to stdout for inspection
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

// --- Upload to bootstrap ---

const uploadUrl = `${args.bootstrapUrl.replace(/\/$/, '')}/attest/upload-reference`;

console.error(`Uploading to: ${uploadUrl}`);

try {
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.CI_UPLOAD_SECRET}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error(`Error: Upload failed with status ${response.status}`);
    console.error(`Response: ${responseText}`);
    process.exit(1);
  }

  console.error('');
  console.error('=== Upload Successful ===');
  console.error(`  Version:  ${args.version}`);
  console.error(`  Platform: ${args.platform}`);
  console.error(`  Hash:     ${binaryHash}`);
  console.error(`  Regions:  ${regionHashes.length}`);
  console.error(`  Status:   ${response.status}`);

  // Parse response if JSON
  try {
    const responseJson = JSON.parse(responseText);
    console.error(`  Response: ${JSON.stringify(responseJson)}`);
  } catch {
    if (responseText) {
      console.error(`  Response: ${responseText}`);
    }
  }

  // Output machine-readable on stdout
  console.log(`UPLOAD_STATUS=success`);
  console.log(`BINARY_HASH=${binaryHash}`);
  console.log(`REGION_COUNT=${regionHashes.length}`);
} catch (err) {
  console.error(`Error: Upload failed: ${err.message}`);
  process.exit(1);
}
