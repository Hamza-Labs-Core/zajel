/**
 * Security tests for encrypted data integrity.
 *
 * Tests that AES-GCM authenticated encryption in BuildVerifier
 * properly detects tampering with stored trusted key data.
 *
 * Covers:
 * - Bit-flip in ciphertext (modify single byte)
 * - Modified IV
 * - Truncated ciphertext
 * - Graceful fallback on tampered data
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';

describe('Ciphertext Tampering Detection', () => {
  let mockState;
  let registry;
  const secret = 'tamper-test-secret';
  const authHeaders = { Authorization: `Bearer ${secret}` };

  beforeEach(async () => {
    mockState = new MockState();
    registry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
      TRUSTED_BUILD_KEYS: '', // No env fallback
    });
    vi.useFakeTimers();

    // Store valid encrypted keys
    await registry.fetch(createRequest('POST', '/servers/trusted-keys', {
      keys: ['original-key-1', 'original-key-2'],
    }, authHeaders));
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  it('should detect bit-flip in ciphertext', async () => {
    const stored = await mockState.storage.get('trusted_build_keys');
    expect(stored.encrypted).toBe(true);

    // Flip a bit in the ciphertext
    const tampered = { ...stored };
    const decoded = atob(tampered.data);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    bytes[0] ^= 0x01; // Flip one bit in first byte
    tampered.data = btoa(String.fromCharCode(...bytes));

    // Write tampered data back
    await mockState.storage.put('trusted_build_keys', tampered);

    // Create fresh registry to force re-read from storage
    const freshRegistry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
      TRUSTED_BUILD_KEYS: '',
    });

    // GET trusted keys should fail (decryption error from AES-GCM auth tag)
    const resp = await freshRegistry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    // Should return 500 (failed to decrypt stored keys)
    expect(resp.status).toBe(500);
  });

  it('should detect modified IV', async () => {
    const stored = await mockState.storage.get('trusted_build_keys');

    // Modify the IV
    const tampered = { ...stored };
    const ivDecoded = atob(tampered.iv);
    const ivBytes = new Uint8Array(ivDecoded.length);
    for (let i = 0; i < ivDecoded.length; i++) ivBytes[i] = ivDecoded.charCodeAt(i);
    ivBytes[0] ^= 0xFF; // Corrupt IV
    tampered.iv = btoa(String.fromCharCode(...ivBytes));

    await mockState.storage.put('trusted_build_keys', tampered);

    const freshRegistry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
      TRUSTED_BUILD_KEYS: '',
    });

    // GET trusted keys should fail gracefully
    const resp = await freshRegistry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    expect(resp.status).toBe(500);
  });

  it('should detect truncated ciphertext', async () => {
    const stored = await mockState.storage.get('trusted_build_keys');

    // Truncate ciphertext to half its length
    const tampered = { ...stored };
    const decoded = atob(tampered.data);
    const truncated = decoded.slice(0, Math.floor(decoded.length / 2));
    tampered.data = btoa(truncated);

    await mockState.storage.put('trusted_build_keys', tampered);

    const freshRegistry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
      TRUSTED_BUILD_KEYS: '',
    });

    const resp = await freshRegistry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    // Should not crash, returns error
    expect(resp.status).toBe(500);
  });

  it('should fall back to env var during registration when ciphertext is tampered', async () => {
    const stored = await mockState.storage.get('trusted_build_keys');

    // Corrupt ciphertext
    const tampered = { ...stored };
    tampered.data = btoa('completely-invalid-ciphertext-data');
    await mockState.storage.put('trusted_build_keys', tampered);

    // Create registry WITH env var fallback
    const freshRegistry = new ServerRegistryDO(mockState, {
      SERVER_REGISTRY_SECRET: 'test-secret',
      CI_UPLOAD_SECRET: secret,
      TRUSTED_BUILD_KEYS: 'fallback-key-from-env',
      REPLAY_GRACE_MODE: 'true',
    });

    // Register a server -- buildVerifier.loadTrustedKeys should fall back to env var
    // since decryption fails
    const resp = await freshRegistry.fetch(createRequest('POST', '/servers', {
      serverId: 'ed25519:tamper-fallback',
      endpoint: 'wss://tamper.example.com',
      publicKey: 'key',
      buildHash: 'a'.repeat(64),
      buildSignature: 'invalid-sig',
      buildSigningKey: 'fallback-key-from-env',
    }, { Authorization: 'Bearer test-secret' }));

    // Registration should succeed (buildVerified depends on sig validity,
    // but the key should be recognized as trusted from env fallback)
    expect(resp.status).toBe(200);
    const entry = await mockState.storage.get('server:ed25519:tamper-fallback');
    expect(entry).toBeDefined();
  });

  it('should detect completely replaced ciphertext data', async () => {
    // Replace with valid base64 but wrong encrypted content
    const tampered = {
      encrypted: true,
      iv: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))),
      data: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))),
    };
    await mockState.storage.put('trusted_build_keys', tampered);

    const freshRegistry = new ServerRegistryDO(mockState, {
      CI_UPLOAD_SECRET: secret,
      TRUSTED_BUILD_KEYS: '',
    });

    const resp = await freshRegistry.fetch(createRequest('GET', '/servers/trusted-keys', null, authHeaders));
    expect(resp.status).toBe(500);
  });
});
