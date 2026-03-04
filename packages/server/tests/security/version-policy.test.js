/**
 * Security tests for version policy enforcement edge cases.
 *
 * Tests that the attestation registry correctly enforces version policies
 * including blocked versions, minimum versions, and malformed version strings.
 *
 * Covers:
 * - Blocked version rejection
 * - Below-minimum version rejection
 * - Malformed version strings (injection attempts)
 * - Version policy update authorization
 * - Empty/null version handling
 * - Exact minimum version boundary
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';
import {
  importAttestationSigningKey,
  signPayloadEd25519,
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

describe('Version Policy Security Tests', () => {
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

  it('should reject blocked version on registration', async () => {
    // Set version policy with blocked version
    await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '1.0.0',
      recommended_version: '1.2.0',
      blocked_versions: ['1.1.0'],
    }, { Authorization: 'Bearer test-secret' }));

    // Try to register with blocked version
    const buildToken = await createBuildToken(seedHex, {
      version: '1.1.0',
      platform: 'android',
      build_hash: 'abc123',
      timestamp: Date.now(),
    });

    const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
      build_token: buildToken,
      device_id: 'device-blocked',
    }));

    expect(resp.status).toBe(403);
    const data = await resp.json();
    expect(data.error).toContain('blocked');
  });

  it('should reject version below minimum', async () => {
    // Set minimum version policy
    await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '2.0.0',
      recommended_version: '2.1.0',
      blocked_versions: [],
    }, { Authorization: 'Bearer test-secret' }));

    const buildToken = await createBuildToken(seedHex, {
      version: '1.9.9',
      platform: 'android',
      build_hash: 'abc123',
      timestamp: Date.now(),
    });

    const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
      build_token: buildToken,
      device_id: 'device-old',
    }));

    expect(resp.status).toBe(403);
    const data = await resp.json();
    expect(data.error).toContain('below minimum');
  });

  it('should reject malformed version strings', async () => {
    const malformedVersions = [
      'not-a-version',
      '1.0',
      '1.0.0.0',
      '../../../etc/passwd',
      '<script>alert(1)</script>',
      '1.0.0\n1.0.0',
    ];

    for (const version of malformedVersions) {
      const buildToken = await createBuildToken(seedHex, {
        version,
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });

      const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: `device-malformed-${Date.now()}`,
      }));

      // Should reject with 403 (invalid version format triggers blocked status)
      expect(resp.status).toBe(403);
    }
  });

  it('should require authentication for version policy updates', async () => {
    // Try to update without auth
    const resp = await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '99.0.0',
      blocked_versions: ['1.0.0'],
    }));

    expect(resp.status).toBe(401);
  });

  it('should accept valid version at minimum boundary', async () => {
    await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '1.0.0',
      recommended_version: '1.2.0',
      blocked_versions: [],
    }, { Authorization: 'Bearer test-secret' }));

    const buildToken = await createBuildToken(seedHex, {
      version: '1.0.0', // Exactly at minimum
      platform: 'android',
      build_hash: 'abc123',
      timestamp: Date.now(),
    });

    const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
      build_token: buildToken,
      device_id: 'device-exact-min',
    }));

    expect(resp.status).toBe(200);
  });

  it('should accept version above minimum', async () => {
    await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '1.0.0',
      recommended_version: '1.2.0',
      blocked_versions: [],
    }, { Authorization: 'Bearer test-secret' }));

    const buildToken = await createBuildToken(seedHex, {
      version: '2.0.0',
      platform: 'android',
      build_hash: 'abc123',
      timestamp: Date.now(),
    });

    const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
      build_token: buildToken,
      device_id: 'device-above-min',
    }));

    expect(resp.status).toBe(200);
  });

  it('should return update_recommended for versions below recommended', async () => {
    await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '1.0.0',
      recommended_version: '1.5.0',
      blocked_versions: [],
    }, { Authorization: 'Bearer test-secret' }));

    const buildToken = await createBuildToken(seedHex, {
      version: '1.2.0',
      platform: 'android',
      build_hash: 'abc123',
      timestamp: Date.now(),
    });

    const resp = await attestationDO.fetch(createRequest('POST', '/attest/register', {
      build_token: buildToken,
      device_id: 'device-update-rec',
    }));

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.version_status).toBe('update_recommended');
    expect(data.recommended_version).toBe('1.5.0');
  });

  it('should return version policy via GET /attest/versions', async () => {
    await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: '1.0.0',
      recommended_version: '1.2.0',
      blocked_versions: ['0.9.0'],
    }, { Authorization: 'Bearer test-secret' }));

    const resp = await attestationDO.fetch(createRequest('GET', '/attest/versions'));
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.minimum_version).toBe('1.0.0');
    expect(data.recommended_version).toBe('1.2.0');
    expect(data.blocked_versions).toContain('0.9.0');
  });

  it('should reject version policy with invalid format', async () => {
    const resp = await attestationDO.fetch(createRequest('POST', '/attest/versions', {
      minimum_version: 'not-semver',
      recommended_version: '1.2.0',
    }, { Authorization: 'Bearer test-secret' }));

    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toContain('Invalid minimum_version');
  });
});
