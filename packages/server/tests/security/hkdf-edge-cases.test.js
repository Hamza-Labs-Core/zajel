/**
 * Security tests for HKDF key derivation edge cases.
 *
 * Tests the BuildVerifier.deriveStorageKey / encryptKeys / decryptKeys path
 * in server-registry-do.js with adversarial or edge-case secrets.
 *
 * Covers:
 * - Empty CI_UPLOAD_SECRET string
 * - Unicode/multi-byte secret
 * - Very long secret (max-length)
 * - Deterministic derivation (same secret produces same key)
 * - Different secrets produce different ciphertext
 * - Fresh IV on each encryption
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';

describe('HKDF Edge Cases', () => {
  let mockState;

  beforeEach(() => {
    mockState = new MockState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  it('should reject authentication when CI_UPLOAD_SECRET is empty', async () => {
    const registry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: '',
    });

    // Attempt to upload keys with empty secret -- should fail auth
    const resp = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['test-key-1'],
    }, { Authorization: 'Bearer ' }));

    // Empty CI_UPLOAD_SECRET means CI access is not configured
    expect(resp.status).toBe(503);
  });

  it('should handle Latin-1 extended characters in CI_UPLOAD_SECRET', async () => {
    // Use Latin-1 safe characters (HTTP headers only support ISO-8859-1 / Latin-1)
    // Characters above 255 cannot be used in HTTP headers directly.
    const latin1Secret = 'secret-\u00e9\u00e8\u00ea-\u00f1-\u00fc';
    const registry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: latin1Secret,
    });

    const authHeaders = { Authorization: `Bearer ${latin1Secret}` };

    // Upload keys
    const uploadResp = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['unicode-key-1'],
    }, authHeaders));
    expect(uploadResp.status).toBe(200);

    // Verify stored data is encrypted
    const stored = await mockState.storage.get('trusted_build_keys');
    expect(stored).toBeDefined();
    expect(stored.encrypted).toBe(true);

    // Retrieve keys (should decrypt successfully with same secret)
    const getResp = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    expect(getResp.status).toBe(200);
    const data = await getResp.json();
    expect(data.keys).toContain('unicode-key-1');
  });

  it('should handle very long CI_UPLOAD_SECRET', async () => {
    const longSecret = 'A'.repeat(10000);
    const registry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: longSecret,
    });

    const authHeaders = { Authorization: `Bearer ${longSecret}` };

    // Upload keys
    const uploadResp = await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['long-secret-key-1'],
    }, authHeaders));
    expect(uploadResp.status).toBe(200);

    // Verify round-trip
    const getResp = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    expect(getResp.status).toBe(200);
    const data = await getResp.json();
    expect(data.keys).toContain('long-secret-key-1');
  });

  it('should produce different ciphertext for different secrets', async () => {
    // Encrypt with secret1
    const registry1 = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: 'secret-alpha',
    });
    await registry1.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['shared-key'],
    }, { Authorization: 'Bearer secret-alpha' }));

    const stored1 = await mockState.storage.get('trusted_build_keys');
    const ciphertext1 = stored1.data;

    // Clear and encrypt with secret2
    mockState.storage.clear();
    const registry2 = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: 'secret-beta',
    });
    await registry2.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['shared-key'],
    }, { Authorization: 'Bearer secret-beta' }));

    const stored2 = await mockState.storage.get('trusted_build_keys');
    const ciphertext2 = stored2.data;

    // Ciphertext should differ (different keys + random IV)
    expect(ciphertext1).not.toBe(ciphertext2);
  });

  it('should produce different ciphertext on successive encryptions (random IV)', async () => {
    const secret = 'determinism-test-secret';
    const authHeaders = { Authorization: `Bearer ${secret}` };

    // First encryption
    const registry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
    });
    await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['same-key'],
    }, authHeaders));
    const stored1 = await mockState.storage.get('trusted_build_keys');
    const iv1 = stored1.iv;
    const data1 = stored1.data;

    // Second encryption (overwrite)
    await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['same-key'],
    }, authHeaders));
    const stored2 = await mockState.storage.get('trusted_build_keys');
    const iv2 = stored2.iv;
    const data2 = stored2.data;

    // IVs should differ (crypto.getRandomValues produces fresh IV each time)
    expect(iv1).not.toBe(iv2);
    // Ciphertext should also differ due to different IVs
    expect(data1).not.toBe(data2);
  });

  it('should correctly round-trip encryption and decryption', async () => {
    const secret = 'round-trip-test-secret';
    const authHeaders = { Authorization: `Bearer ${secret}` };
    const registry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
    });

    const testKeys = ['key-alpha', 'key-beta', 'key-gamma'];

    // Upload keys
    await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: testKeys,
    }, authHeaders));

    // Read back
    const getResp = await registry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    expect(getResp.status).toBe(200);
    const data = await getResp.json();
    expect(data.keys).toEqual(testKeys);
  });
});
