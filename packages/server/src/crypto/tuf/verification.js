/**
 * TUF Server-Side Metadata Verification
 *
 * Validates TUF metadata integrity before serving to clients.
 * Provides pre-serving checks for expiration, version consistency,
 * and signature verification.
 */

import { canonicalJSON, isExpired, verifySignature, generateKeyId } from './metadata.js';

/**
 * Verify a signed metadata envelope has a valid signature from the expected key.
 * @param {Object} signedMetadata - { signed, signatures } envelope
 * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key
 * @returns {Promise<boolean>}
 */
export async function verifyMetadataSignature(signedMetadata, publicKeyBase64) {
  if (!signedMetadata?.signed || !signedMetadata?.signatures?.length) {
    return false;
  }

  const tufKey = {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: publicKeyBase64,
  };
  const keyid = await generateKeyId(tufKey);

  return verifySignature(signedMetadata, publicKeyBase64, keyid);
}

/**
 * Validate a complete TUF metadata chain for consistency.
 * Checks:
 * - Timestamp references correct snapshot version and hash
 * - Snapshot references correct targets version and hash
 * - All metadata is not expired
 * - Version numbers are consistent
 *
 * @param {Object} params
 * @param {Object} params.timestamp - Signed timestamp metadata
 * @param {Object} params.snapshot - Signed snapshot metadata
 * @param {Object} params.targets - Signed targets metadata
 * @returns {Promise<{valid: boolean, errors: string[]}>}
 */
export async function validateMetadataChain({ timestamp, snapshot, targets }) {
  const errors = [];

  // Validate structure
  if (!timestamp?.signed || !snapshot?.signed || !targets?.signed) {
    return { valid: false, errors: ['Missing signed metadata in one or more roles'] };
  }

  // Check types
  if (timestamp.signed._type !== 'timestamp') {
    errors.push(`Expected timestamp type, got ${timestamp.signed._type}`);
  }
  if (snapshot.signed._type !== 'snapshot') {
    errors.push(`Expected snapshot type, got ${snapshot.signed._type}`);
  }
  if (targets.signed._type !== 'targets') {
    errors.push(`Expected targets type, got ${targets.signed._type}`);
  }

  // Check expiration
  if (isExpired(timestamp.signed.expires)) {
    errors.push(`Timestamp metadata expired: ${timestamp.signed.expires}`);
  }
  if (isExpired(snapshot.signed.expires)) {
    errors.push(`Snapshot metadata expired: ${snapshot.signed.expires}`);
  }
  if (isExpired(targets.signed.expires)) {
    errors.push(`Targets metadata expired: ${targets.signed.expires}`);
  }

  // Verify timestamp -> snapshot version reference
  const expectedSnapshotVersion = timestamp.signed.meta?.['snapshot.json']?.version;
  if (expectedSnapshotVersion !== snapshot.signed.version) {
    errors.push(
      `Timestamp references snapshot v${expectedSnapshotVersion}, but snapshot is v${snapshot.signed.version}`
    );
  }

  // Verify timestamp -> snapshot hash
  const snapshotCanonical = canonicalJSON(snapshot.signed);
  const snapshotHashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshotCanonical)
  );
  const snapshotHash = Array.from(
    new Uint8Array(snapshotHashBuffer),
    b => b.toString(16).padStart(2, '0')
  ).join('');

  const expectedSnapshotHash = timestamp.signed.meta?.['snapshot.json']?.hashes?.sha256;
  if (expectedSnapshotHash && snapshotHash !== expectedSnapshotHash) {
    errors.push('Snapshot hash mismatch: timestamp metadata references a different snapshot');
  }

  // Verify snapshot -> targets version reference
  const expectedTargetsVersion = snapshot.signed.meta?.['targets.json']?.version;
  if (expectedTargetsVersion !== targets.signed.version) {
    errors.push(
      `Snapshot references targets v${expectedTargetsVersion}, but targets is v${targets.signed.version}`
    );
  }

  // Verify snapshot -> targets hash
  const targetsCanonical = canonicalJSON(targets.signed);
  const targetsHashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(targetsCanonical)
  );
  const targetsHash = Array.from(
    new Uint8Array(targetsHashBuffer),
    b => b.toString(16).padStart(2, '0')
  ).join('');

  const expectedTargetsHash = snapshot.signed.meta?.['targets.json']?.hashes?.sha256;
  if (expectedTargetsHash && targetsHash !== expectedTargetsHash) {
    errors.push('Targets hash mismatch: snapshot metadata references a different targets');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a root metadata correctly defines all four required roles.
 * @param {Object} rootMetadata - Unsigned root metadata object
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRootMetadata(rootMetadata) {
  const errors = [];
  const requiredRoles = ['root', 'targets', 'snapshot', 'timestamp'];

  if (rootMetadata._type !== 'root') {
    errors.push(`Expected root type, got ${rootMetadata._type}`);
  }

  if (!rootMetadata.keys || typeof rootMetadata.keys !== 'object') {
    errors.push('Root metadata missing keys map');
  }

  if (!rootMetadata.roles || typeof rootMetadata.roles !== 'object') {
    errors.push('Root metadata missing roles map');
    return { valid: false, errors };
  }

  for (const role of requiredRoles) {
    if (!rootMetadata.roles[role]) {
      errors.push(`Root metadata missing role definition: ${role}`);
      continue;
    }

    const roleDef = rootMetadata.roles[role];
    if (!roleDef.threshold || roleDef.threshold < 1) {
      errors.push(`Role ${role} has invalid threshold: ${roleDef.threshold}`);
    }
    if (!roleDef.keyids || roleDef.keyids.length === 0) {
      errors.push(`Role ${role} has no key IDs defined`);
    }

    // Verify all referenced key IDs exist in the keys map
    for (const keyid of roleDef.keyids || []) {
      if (rootMetadata.keys && !rootMetadata.keys[keyid]) {
        errors.push(`Role ${role} references unknown keyid: ${keyid.slice(0, 16)}...`);
      }
    }
  }

  // Check version
  if (!Number.isInteger(rootMetadata.version) || rootMetadata.version < 1) {
    errors.push(`Invalid version: ${rootMetadata.version}`);
  }

  // Check expiration
  if (!rootMetadata.expires) {
    errors.push('Root metadata missing expires field');
  } else if (isExpired(rootMetadata.expires)) {
    errors.push(`Root metadata expired: ${rootMetadata.expires}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a version increment is valid (monotonically increasing).
 * @param {number} currentVersion - Current metadata version
 * @param {number} newVersion - Proposed new version
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateVersionIncrement(currentVersion, newVersion) {
  if (!Number.isInteger(newVersion) || newVersion < 1) {
    return { valid: false, error: `Invalid version number: ${newVersion}` };
  }

  if (currentVersion !== null && currentVersion !== undefined) {
    if (newVersion <= currentVersion) {
      return {
        valid: false,
        error: `Version rollback detected: current=${currentVersion}, new=${newVersion}`,
      };
    }
  }

  return { valid: true, error: null };
}
