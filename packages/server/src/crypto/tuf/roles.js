/**
 * TUF Role-Specific Signing Functions
 */

import { importSigningKey, signPayload } from '../signing.js';
import { generateKeyId, canonicalJSON } from './metadata.js';

/**
 * Sign a metadata object with one or more keys.
 * @param {Object} metadata - The metadata object to sign (unsigned)
 * @param {Array<{keyid: string, key: CryptoKey}>} signingKeys - Array of {keyid, key} pairs
 * @returns {Promise<Object>} SignedMetadata envelope with signatures
 */
export async function signMetadata(metadata, signingKeys) {
  const canonical = canonicalJSON(metadata);

  const signatures = [];
  for (const { keyid, key } of signingKeys) {
    const sig = await signPayload(key, canonical);
    signatures.push({ keyid, sig });
  }

  return {
    signed: metadata,
    signatures,
  };
}

/**
 * Import a signing key for a specific role.
 * @param {string} hexSeed - 64-character hex-encoded Ed25519 seed
 * @param {string} publicKeyBase64 - Base64-encoded public key (for keyid derivation)
 * @returns {Promise<{keyid: string, key: CryptoKey}>}
 */
export async function importRoleKey(hexSeed, publicKeyBase64) {
  const key = await importSigningKey(hexSeed);
  const tufKey = {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: publicKeyBase64,
  };
  const keyid = await generateKeyId(tufKey);
  return { keyid, key };
}

/**
 * Create a new Root metadata object.
 * @param {number} version
 * @param {number} expirationDays
 * @param {Object<string, string>} roleKeys - Map of role name -> publicKeyBase64
 * @returns {Promise<Object>} Unsigned Root metadata
 */
export async function createRootMetadata(version, expirationDays, roleKeys) {
  const keys = {};
  const roles = {};

  for (const [roleName, pubKeyBase64] of Object.entries(roleKeys)) {
    const tufKey = {
      keytype: 'ed25519',
      scheme: 'ed25519',
      keyval: pubKeyBase64,
    };
    const keyid = await generateKeyId(tufKey);
    keys[keyid] = tufKey;

    roles[roleName] = {
      threshold: 1, // Single-signature for now (Story 023 will add M-of-N)
      keyids: [keyid],
    };
  }

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  return {
    _type: 'root',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    keys,
    roles,
    consistent_snapshot: false,
  };
}

/**
 * Create a new Targets metadata object from server registry entries.
 * @param {number} version
 * @param {number} expirationDays
 * @param {Array<Object>} servers - Array of server entries from ServerRegistryDO
 * @returns {Promise<Object>} Unsigned Targets metadata
 */
export async function createTargetsMetadata(version, expirationDays, servers) {
  const targets = {};

  for (const server of servers) {
    const targetName = `servers/${server.serverId}.json`;
    const serverJson = JSON.stringify(server);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverJson));
    const hashHex = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');

    targets[targetName] = {
      length: serverJson.length,
      hashes: { sha256: hashHex },
      custom: {
        serverId: server.serverId,
        endpoint: server.endpoint,
        publicKey: server.publicKey,
        region: server.region,
        buildVerified: server.buildVerified || false,
        buildHash: server.buildHash || null,
        buildVersion: server.buildVersion || null,
        registeredAt: server.registeredAt,
        lastSeen: server.lastSeen,
      },
    };
  }

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  return {
    _type: 'targets',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    targets,
    delegations: null,
  };
}

/**
 * Create a new Snapshot metadata object.
 * @param {number} version
 * @param {number} expirationDays
 * @param {Object} targetsMetadata - The signed Targets metadata
 * @returns {Promise<Object>} Unsigned Snapshot metadata
 */
export async function createSnapshotMetadata(version, expirationDays, targetsMetadata) {
  const targetsHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJSON(targetsMetadata.signed))
  );
  const hashHex = Array.from(new Uint8Array(targetsHash), b => b.toString(16).padStart(2, '0')).join('');

  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + expirationDays);

  return {
    _type: 'snapshot',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    meta: {
      'targets.json': {
        version: targetsMetadata.signed.version,
        hashes: { sha256: hashHex },
      },
    },
  };
}

/**
 * Create a new Timestamp metadata object.
 * @param {number} version
 * @param {number} expirationHours
 * @param {Object} snapshotMetadata - The signed Snapshot metadata
 * @returns {Promise<Object>} Unsigned Timestamp metadata
 */
export async function createTimestampMetadata(version, expirationHours, snapshotMetadata) {
  const snapshotHash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJSON(snapshotMetadata.signed))
  );
  const hashHex = Array.from(new Uint8Array(snapshotHash), b => b.toString(16).padStart(2, '0')).join('');

  const expiry = new Date();
  expiry.setUTCHours(expiry.getUTCHours() + expirationHours);

  return {
    _type: 'timestamp',
    spec_version: '1.0.31',
    version,
    expires: expiry.toISOString(),
    meta: {
      'snapshot.json': {
        version: snapshotMetadata.signed.version,
        hashes: { sha256: hashHex },
      },
    },
  };
}
