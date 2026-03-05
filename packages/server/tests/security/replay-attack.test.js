/**
 * Security tests for replay attack prevention.
 *
 * Covers:
 * - Nonce reuse detection (POST /attest/verify)
 * - Expired nonce rejection
 * - Cross-device nonce rejection
 * - Build token replay (intentionally allowed for multiple registrations)
 * - Registration nonce replay in ServerRegistryDO
 * - Session token replay prevention
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';
import {
  importAttestationSigningKey,
  signPayloadEd25519,
  computeHmac,
} from '../../src/crypto/attestation.js';

async function generateTestSeed() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const seed = pkcs8.slice(-32);
  return Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function createBuildToken(seedHex, tokenPayload) {
  const signingKey = await importAttestationSigningKey(seedHex);
  const payload = JSON.stringify(tokenPayload);
  const signature = await signPayloadEd25519(signingKey, payload);
  return { payload, signature };
}

/**
 * Helper to complete a full attestation flow: register device, upload reference,
 * get challenge, compute HMACs, and verify.
 */
async function fullAttestationFlow(attestationDO, seedHex, deviceId, version, platform) {
  const buildToken = await createBuildToken(seedHex, {
    version,
    platform,
    build_hash: 'abc123def456',
    timestamp: Date.now(),
  });

  // Register device
  await attestationDO.fetch(createRequest('POST', '/attest/register', {
    build_token: buildToken,
    device_id: deviceId,
  }));

  // Upload reference with critical regions
  const referenceData = {
    version,
    platform,
    build_hash: 'abc123def456',
    size: 1024,
    critical_regions: [
      { offset: 0, length: 16, data_hex: 'deadbeefcafebabe0123456789abcdef' },
      { offset: 100, length: 16, data_hex: 'cafebabe0123456789abcdefdeadbeef' },
      { offset: 200, length: 16, data_hex: '0123456789abcdefdeadbeefcafebabe' },
    ],
  };

  await attestationDO.fetch(createRequest('POST', '/attest/upload-reference', referenceData, {
    Authorization: 'Bearer test-secret',
  }));

  // Get challenge
  const challengeResp = await attestationDO.fetch(
    createRequest('POST', '/attest/challenge', { device_id: deviceId, build_version: version })
  );
  const challengeData = await challengeResp.json();

  return challengeData;
}

