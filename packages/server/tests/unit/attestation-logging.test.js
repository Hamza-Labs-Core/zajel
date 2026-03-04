/**
 * Unit tests for attestation logging security
 *
 * Verifies that sensitive data (device_id, nonce, challenge.device_id) is not
 * logged via console.error in production environments.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AttestationRegistryDO } from '../../src/durable-objects/attestation-registry-do.js';

// --- Mock Storage ---
class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) {
    return this.data.get(key);
  }
  async put(key, value) {
    this.data.set(key, value);
  }
  async delete(key) {
    this.data.delete(key);
  }
  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) {
        results.set(key, value);
      }
    }
    return results;
  }
  async getAlarm() {
    return null;
  }
  async setAlarm() {}
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
}

function createRequest(method, path, body = null) {
  const url = `https://test.workers.dev${path}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(url, options);
}

describe('Attestation Logging Security', () => {
  let mockState;
  let attestationDO;
  let loggerSpy;

  beforeEach(() => {
    mockState = new MockState();

    // Create env with production flag to test redaction behavior
    const env = {
      ENVIRONMENT: 'production',
      LOG_LEVEL: 'warn',
    };

    attestationDO = new AttestationRegistryDO(mockState, env);

    // Spy on logger methods
    loggerSpy = {
      warn: vi.spyOn(attestationDO.logger, 'warn'),
      error: vi.spyOn(attestationDO.logger, 'error'),
      debug: vi.spyOn(attestationDO.logger, 'debug'),
    };

  });

  describe('handleVerify logging security', () => {
    it('should use logger.warn for invalid nonce, not console.error with device_id', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'sensitive-device-123',
        nonce: 'nonexistent-nonce',
        responses: [],
      });

      await attestationDO.fetch(request);

      // Verify logger.warn was called
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: invalid or expired nonce',
        {
          action: 'attest_verify_failed',
          reason: 'invalid_nonce',
        }
      );

      // Verify console.error was NOT called with device_id
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[verify]'),
        expect.objectContaining({ device_id: expect.anything() })
      );

      consoleErrorSpy.mockRestore();
    });

    it('should use logger.warn for expired challenge, not leak device_id or nonce', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Set up expired challenge
      const expiredChallenge = {
        device_id: 'device-456',
        created_at: Date.now() - 6 * 60 * 1000, // 6 minutes ago (exceeds NONCE_TTL)
        regions: [],
        build_version: '1.0.0',
        platform: 'android',
      };
      await mockState.storage.put('nonce:test-nonce', expiredChallenge);

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-456',
        nonce: 'test-nonce',
        responses: [],
      });

      await attestationDO.fetch(request);

      // Verify logger.warn was called without sensitive data
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: challenge expired',
        {
          action: 'attest_verify_failed',
          reason: 'challenge_expired',
        }
      );

      // Verify console.error was NOT called with nonce or device_id
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[verify]'),
        expect.objectContaining({ nonce: expect.anything() })
      );
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[verify]'),
        expect.objectContaining({ device_id: expect.anything() })
      );

      consoleErrorSpy.mockRestore();
    });

    it('should use logger.warn for device ID mismatch without leaking expected device_id', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Set up challenge with different device_id
      const challenge = {
        device_id: 'expected-device-789',
        created_at: Date.now(),
        regions: [],
        build_version: '1.0.0',
        platform: 'android',
      };
      await mockState.storage.put('nonce:test-nonce-2', challenge);

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'wrong-device-999',
        nonce: 'test-nonce-2',
        responses: [],
      });

      await attestationDO.fetch(request);

      // Verify logger.warn was called without device_id or expected device_id
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: device ID mismatch',
        {
          action: 'attest_verify_failed',
          reason: 'device_mismatch',
        }
      );

      // Verify console.error was NOT called with either device_id
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[verify]'),
        expect.objectContaining({ expected: expect.anything() })
      );

      consoleErrorSpy.mockRestore();
    });

    it('should log reference binary metadata (version/platform) as non-sensitive', async () => {
      // Set up challenge that references non-existent reference binary
      const challenge = {
        device_id: 'device-ref-test',
        created_at: Date.now(),
        regions: [],
        build_version: '2.0.0',
        platform: 'ios',
      };
      await mockState.storage.put('nonce:test-nonce-3', challenge);

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-ref-test',
        nonce: 'test-nonce-3',
        responses: [],
      });

      await attestationDO.fetch(request);

      // Verify logger.warn includes version/platform (not sensitive)
      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: reference binary not found',
        {
          action: 'attest_verify_failed',
          reason: 'reference_not_found',
          version: '2.0.0',
          platform: 'ios',
        }
      );
    });

    it('should use logger.warn for wrong response count', async () => {
      // Set up challenge with 2 regions but we'll submit wrong count
      const challenge = {
        device_id: 'device-count-test',
        created_at: Date.now(),
        regions: [
          { index: 0, offset: 0, length: 100 },
          { index: 1, offset: 100, length: 100 },
        ],
        build_version: '1.0.0',
        platform: 'android',
      };
      await mockState.storage.put('nonce:test-nonce-count', challenge);
      // Also need reference binary so we pass the reference lookup
      await mockState.storage.put('reference:1.0.0:android', {
        critical_regions: [
          { offset: 0, length: 100, data_hex: 'aa'.repeat(100) },
          { offset: 100, length: 100, data_hex: 'bb'.repeat(100) },
        ],
      });

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-count-test',
        nonce: 'test-nonce-count',
        responses: [{ region_index: 0, hmac: 'ff'.repeat(32) }], // Only 1 response for 2 regions
      });

      await attestationDO.fetch(request);

      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: wrong response count',
        {
          action: 'attest_verify_failed',
          reason: 'invalid_response_count',
          expected: 2,
          got: 1,
        }
      );
    });

    it('should use logger.warn for invalid region_index', async () => {
      const challenge = {
        device_id: 'device-region-test',
        created_at: Date.now(),
        regions: [{ index: 0, offset: 0, length: 100 }],
        build_version: '1.0.0',
        platform: 'android',
      };
      await mockState.storage.put('nonce:test-nonce-region', challenge);
      await mockState.storage.put('reference:1.0.0:android', {
        critical_regions: [{ offset: 0, length: 100, data_hex: 'aa'.repeat(100) }],
      });

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-region-test',
        nonce: 'test-nonce-region',
        responses: [{ region_index: 99, hmac: 'ff'.repeat(32) }], // Invalid index
      });

      await attestationDO.fetch(request);

      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: invalid region index',
        {
          action: 'attest_verify_failed',
          reason: 'invalid_region_index',
          region_index: 99,
        }
      );
    });

    it('should use logger.warn for reference data missing for region', async () => {
      const challenge = {
        device_id: 'device-refdata-test',
        created_at: Date.now(),
        regions: [{ index: 0, offset: 0, length: 100 }],
        build_version: '1.0.0',
        platform: 'android',
      };
      await mockState.storage.put('nonce:test-nonce-refdata', challenge);
      // Reference exists but region data is missing (no data_hex)
      await mockState.storage.put('reference:1.0.0:android', {
        critical_regions: [{ offset: 0, length: 100 }], // Missing data_hex
      });

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-refdata-test',
        nonce: 'test-nonce-refdata',
        responses: [{ region_index: 0, hmac: 'ff'.repeat(32) }],
      });

      await attestationDO.fetch(request);

      expect(loggerSpy.warn).toHaveBeenCalledWith(
        '[audit] Verification failed: reference data not available',
        {
          action: 'attest_verify_failed',
          reason: 'reference_data_missing',
          region_index: 0,
        }
      );
    });

    it('should use logger.warn for HMAC mismatch', async () => {
      // Create a completely fresh DO with no pre-existing spies to avoid
      // interference between vi.spyOn and crypto.subtle async operations.
      const hmacState = new MockState();
      const hmacEnv = { ENVIRONMENT: 'production', LOG_LEVEL: 'warn' };
      const hmacDO = new AttestationRegistryDO(hmacState, hmacEnv);

      // Nonce must be valid hex because computeHmac calls hexToBytes(nonce)
      const hexNonce = 'ab'.repeat(32);
      const challenge = {
        device_id: 'device-hmac-test',
        created_at: Date.now(),
        regions: [{ index: 0, offset: 0, length: 100 }],
        build_version: '1.0.0',
        platform: 'android',
      };
      await hmacState.storage.put(`nonce:${hexNonce}`, challenge);
      await hmacState.storage.put('reference:1.0.0:android', {
        critical_regions: [{ offset: 0, length: 100, data_hex: 'aa'.repeat(100) }],
      });

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-hmac-test',
        nonce: hexNonce,
        responses: [{ region_index: 0, hmac: 'ff'.repeat(32) }], // Wrong HMAC
      });

      // Spy on logger AFTER building the request (minimize interference)
      const warnSpy = vi.spyOn(hmacDO.logger, 'warn');

      const response = await hmacDO.fetch(request);
      const data = await response.json();

      // The verify endpoint should detect the HMAC mismatch and return valid: false
      expect(data.valid).toBe(false);
      expect(data.error).toBe('HMAC mismatch');

      expect(warnSpy).toHaveBeenCalledWith(
        '[audit] Verification failed: HMAC mismatch',
        {
          action: 'attest_verify_failed',
          reason: 'hmac_mismatch',
          region_index: 0,
        }
      );
    });

    it('should not leak sensitive data in any logger metadata fields', async () => {
      const request = createRequest('POST', '/attest/verify', {
        device_id: 'ultra-sensitive-device',
        nonce: 'secret-nonce-123',
        responses: [],
      });

      await attestationDO.fetch(request);

      // Get all logger.warn calls
      const warnCalls = loggerSpy.warn.mock.calls;

      // Verify no metadata object contains device_id, nonce, or expected fields
      for (const [_message, metadata] of warnCalls) {
        if (metadata) {
          expect(metadata).not.toHaveProperty('device_id');
          expect(metadata).not.toHaveProperty('nonce');
          expect(metadata).not.toHaveProperty('expected');
        }
      }
    });
  });

  describe('client error response consistency', () => {
    it('should return generic error messages to clients despite logging fix', async () => {
      const request = createRequest('POST', '/attest/verify', {
        device_id: 'device-123',
        nonce: 'bad-nonce',
        responses: [],
      });

      const response = await attestationDO.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(403);
      expect(data.error).toBe('Invalid or expired nonce');
      // Error message should NOT contain device_id
      expect(data.error).not.toContain('device-123');
    });
  });

  describe('debug-level logging for development', () => {
    it('should call logger.debug with full sensitive context on each error path', async () => {
      // Use debug-level env to ensure debug calls are recorded
      const debugEnv = {
        ENVIRONMENT: 'development',
        LOG_LEVEL: 'debug',
      };
      const debugState = new MockState();
      const debugDO = new AttestationRegistryDO(debugState, debugEnv);
      const debugSpy = vi.spyOn(debugDO.logger, 'debug');

      const request = createRequest('POST', '/attest/verify', {
        device_id: 'debug-device-001',
        nonce: 'debug-nonce-001',
        responses: [],
      });

      await debugDO.fetch(request);

      // Verify logger.debug was called with the sensitive data for troubleshooting
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('[verify]'),
        expect.objectContaining({
          device_id: 'debug-device-001',
        })
      );
    });
  });
});
