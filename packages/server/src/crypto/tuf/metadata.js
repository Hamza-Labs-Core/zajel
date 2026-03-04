/**
 * TUF Metadata Schema Definitions
 * Implements TUF Specification v1.0.31 metadata format
 */

/**
 * @typedef {Object} TufRole
 * @property {number} threshold - Number of signatures required (default: 1)
 * @property {string[]} keyids - List of authorized key IDs for this role
 */

/**
 * @typedef {Object} TufKey
 * @property {string} keytype - "ed25519"
 * @property {string} scheme - "ed25519"
 * @property {string} keyval - Base64-encoded public key (32 bytes)
 */

/**
 * @typedef {Object} RootMetadata
 * @property {string} _type - "root"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, TufKey>} keys - Map of keyid -> key object
 * @property {Object<string, TufRole>} roles - Map of role name -> role config
 * @property {boolean} consistent_snapshot - false (not using consistent snapshots)
 */

/**
 * @typedef {Object} TargetFile
 * @property {number} length - File size in bytes (for consistency checks)
 * @property {Object<string, string>} hashes - { "sha256": "<hex>" }
 * @property {Object} custom - Custom metadata (serverId, endpoint, publicKey, region, buildVerified, etc.)
 */

/**
 * @typedef {Object} TargetsMetadata
 * @property {string} _type - "targets"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, TargetFile>} targets - Map of target name -> target metadata
 * @property {Object} delegations - null (no delegations in initial implementation)
 */

/**
 * @typedef {Object} SnapshotMeta
 * @property {number} version - Version number of the referenced metadata file
 * @property {Object<string, string>} hashes - { "sha256": "<hex>" } (optional but recommended)
 */

/**
 * @typedef {Object} SnapshotMetadata
 * @property {string} _type - "snapshot"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, SnapshotMeta>} meta - Map of "targets.json" -> { version, hashes }
 */

/**
 * @typedef {Object} TimestampMeta
 * @property {number} version - Version number of snapshot.json
 * @property {Object<string, string>} hashes - { "sha256": "<hex>" }
 */

/**
 * @typedef {Object} TimestampMetadata
 * @property {string} _type - "timestamp"
 * @property {number} spec_version - "1.0.31"
 * @property {number} version - Monotonically increasing version number
 * @property {string} expires - ISO 8601 UTC timestamp
 * @property {Object<string, TimestampMeta>} meta - Map of "snapshot.json" -> { version, hashes }
 */

/**
 * @typedef {Object} SignedMetadata
 * @property {Object} signed - The metadata object (Root/Targets/Snapshot/Timestamp)
 * @property {Array<{keyid: string, sig: string}>} signatures - Array of signatures
 */

/**
 * Generate a keyid from a public key.
 * TUF spec: keyid = SHA256(canonical JSON of key object)
 * @param {TufKey} key
 * @returns {Promise<string>} Hex-encoded SHA256 hash
 */
export async function generateKeyId(key) {
  const canonical = canonicalJSON({
    keytype: key.keytype,
    scheme: key.scheme,
    keyval: key.keyval,
  });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a TUF key object from a base64-encoded Ed25519 public key.
 * @param {string} publicKeyBase64
 * @returns {TufKey}
 */
export function createTufKey(publicKeyBase64) {
  return {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: publicKeyBase64,
  };
}

/**
 * Create an ISO 8601 expiration timestamp.
 * @param {number} daysFromNow
 * @returns {string} ISO 8601 UTC string
 */
export function createExpiration(daysFromNow) {
  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + daysFromNow);
  return expiry.toISOString();
}

/**
 * Compute SHA256 hash of a canonical JSON string.
 * @param {Object} obj
 * @returns {Promise<string>} Hex-encoded hash
 */
export async function hashMetadata(obj) {
  const canonical = canonicalJSON(obj);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate that metadata has not expired.
 * @param {string} expiresISO - ISO 8601 timestamp
 * @returns {boolean}
 */
export function isExpired(expiresISO) {
  return new Date(expiresISO) < new Date();
}

/**
 * Canonical JSON serialization (keys sorted alphabetically, recursively).
 * Required by TUF spec for reproducible signatures.
 * @param {*} obj
 * @returns {string}
 */
export function canonicalJSON(obj) {
  if (obj === null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJSON).join(',') + ']';

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Verify an Ed25519 signature over canonical JSON metadata.
 * @param {Object} signedMetadata - The full signed metadata envelope { signed, signatures }
 * @param {string} publicKeyBase64 - Base64-encoded Ed25519 public key
 * @param {string} keyid - The expected keyid of the signing key
 * @returns {Promise<boolean>}
 */
export async function verifySignature(signedMetadata, publicKeyBase64, keyid) {
  const signature = signedMetadata.signatures.find(s => s.keyid === keyid);
  if (!signature) return false;

  const canonical = canonicalJSON(signedMetadata.signed);
  const data = new TextEncoder().encode(canonical);

  const keyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0));
  if (keyBytes.length !== 32) return false;

  // SPKI wrapper for Ed25519 public key
  const spkiPrefix = new Uint8Array([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x03, 0x21, 0x00,
  ]);
  const spki = new Uint8Array(spkiPrefix.length + keyBytes.length);
  spki.set(spkiPrefix);
  spki.set(keyBytes, spkiPrefix.length);

  const cryptoKey = await crypto.subtle.importKey('spki', spki, 'Ed25519', false, ['verify']);

  const sigBytes = Uint8Array.from(atob(signature.sig), c => c.charCodeAt(0));
  if (sigBytes.length !== 64) return false;

  return await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, data);
}