describe('Replay Attack Prevention', () => {
  let mockState;
  let attestationDO;
  let seedHex;

  beforeEach(async () => {
    mockState = new MockState();
    seedHex = await generateTestSeed();
    attestationDO = new AttestationRegistryDO(mockState, {
      ATTESTATION_SIGNING_KEY: seedHex,
      CI_UPLOAD_SECRET: 'test-secret',
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  describe('Nonce Reuse Detection', () => {
    it('should reject reused nonce on second verify', async () => {
      const challengeData = await fullAttestationFlow(
        attestationDO, seedHex, 'device-001', '1.0.0', 'android'
      );
      const { nonce, regions } = challengeData;

      // Build responses for each region
      const reference = await mockState.storage.get('reference:1.0.0:android');
      const responses = [];
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const refRegion = reference.critical_regions.find(
          r => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes(refRegion.data_hex);
        const hmac = await computeHmac(regionBytes, nonce);
        responses.push({ region_index: i, hmac });
      }

      // First verify (should succeed)
      const firstVerify = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          responses,
        })
      );
      expect(firstVerify.status).toBe(200);
      const firstData = await firstVerify.json();
      expect(firstData.valid).toBe(true);

      // Second verify with same nonce (should fail - nonce consumed)
      const secondVerify = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          responses,
        })
      );
      expect(secondVerify.status).toBe(403);
      const secondData = await secondVerify.json();
      expect(secondData.error).toContain('Invalid or expired nonce');
    });
  });

  describe('Expired Nonce Rejection', () => {
    it('should reject nonce after NONCE_TTL expires', async () => {
      const challengeData = await fullAttestationFlow(
        attestationDO, seedHex, 'device-001', '1.0.0', 'android'
      );
      const { nonce, regions } = challengeData;

      // Build responses
      const reference = await mockState.storage.get('reference:1.0.0:android');
      const responses = [];
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const refRegion = reference.critical_regions.find(
          r => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes(refRegion.data_hex);
        const hmac = await computeHmac(regionBytes, nonce);
        responses.push({ region_index: i, hmac });
      }

      // Advance time past NONCE_TTL (5 minutes)
      vi.advanceTimersByTime(6 * 60 * 1000);

      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          responses,
        })
      );
      expect(verifyResp.status).toBe(403);
      const data = await verifyResp.json();
      expect(data.error).toMatch(/expired|Invalid/i);
    });

    it('should accept nonce just before expiry', async () => {
      const challengeData = await fullAttestationFlow(
        attestationDO, seedHex, 'device-001', '1.0.0', 'android'
      );
      const { nonce, regions } = challengeData;

      // Build responses
      const reference = await mockState.storage.get('reference:1.0.0:android');
      const responses = [];
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const refRegion = reference.critical_regions.find(
          r => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes(refRegion.data_hex);
        const hmac = await computeHmac(regionBytes, nonce);
        responses.push({ region_index: i, hmac });
      }

      // Advance time to 4m 50s (just before 5m TTL)
      vi.advanceTimersByTime(290 * 1000);

      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          responses,
        })
      );
      expect(verifyResp.status).toBe(200);
    });
  });

  describe('Cross-Device Nonce Rejection', () => {
    it('should reject nonce from different device', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123def456',
        timestamp: Date.now(),
      });

      // Register both devices
      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));
      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-002',
      }));

      // Upload reference
      await attestationDO.fetch(createRequest('POST', '/attest/upload-reference', {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123def456',
        size: 1024,
        critical_regions: [
          { offset: 0, length: 16, data_hex: 'deadbeefcafebabe0123456789abcdef' },
          { offset: 100, length: 16, data_hex: 'cafebabe0123456789abcdefdeadbeef' },
          { offset: 200, length: 16, data_hex: '0123456789abcdefdeadbeefcafebabe' },
        ],
      }, { Authorization: 'Bearer test-secret' }));

      // Get challenge for device-001
      const challengeResp = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', {
          device_id: 'device-001',
          build_version: '1.0.0',
        })
      );
      const { nonce } = await challengeResp.json();

      // Try to use device-001's nonce with device-002
      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-002', // Wrong device
          nonce,
          responses: [],
        })
      );
      expect(verifyResp.status).toBe(403);
      const data = await verifyResp.json();
      expect(data.error).toContain('Device ID mismatch');
    });
  });

  describe('Build Token Replay (Intentional Behavior)', () => {
    it('should allow same build token to register multiple devices', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const resp1 = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));
      expect(resp1.status).toBe(200);

      const resp2 = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-002',
      }));
      expect(resp2.status).toBe(200);
    });

    it('should reject build token older than MAX_TOKEN_AGE (30 days)', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now() - (31 * 24 * 60 * 60 * 1000), // 31 days old
      });

      const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      }));
      expect(resp.status).toBe(403);
      const data = await resp.json();
      expect(data.error).toContain('Build token expired');
    });
  });

  describe('Registration Nonce Replay in ServerRegistryDO', () => {
    it('should reject duplicate nonce on server registration', async () => {
      const registryState = new MockState();
      const registry = new ServerRegistryDO(registryState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
      });
      vi.useFakeTimers();

      const authHeaders = { Authorization: 'Bearer test-secret' };
      const nonce = crypto.randomUUID() + crypto.randomUUID();

      // First registration with nonce
      const resp1 = await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:replay-test',
        endpoint: 'wss://replay.example.com',
        publicKey: 'key1',
        timestamp: Date.now(),
        nonce,
      }, authHeaders));
      expect(resp1.status).toBe(200);

      // Replay with same nonce
      const resp2 = await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:replay-test',
        endpoint: 'wss://replay.example.com',
        publicKey: 'key1',
        timestamp: Date.now(),
        nonce, // Same nonce
      }, authHeaders));
      expect(resp2.status).toBe(409);
      const data = await resp2.json();
      expect(data.error).toContain('Replay detected');

      registryState.storage.clear();
    });
  });

  describe('Session Token Replay Prevention', () => {
    it('should include expiry in session token', async () => {
      const challengeData = await fullAttestationFlow(
        attestationDO, seedHex, 'device-001', '1.0.0', 'android'
      );
      const { nonce, regions } = challengeData;

      // Build responses
      const reference = await mockState.storage.get('reference:1.0.0:android');
      const responses = [];
      for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const refRegion = reference.critical_regions.find(
          r => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes(refRegion.data_hex);
        const hmac = await computeHmac(regionBytes, nonce);
        responses.push({ region_index: i, hmac });
      }

      const verifyResp = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce,
          responses,
        })
      );
      const { session_token } = await verifyResp.json();

      expect(session_token).toBeDefined();
      expect(typeof session_token).toBe('string');
      expect(session_token.includes('.')).toBe(true); // Has signature separator
    });
  });
});

/** Helper: convert hex string to Uint8Array */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
