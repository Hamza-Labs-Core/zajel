/**
 * Attestation Service E2E Tests
 *
 * Tests for the attestation endpoints:
 * - POST /attest/register - Device registration with build token
 * - POST /attest/upload-reference - CI uploads reference binary metadata
 * - POST /attest/challenge - Challenge generation
 * - POST /attest/verify - Challenge-response verification
 * - GET /attest/versions - Version policy retrieval
 * - POST /attest/versions - Version policy update
 *
 * Also covers:
 * - Invalid tokens, expired sessions, wrong HMACs, replay attacks
 * - Version policy enforcement (minimum version, blocked versions)
 * - Full attestation flow (register -> challenge -> verify -> session token)
 * - CORS headers on all endpoints
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import {
  importAttestationSigningKey,
  exportPublicKeyBase64,
  signPayloadEd25519,
  computeHmac,
  verifySessionToken,
  importVerifyKey,
} from '../../src/crypto/attestation.js';
import { hexToBytes } from '../../src/crypto/signing.js';
import worker from '../../src/index.js';

// --- Test helpers ---

class MockStorage {
  constructor() {
    this.data = new Map();
    this._alarm = null;
  }
  async get(key) {
    return this.data.get(key);
  }
  async put(key, value) {
    this.data.set(key, value);
  }
  async delete(key) {
    if (Array.isArray(key)) {
      for (const k of key) this.data.delete(k);
    } else {
      this.data.delete(key);
    }
  }
  async list({ prefix, limit }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        results.set(key, value);
        if (limit && results.size >= limit) break;
      }
    }
    return results;
  }
  async getAlarm() {
    return this._alarm;
  }
  async setAlarm(time) {
    this._alarm = time;
  }
  clear() {
    this.data.clear();
    this._alarm = null;
  }
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
}

class MockDurableObjectStub {
  constructor(doInstance) {
    this.doInstance = doInstance;
  }
  async fetch(request) {
    return this.doInstance.fetch(request);
  }
}

function createRequest(method, path, body = null, headers = {}) {
  const url = `https://test.workers.dev${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(url, options);
}

/**
 * Generate a test Ed25519 keypair and return the hex seed.
 */
