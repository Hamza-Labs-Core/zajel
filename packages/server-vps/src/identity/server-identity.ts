/**
 * Server Identity Management
 *
 * Handles Ed25519 key generation, loading, saving, and cryptographic operations.
 * Each server has a unique identity derived from its Ed25519 keypair.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ServerIdentity } from '../types.js';

export type { ServerIdentity };

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

/**
 * Generate a random ephemeral ID for human-readable identification
 */
function generateEphemeralId(prefix: string): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = prefix + '-';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * Compute the 160-bit node ID from a public key for DHT positioning
 * Uses first 160 bits of SHA-256 hash of the public key
 */
export function computeNodeId(publicKey: Uint8Array): string {
  const hash = sha256(publicKey);
  // Take first 20 bytes (160 bits) for DHT positioning
  return bytesToHex(hash.slice(0, 20));
}

/**
 * Generate a new server identity with fresh Ed25519 keypair
 */
export async function generateIdentity(ephemeralIdPrefix = 'srv'): Promise<ServerIdentity> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const nodeId = computeNodeId(publicKey);
  const ephemeralId = generateEphemeralId(ephemeralIdPrefix);

  // Server ID format: "ed25519:<base64-encoded-public-key>"
  const serverId = `ed25519:${Buffer.from(publicKey).toString('base64')}`;

  return {
    serverId,
    nodeId,
    ephemeralId,
    publicKey,
    privateKey,
  };
}

/**
 * Sign data with the server's private key
 */
export async function sign(identity: ServerIdentity, data: Uint8Array): Promise<Uint8Array> {
  return ed.signAsync(data, identity.privateKey);
}

/**
 * Sign a string message (converts to bytes first)
 */
export async function signMessage(identity: ServerIdentity, message: string): Promise<string> {
  const data = utf8ToBytes(message);
  const signature = await sign(identity, data);
  return Buffer.from(signature).toString('base64');
}

/**
 * Verify a signature against a public key
 */
export async function verify(
  data: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, data, publicKey);
  } catch {
    // Intentionally returns false: Invalid signatures, malformed keys, or
    // verification errors should all result in verification failure, not exceptions.
    // This is standard cryptographic API design.
    return false;
  }
}

/**
 * Verify a message signature
 */
export async function verifyMessage(
  message: string,
  signature: string,
  publicKey: Uint8Array
): Promise<boolean> {
  const data = utf8ToBytes(message);
  const sigBytes = Buffer.from(signature, 'base64');
  return verify(data, sigBytes, publicKey);
}

/**
 * Extract public key bytes from a server ID string
 */
export function publicKeyFromServerId(serverId: string): Uint8Array {
  if (!serverId.startsWith('ed25519:')) {
    throw new Error('Invalid server ID format');
  }
  const base64 = serverId.slice(8);
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/**
 * Save identity to a file (JSON format)
 */
export function saveIdentity(identity: ServerIdentity, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const data = {
    serverId: identity.serverId,
    nodeId: identity.nodeId,
    ephemeralId: identity.ephemeralId,
    publicKey: Buffer.from(identity.publicKey).toString('base64'),
    privateKey: Buffer.from(identity.privateKey).toString('base64'),
  };

  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load identity from a file
 */
export function loadIdentity(path: string): ServerIdentity {
  const content = readFileSync(path, 'utf-8');
  const data = JSON.parse(content) as {
    serverId: string;
    nodeId: string;
    ephemeralId: string;
    publicKey: string;
    privateKey: string;
  };

  return {
    serverId: data.serverId,
    nodeId: data.nodeId,
    ephemeralId: data.ephemeralId,
    publicKey: new Uint8Array(Buffer.from(data.publicKey, 'base64')),
    privateKey: new Uint8Array(Buffer.from(data.privateKey, 'base64')),
  };
}

/**
 * Load or generate identity
 * If the key file exists, loads it; otherwise generates a new identity and saves it
 */
export async function loadOrGenerateIdentity(
  path: string,
  ephemeralIdPrefix = 'srv'
): Promise<ServerIdentity> {
  if (existsSync(path)) {
    return loadIdentity(path);
  }

  const identity = await generateIdentity(ephemeralIdPrefix);
  saveIdentity(identity, path);
  return identity;
}

/**
 * Encode bytes to base64 string
 */
export function base64Encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/**
 * Decode base64 string to bytes
 */
export function base64Decode(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/**
 * Create a signature payload for server-to-server authentication
 */
export function createAuthPayload(
  identity: ServerIdentity,
  targetServerId: string,
  timestamp: number
): string {
  return JSON.stringify({
    from: identity.serverId,
    to: targetServerId,
    timestamp,
  });
}

/**
 * Verify an auth payload signature
 */
export async function verifyAuthPayload(
  payload: string,
  signature: string,
  expectedFromServerId: string,
  ourServerId: string,
  maxAge: number = 30000
): Promise<boolean> {
  try {
    const data = JSON.parse(payload) as {
      from: string;
      to: string;
      timestamp: number;
    };

    // Check sender matches
    if (data.from !== expectedFromServerId) {
      return false;
    }

    // Check we are the intended recipient
    if (data.to !== ourServerId) {
      return false;
    }

    // Check timestamp is recent
    const now = Date.now();
    if (Math.abs(now - data.timestamp) > maxAge) {
      return false;
    }

    // Verify signature
    const publicKey = publicKeyFromServerId(expectedFromServerId);
    return verifyMessage(payload, signature, publicKey);
  } catch {
    // Intentionally returns false: Auth payload verification failure includes
    // JSON parse errors, invalid serverIds, malformed signatures, etc.
    // All should result in failed verification, not thrown exceptions.
    return false;
  }
}