async function generateTestSeed() {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  );
  const seed = pkcs8.slice(-32);
  return Array.from(seed, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a signed build token.
 */
async function createBuildToken(seedHex, tokenPayload) {
  const signingKey = await importAttestationSigningKey(seedHex);
  const payload = JSON.stringify(tokenPayload);
  const signature = await signPayloadEd25519(signingKey, payload);
  return { payload, signature };
}

/**
 * Create test critical regions with data_hex for HMAC verification.
 */
function createTestCriticalRegions() {
  return [
    { offset: 0x1000, length: 256, data_hex: 'aa'.repeat(256) },
    { offset: 0x2000, length: 512, data_hex: 'bb'.repeat(512) },
    { offset: 0x3000, length: 128, data_hex: 'cc'.repeat(128) },
    { offset: 0x4000, length: 1024, data_hex: 'dd'.repeat(1024) },
    { offset: 0x5000, length: 64, data_hex: 'ee'.repeat(64) },
  ];
}

// --- Test suites ---

describe('Attestation Service E2E Tests', () => {
  let mockState;
  let attestationDO;
  let seedHex;
  const CI_SECRET = 'test-ci-secret-12345';

  beforeEach(async () => {
    mockState = new MockState();
    seedHex = await generateTestSeed();
    attestationDO = new AttestationRegistryDO(mockState, {
      ATTESTATION_SIGNING_KEY: seedHex,
      CI_UPLOAD_SECRET: CI_SECRET,
    });
  });

  afterEach(() => {
    mockState.storage.clear();
  });

  // -----------------------------------------------------------------------
  // POST /attest/register
  // -----------------------------------------------------------------------

  describe('POST /attest/register', () => {
    it('should register a device with a valid build token', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('registered');
      expect(data.device.device_id).toBe('device-001');
      expect(data.device.build_version).toBe('1.0.0');
      expect(data.device.platform).toBe('android');
      expect(data.version_status).toBe('current');
    });

    it('should reject missing build_token', async () => {
      const request = createRequest('POST', '/attest/register', {
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject missing device_id', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject build_token without payload or signature', async () => {
      const request = createRequest('POST', '/attest/register', {
        build_token: { payload: 'test' },
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid build_token format');
    });

    it('should reject invalid build token signature', async () => {
      const otherSeedHex = await generateTestSeed();
      const buildToken = await createBuildToken(otherSeedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('Invalid build token signature');
    });

    it('should reject build token with missing payload fields', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        // Missing platform, build_hash, timestamp
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('missing required fields');
    });

    it('should reject expired build token (older than 1 year)', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now() - 366 * 24 * 60 * 60 * 1000, // Over 1 year ago
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('expired');
    });

    it('should enforce version policy on registration - blocked version', async () => {
      // Set version policy that blocks 1.0.0
      await mockState.storage.put('version_policy', {
        minimum_version: '1.0.0',
        recommended_version: '1.1.0',
        blocked_versions: ['1.0.0'],
        sunset_dates: {},
      });

      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('blocked');
    });

    it('should enforce version policy on registration - below minimum', async () => {
      await mockState.storage.put('version_policy', {
        minimum_version: '2.0.0',
        recommended_version: '2.0.0',
        blocked_versions: [],
        sunset_dates: {},
      });

      const buildToken = await createBuildToken(seedHex, {
        version: '1.5.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('below minimum');
    });

    it('should indicate update_recommended when below recommended version', async () => {
      await mockState.storage.put('version_policy', {
        minimum_version: '1.0.0',
        recommended_version: '2.0.0',
        blocked_versions: [],
        sunset_dates: {},
      });

      const buildToken = await createBuildToken(seedHex, {
        version: '1.5.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('registered');
      expect(data.version_status).toBe('update_recommended');
      expect(data.recommended_version).toBe('2.0.0');
    });

    it('should return CORS headers', async () => {
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const request = createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);

      // CORS origin is only set when a matching Origin header is present
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should handle CORS preflight', async () => {
      const request = createRequest('OPTIONS', '/attest/register');
      const response = await attestationDO.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    });

    it('should return 503 when ATTESTATION_SIGNING_KEY is not configured', async () => {
      const doWithoutKey = new AttestationRegistryDO(mockState, {});

      const request = createRequest('POST', '/attest/register', {
        build_token: { payload: '{}', signature: 'abc' },
        device_id: 'device-001',
      });

      const response = await doWithoutKey.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toContain('not configured');
    });
  });

  // -----------------------------------------------------------------------
  // POST /attest/upload-reference
  // -----------------------------------------------------------------------

  describe('POST /attest/upload-reference', () => {
    it('should upload reference binary metadata with valid CI secret', async () => {
      const request = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '1.0.0',
          platform: 'android',
          build_hash: 'sha256:abc123def456',
          size: 25000000,
          critical_regions: createTestCriticalRegions(),
        },
        { Authorization: `Bearer ${CI_SECRET}` }
      );

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.reference.version).toBe('1.0.0');
      expect(data.reference.platform).toBe('android');
      expect(data.reference.critical_regions).toHaveLength(5);
    });

    it('should reject without Authorization header', async () => {
      const request = createRequest('POST', '/attest/upload-reference', {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        critical_regions: createTestCriticalRegions(),
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should reject with wrong CI secret', async () => {
      const request = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '1.0.0',
          platform: 'android',
          build_hash: 'abc123',
          critical_regions: createTestCriticalRegions(),
        },
        { Authorization: 'Bearer wrong-secret' }
      );

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should reject missing required fields', async () => {
      const request = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '1.0.0',
          // Missing platform and build_hash
          critical_regions: createTestCriticalRegions(),
        },
        { Authorization: `Bearer ${CI_SECRET}` }
      );

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject empty critical_regions', async () => {
      const request = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '1.0.0',
          platform: 'android',
          build_hash: 'abc123',
          critical_regions: [],
        },
        { Authorization: `Bearer ${CI_SECRET}` }
      );

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('critical_regions');
    });

    it('should reject critical_regions without offset/length', async () => {
      const request = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '1.0.0',
          platform: 'android',
          build_hash: 'abc123',
          critical_regions: [{ name: 'code' }],
        },
        { Authorization: `Bearer ${CI_SECRET}` }
      );

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('offset and length');
    });

    it('should return 503 when CI_UPLOAD_SECRET not configured', async () => {
      const doWithoutSecret = new AttestationRegistryDO(mockState, {
        ATTESTATION_SIGNING_KEY: seedHex,
      });

      const request = createRequest(
        'POST',
        '/attest/upload-reference',
        {
          version: '1.0.0',
          platform: 'android',
          build_hash: 'abc123',
          critical_regions: createTestCriticalRegions(),
        },
        { Authorization: `Bearer ${CI_SECRET}` }
      );

      const response = await doWithoutSecret.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(503);
      expect(data.error).toContain('not configured');
    });

    it('should overwrite existing reference for same version/platform', async () => {
      const regions1 = createTestCriticalRegions();
      const regions2 = [{ offset: 0x9000, length: 100, data_hex: 'ff'.repeat(100) }];

      // Upload first reference
      await attestationDO.fetch(
        createRequest(
          'POST',
          '/attest/upload-reference',
          {
            version: '1.0.0',
            platform: 'android',
            build_hash: 'hash-v1',
            critical_regions: regions1,
          },
          { Authorization: `Bearer ${CI_SECRET}` }
        )
      );

      // Upload second reference (same version/platform)
      await attestationDO.fetch(
        createRequest(
          'POST',
          '/attest/upload-reference',
          {
            version: '1.0.0',
            platform: 'android',
            build_hash: 'hash-v2',
            critical_regions: regions2,
          },
          { Authorization: `Bearer ${CI_SECRET}` }
        )
      );

      // Verify it was overwritten
      const stored = await mockState.storage.get('reference:1.0.0:android');
      expect(stored.build_hash).toBe('hash-v2');
      expect(stored.critical_regions).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // POST /attest/challenge
  // -----------------------------------------------------------------------

  describe('POST /attest/challenge', () => {
    async function setupDeviceAndReference() {
      // Register a device
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(
        createRequest('POST', '/attest/register', {
          build_token: buildToken,
          device_id: 'device-001',
        })
      );

      // Upload reference binary
      await attestationDO.fetch(
        createRequest(
          'POST',
          '/attest/upload-reference',
          {
            version: '1.0.0',
            platform: 'android',
            build_hash: 'abc123',
            size: 1000000,
            critical_regions: createTestCriticalRegions(),
          },
          { Authorization: `Bearer ${CI_SECRET}` }
        )
      );
    }

    it('should return a challenge with nonce and regions', async () => {
      await setupDeviceAndReference();

      const request = createRequest('POST', '/attest/challenge', {
        device_id: 'device-001',
        build_version: '1.0.0',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.nonce).toBeDefined();
      expect(data.nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(data.regions).toBeDefined();
      expect(data.regions.length).toBeGreaterThanOrEqual(3);
      expect(data.regions.length).toBeLessThanOrEqual(5);

      // Each region should have index, offset, and length
      for (const region of data.regions) {
        expect(typeof region.index).toBe('number');
        expect(typeof region.offset).toBe('number');
        expect(typeof region.length).toBe('number');
      }
    });

    it('should reject unregistered device', async () => {
      const request = createRequest('POST', '/attest/challenge', {
        device_id: 'unknown-device',
        build_version: '1.0.0',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toContain('not registered');
    });

    it('should reject missing fields', async () => {
      const request = createRequest('POST', '/attest/challenge', {
        device_id: 'device-001',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject when no reference binary exists', async () => {
      // Register device but don't upload reference
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(
        createRequest('POST', '/attest/register', {
          build_token: buildToken,
          device_id: 'device-001',
        })
      );

      const request = createRequest('POST', '/attest/challenge', {
        device_id: 'device-001',
        build_version: '1.0.0',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toContain('No reference binary');
    });

    it('should generate unique nonces for each challenge', async () => {
      await setupDeviceAndReference();

      const nonces = new Set();
      // Rate limit is 5 active nonces per device
      for (let i = 0; i < 5; i++) {
        const response = await attestationDO.fetch(
          createRequest('POST', '/attest/challenge', {
            device_id: 'device-001',
            build_version: '1.0.0',
          })
        );
        const data = await response.json();
        expect(response.status).toBe(200);
        nonces.add(data.nonce);
      }

      expect(nonces.size).toBe(5);
    });

    it('should rate limit nonce creation per device', async () => {
      await setupDeviceAndReference();

      // Create 5 challenges (the max)
      for (let i = 0; i < 5; i++) {
        const response = await attestationDO.fetch(
          createRequest('POST', '/attest/challenge', {
            device_id: 'device-001',
            build_version: '1.0.0',
          })
        );
        expect(response.status).toBe(200);
      }

      // 6th should be rate limited
      const response = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', {
          device_id: 'device-001',
          build_version: '1.0.0',
        })
      );
      expect(response.status).toBe(429);
      const data = await response.json();
      expect(data.error).toContain('Too many pending challenges');
    });
  });

  // -----------------------------------------------------------------------
  // POST /attest/verify
  // -----------------------------------------------------------------------

  describe('POST /attest/verify', () => {
    async function setupFullFlow() {
      // Register device
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(
        createRequest('POST', '/attest/register', {
          build_token: buildToken,
          device_id: 'device-001',
        })
      );

      // Upload reference
      await attestationDO.fetch(
        createRequest(
          'POST',
          '/attest/upload-reference',
          {
            version: '1.0.0',
            platform: 'android',
            build_hash: 'abc123',
            size: 1000000,
            critical_regions: createTestCriticalRegions(),
          },
          { Authorization: `Bearer ${CI_SECRET}` }
        )
      );

      // Get challenge
      const challengeResponse = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', {
          device_id: 'device-001',
          build_version: '1.0.0',
        })
      );

      return challengeResponse.json();
    }

    async function computeCorrectResponses(challenge, criticalRegions) {
      const responses = [];
      for (const region of challenge.regions) {
        // Find the matching critical region
        const refRegion = criticalRegions.find(
          (r) => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes2(refRegion.data_hex);
        const hmac = await computeHmac(regionBytes, challenge.nonce);
        responses.push({ region_index: region.index, hmac });
      }
      return responses;
    }

    it('should verify correct HMACs and issue session token', async () => {
      const challenge = await setupFullFlow();
      const regions = createTestCriticalRegions();
      const responses = await computeCorrectResponses(challenge, regions);

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-001',
        nonce: challenge.nonce,
        responses,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.session_token).toBeDefined();
      expect(data.session_token).toContain('.'); // payload.signature format
    });

    it('should reject wrong HMAC (modified binary)', async () => {
      const challenge = await setupFullFlow();

      // Send wrong HMACs
      const wrongResponses = challenge.regions.map((r) => ({
        region_index: r.index,
        hmac: 'ff'.repeat(32), // Wrong HMAC
      }));

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-001',
        nonce: challenge.nonce,
        responses: wrongResponses,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toContain('HMAC mismatch');
    });

    it('should reject replay attack (reused nonce)', async () => {
      const challenge = await setupFullFlow();
      const regions = createTestCriticalRegions();
      const responses = await computeCorrectResponses(challenge, regions);

      // First verification should succeed
      await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce: challenge.nonce,
          responses,
        })
      );

      // Second verification with same nonce should fail (replay)
      const response = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce: challenge.nonce,
          responses,
        })
      );
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('Invalid or expired nonce');
    });

    it('should reject expired challenge (nonce TTL)', async () => {
      const challenge = await setupFullFlow();
      const regions = createTestCriticalRegions();
      const responses = await computeCorrectResponses(challenge, regions);

      // Manually expire the nonce in storage
      const nonceEntry = await mockState.storage.get(`nonce:${challenge.nonce}`);
      nonceEntry.created_at = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      await mockState.storage.put(`nonce:${challenge.nonce}`, nonceEntry);

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-001',
        nonce: challenge.nonce,
        responses,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('expired');
    });

    it('should reject device_id mismatch', async () => {
      const challenge = await setupFullFlow();
      const regions = createTestCriticalRegions();
      const responses = await computeCorrectResponses(challenge, regions);

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'different-device',
        nonce: challenge.nonce,
        responses,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toContain('mismatch');
    });

    it('should reject wrong number of responses', async () => {
      const challenge = await setupFullFlow();

      // Send only one response when multiple are expected
      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-001',
        nonce: challenge.nonce,
        responses: [{ region_index: 0, hmac: 'aa'.repeat(32) }],
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
      expect(data.error).toContain('Wrong number');
    });

    it('should reject missing required fields', async () => {
      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-001',
        // Missing nonce and responses
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Missing required fields');
    });

    it('should reject invalid region_index', async () => {
      const challenge = await setupFullFlow();

      // Create responses with correct count but invalid index
      const responses = challenge.regions.map(() => ({
        region_index: 999,
        hmac: 'aa'.repeat(32),
      }));

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-001',
        nonce: challenge.nonce,
        responses,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(false);
    });

    it('should issue a valid session token that can be verified', async () => {
      const challenge = await setupFullFlow();
      const regions = createTestCriticalRegions();
      const responses = await computeCorrectResponses(challenge, regions);

      const verifyResponse = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'device-001',
          nonce: challenge.nonce,
          responses,
        })
      );
      const verifyData = await verifyResponse.json();

      // Verify the session token cryptographically
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);

      const tokenData = await verifySessionToken(verifyKey, verifyData.session_token);
      expect(tokenData).not.toBeNull();
      expect(tokenData.device_id).toBe('device-001');
      expect(tokenData.build_version).toBe('1.0.0');
      expect(tokenData.platform).toBe('android');
      expect(tokenData.expires_at).toBeGreaterThan(Date.now());
      // TTL should be ~1 hour
      expect(tokenData.expires_at - tokenData.issued_at).toBe(3600000);
    });
  });

  // -----------------------------------------------------------------------
  // GET /attest/versions
  // -----------------------------------------------------------------------

  describe('GET /attest/versions', () => {
    it('should return default version policy', async () => {
      const request = createRequest('GET', '/attest/versions');
      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.minimum_version).toBe('1.0.0');
      expect(data.recommended_version).toBe('1.0.0');
      expect(data.blocked_versions).toEqual([]);
      expect(data.sunset_dates).toEqual({});
    });

    it('should return stored version policy', async () => {
      const policy = {
        minimum_version: '2.0.0',
        recommended_version: '2.1.0',
        blocked_versions: ['1.0.0', '1.1.0'],
        sunset_dates: { '2.0.0': '2026-12-01' },
      };

      await mockState.storage.put('version_policy', policy);

      const request = createRequest('GET', '/attest/versions');
      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toEqual(policy);
    });

    it('should return CORS headers', async () => {
      const request = createRequest('GET', '/attest/versions');
      const response = await attestationDO.fetch(request);

      // CORS origin is only set when a matching Origin header is present
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    });
  });

  // -----------------------------------------------------------------------
  // POST /attest/versions
  // -----------------------------------------------------------------------

  describe('POST /attest/versions', () => {
    it('should update version policy with valid admin secret', async () => {
      const policy = {
        minimum_version: '2.0.0',
        recommended_version: '2.1.0',
        blocked_versions: ['1.0.0'],
        sunset_dates: { '2.0.0': '2026-12-01' },
      };

      const request = createRequest('POST', '/attest/versions', policy, {
        Authorization: `Bearer ${CI_SECRET}`,
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.policy.minimum_version).toBe('2.0.0');
      expect(data.policy.blocked_versions).toEqual(['1.0.0']);
    });

    it('should reject without authorization', async () => {
      const request = createRequest('POST', '/attest/versions', {
        minimum_version: '2.0.0',
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should use defaults for missing fields', async () => {
      const request = createRequest(
        'POST',
        '/attest/versions',
        { minimum_version: '2.0.0' },
        { Authorization: `Bearer ${CI_SECRET}` }
      );

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(data.policy.minimum_version).toBe('2.0.0');
      expect(data.policy.recommended_version).toBe('1.0.0'); // Default
      expect(data.policy.blocked_versions).toEqual([]);
      expect(data.policy.sunset_dates).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Worker routing integration
  // -----------------------------------------------------------------------

  describe('Worker routing for /attest/*', () => {
    it('should route /attest/* to the AttestationRegistry DO', async () => {
      const serverRegistryState = new MockState();
      const { ServerRegistryDO } = await import(
        '../../src/durable-objects/server-registry-do.js'
      );
      const serverRegistry = new ServerRegistryDO(serverRegistryState, {});

      const env = {
        SERVER_REGISTRY: {
          idFromName: () => 'mock-id',
          get: () => new MockDurableObjectStub(serverRegistry),
        },
        ATTESTATION_REGISTRY: {
          idFromName: () => 'mock-attest-id',
          get: () => new MockDurableObjectStub(attestationDO),
        },
      };

      // Test that /attest/versions routes correctly
      const request = new Request('https://test.workers.dev/attest/versions');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.minimum_version).toBeDefined();
    });

    it('should include attestation endpoints in API info', async () => {
      const env = {
        SERVER_REGISTRY: {
          idFromName: () => 'mock-id',
          get: () => new MockDurableObjectStub(attestationDO),
        },
        ATTESTATION_REGISTRY: {
          idFromName: () => 'mock-attest-id',
          get: () => new MockDurableObjectStub(attestationDO),
        },
      };

      const request = new Request('https://test.workers.dev/');
      const response = await worker.fetch(request, env);
      const data = await response.json();

      expect(data.version).toBe('4.0.0');
      expect(data.endpoints.attestRegister).toBe('POST /attest/register');
      expect(data.endpoints.attestChallenge).toBe('POST /attest/challenge');
      expect(data.endpoints.attestVerify).toBe('POST /attest/verify');
      expect(data.endpoints.attestVersions).toBe('GET /attest/versions');
    });

    it('should handle CORS preflight for /attest/* paths', async () => {
      const env = {
        SERVER_REGISTRY: {
          idFromName: () => 'mock-id',
          get: () => new MockDurableObjectStub(attestationDO),
        },
        ATTESTATION_REGISTRY: {
          idFromName: () => 'mock-attest-id',
          get: () => new MockDurableObjectStub(attestationDO),
        },
      };

      const request = new Request('https://test.workers.dev/attest/register', {
        method: 'OPTIONS',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });
  });

  // -----------------------------------------------------------------------
  // Full attestation flow
  // -----------------------------------------------------------------------

  describe('Full attestation flow', () => {
    it('should complete register -> challenge -> verify with valid session token', async () => {
      // Step 1: Upload reference binary (CI)
      const uploadResponse = await attestationDO.fetch(
        createRequest(
          'POST',
          '/attest/upload-reference',
          {
            version: '1.0.0',
            platform: 'linux',
            build_hash: 'sha256:full-flow-hash',
            size: 5000000,
            critical_regions: createTestCriticalRegions(),
          },
          { Authorization: `Bearer ${CI_SECRET}` }
        )
      );
      expect((await uploadResponse.json()).success).toBe(true);

      // Step 2: Register device
      const buildToken = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'linux',
        build_hash: 'sha256:full-flow-hash',
        timestamp: Date.now(),
      });

      const registerResponse = await attestationDO.fetch(
        createRequest('POST', '/attest/register', {
          build_token: buildToken,
          device_id: 'linux-device-42',
        })
      );
      const registerData = await registerResponse.json();
      expect(registerData.status).toBe('registered');

      // Step 3: Request challenge
      const challengeResponse = await attestationDO.fetch(
        createRequest('POST', '/attest/challenge', {
          device_id: 'linux-device-42',
          build_version: '1.0.0',
        })
      );
      const challenge = await challengeResponse.json();
      expect(challenge.nonce).toBeDefined();
      expect(challenge.regions.length).toBeGreaterThanOrEqual(3);

      // Step 4: Compute correct HMACs (simulating the genuine app)
      const criticalRegions = createTestCriticalRegions();
      const responses = [];
      for (const region of challenge.regions) {
        const refRegion = criticalRegions.find(
          (r) => r.offset === region.offset && r.length === region.length
        );
        const regionBytes = hexToBytes2(refRegion.data_hex);
        const hmac = await computeHmac(regionBytes, challenge.nonce);
        responses.push({ region_index: region.index, hmac });
      }

      // Step 5: Verify
      const verifyResponse = await attestationDO.fetch(
        createRequest('POST', '/attest/verify', {
          device_id: 'linux-device-42',
          nonce: challenge.nonce,
          responses,
        })
      );
      const verifyData = await verifyResponse.json();

      expect(verifyData.valid).toBe(true);
      expect(verifyData.session_token).toBeDefined();

      // Step 6: Verify the session token is cryptographically valid
      const signingKey = await importAttestationSigningKey(seedHex);
      const pubKeyBase64 = await exportPublicKeyBase64(signingKey);
      const verifyKey = await importVerifyKey(pubKeyBase64);
      const tokenPayload = await verifySessionToken(verifyKey, verifyData.session_token);

      expect(tokenPayload).not.toBeNull();
      expect(tokenPayload.device_id).toBe('linux-device-42');
      expect(tokenPayload.build_version).toBe('1.0.0');
      expect(tokenPayload.platform).toBe('linux');
    });

    it('should handle multiple platforms for the same version', async () => {
      const platforms = ['android', 'ios', 'linux', 'windows', 'macos'];

      for (const platform of platforms) {
        // Upload reference for each platform
        await attestationDO.fetch(
          createRequest(
            'POST',
            '/attest/upload-reference',
            {
              version: '1.0.0',
              platform,
              build_hash: `hash-${platform}`,
              critical_regions: createTestCriticalRegions(),
            },
            { Authorization: `Bearer ${CI_SECRET}` }
          )
        );

        // Register device
        const buildToken = await createBuildToken(seedHex, {
          version: '1.0.0',
          platform,
          build_hash: `hash-${platform}`,
          timestamp: Date.now(),
        });

        await attestationDO.fetch(
          createRequest('POST', '/attest/register', {
            build_token: buildToken,
            device_id: `device-${platform}`,
          })
        );

        // Request challenge
        const challengeResponse = await attestationDO.fetch(
          createRequest('POST', '/attest/challenge', {
            device_id: `device-${platform}`,
            build_version: '1.0.0',
          })
        );
        const challenge = await challengeResponse.json();

        expect(challenge.nonce).toBeDefined();
        expect(challenge.regions.length).toBeGreaterThanOrEqual(3);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and error handling
  // -----------------------------------------------------------------------

  describe('Edge cases', () => {
    it('should return 404 for unknown attest paths', async () => {
      const request = createRequest('GET', '/attest/unknown');
      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Not Found');
    });

    it('should handle malformed JSON in register', async () => {
      const request = new Request('https://test.workers.dev/attest/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await attestationDO.fetch(request);
      expect(response.status).toBe(500);
    });

    it('should handle concurrent registrations', async () => {
      const registrations = [];
      for (let i = 0; i < 10; i++) {
        const buildToken = await createBuildToken(seedHex, {
          version: '1.0.0',
          platform: 'android',
          build_hash: 'abc123',
          timestamp: Date.now(),
        });

        registrations.push(
          attestationDO.fetch(
            createRequest('POST', '/attest/register', {
              build_token: buildToken,
              device_id: `device-${i}`,
            })
          )
        );
      }

      const results = await Promise.all(registrations);
      for (const response of results) {
        expect(response.status).toBe(200);
      }
    });

    it('should handle device re-registration (same device_id)', async () => {
      const buildToken1 = await createBuildToken(seedHex, {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'hash-v1',
        timestamp: Date.now(),
      });

      await attestationDO.fetch(
        createRequest('POST', '/attest/register', {
          build_token: buildToken1,
          device_id: 'device-001',
        })
      );

      // Re-register with updated version
      const buildToken2 = await createBuildToken(seedHex, {
        version: '1.1.0',
        platform: 'android',
        build_hash: 'hash-v2',
        timestamp: Date.now(),
      });

      const response = await attestationDO.fetch(
        createRequest('POST', '/attest/register', {
          build_token: buildToken2,
          device_id: 'device-001',
        })
      );
      const data = await response.json();

      expect(data.status).toBe('registered');
      expect(data.device.build_version).toBe('1.1.0');
    });
  });
});

// --- Utility ---

/**
 * Convert hex to Uint8Array (local version to avoid circular imports).
 */
function hexToBytes2(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
