/**
 * Unit tests for diagnostic report schema validation.
 *
 * Tests all valid and invalid report schemas: missing fields, wrong types,
 * boundary values, invalid platform values, malformed sessionHash.
 */

import { describe, it, expect } from 'vitest';
import { validateReport } from '../../src/validation.js';

/**
 * Factory for a valid diagnostic report.
 * Override specific fields as needed.
 */
function validReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionHash: 'a'.repeat(64),
    appVersion: '1.2.3',
    buildNumber: '42',
    platform: 'android',
    platformVersion: 'Android 14',
    locale: 'en-US',
    timestamp: 1709380800000,
    ...overrides,
  };
}

describe('validateReport', () => {
  describe('valid reports', () => {
    it('should accept a minimal valid report', () => {
      const result = validateReport(validReport());
      expect(result.valid).toBe(true);
      expect(result.report).toBeDefined();
      expect(result.report!.sessionHash).toBe('a'.repeat(64));
    });

    it('should accept a full report with all optional fields', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crypto',
              message: 'ChaCha20 decrypt failed',
              stackTrace: 'at line 42',
              signature: 'abc123def456',
              count: 3,
              firstOccurrence: 1709380700000,
              lastOccurrence: 1709380800000,
            },
          ],
          performance: {
            startupTimeMs: 1200,
            frameRateAvg: 58.5,
            frameRateP95: 55.0,
            memoryUsageMb: 120,
            memoryPeakMb: 150,
          },
          network: {
            signalingConnectSuccessRate: 0.95,
            signalingConnectAttempts: 20,
            webrtcEstablishSuccessRate: 0.9,
            webrtcEstablishAttempts: 10,
            relayUsageRate: 0.1,
            avgLatencyMs: 45.5,
          },
          connectionType: 'direct_p2p',
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.report!.errors).toHaveLength(1);
      expect(result.report!.performance!.startupTimeMs).toBe(1200);
      expect(result.report!.network!.signalingConnectSuccessRate).toBe(0.95);
      expect(result.report!.connectionType).toBe('direct_p2p');
    });

    it('should accept all valid platform values', () => {
      const platforms = ['android', 'ios', 'windows', 'macos', 'linux', 'web'];
      for (const platform of platforms) {
        const result = validateReport(validReport({ platform }));
        expect(result.valid).toBe(true);
      }
    });

    it('should accept all valid connection types', () => {
      const types = ['direct_p2p', 'relay', 'none'];
      for (const connectionType of types) {
        const result = validateReport(validReport({ connectionType }));
        expect(result.valid).toBe(true);
      }
    });

    it('should accept all valid error categories', () => {
      const categories = ['crash', 'network', 'crypto', 'storage', 'ui', 'protocol', 'other'];
      for (const category of categories) {
        const result = validateReport(
          validReport({
            errors: [
              {
                category,
                message: 'test error',
                signature: 'sig123',
                count: 1,
                firstOccurrence: 1709380700000,
                lastOccurrence: 1709380800000,
              },
            ],
          }),
        );
        expect(result.valid).toBe(true);
      }
    });

    it('should accept sessionHash with uppercase hex characters', () => {
      const result = validateReport(validReport({ sessionHash: 'A1B2C3D4'.repeat(8) }));
      expect(result.valid).toBe(true);
    });

    it('should accept semver with pre-release suffix', () => {
      const result = validateReport(validReport({ appVersion: '1.2.3-beta.1' }));
      expect(result.valid).toBe(true);
    });

    it('should accept report with empty errors array', () => {
      const result = validateReport(validReport({ errors: [] }));
      expect(result.valid).toBe(true);
    });

    it('should accept report without optional connectionType', () => {
      const result = validateReport(validReport());
      expect(result.valid).toBe(true);
      expect(result.report!.connectionType).toBeUndefined();
    });

    it('should accept error without stackTrace', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crash',
              message: 'something broke',
              signature: 'sig',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
          ],
        }),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('invalid body types', () => {
    it('should reject null body', () => {
      const result = validateReport(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON object');
    });

    it('should reject undefined body', () => {
      const result = validateReport(undefined);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON object');
    });

    it('should reject array body', () => {
      const result = validateReport([]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON object');
    });

    it('should reject string body', () => {
      const result = validateReport('hello');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON object');
    });

    it('should reject number body', () => {
      const result = validateReport(42);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('JSON object');
    });
  });

  describe('missing required fields', () => {
    const requiredFields = [
      'sessionHash',
      'appVersion',
      'buildNumber',
      'platform',
      'platformVersion',
      'locale',
      'timestamp',
    ];

    for (const field of requiredFields) {
      it(`should reject missing ${field}`, () => {
        const report = validReport();
        delete report[field];
        const result = validateReport(report);
        expect(result.valid).toBe(false);
        expect(result.error).toContain(field);
      });
    }
  });

  describe('wrong types for required fields', () => {
    it('should reject non-string sessionHash', () => {
      const result = validateReport(validReport({ sessionHash: 12345 }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('sessionHash');
      expect(result.error).toContain('string');
    });

    it('should reject non-number timestamp', () => {
      const result = validateReport(validReport({ timestamp: 'not-a-number' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timestamp');
      expect(result.error).toContain('number');
    });

    it('should reject empty string sessionHash', () => {
      const result = validateReport(validReport({ sessionHash: '' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('sessionHash');
    });

    it('should reject NaN timestamp', () => {
      const result = validateReport(validReport({ timestamp: NaN }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timestamp');
    });

    it('should reject negative timestamp', () => {
      const result = validateReport(validReport({ timestamp: -1 }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timestamp');
    });

    it('should reject Infinity timestamp', () => {
      const result = validateReport(validReport({ timestamp: Infinity }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('timestamp');
    });
  });

  describe('sessionHash validation', () => {
    it('should reject sessionHash shorter than 64 chars', () => {
      const result = validateReport(validReport({ sessionHash: 'a'.repeat(63) }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('64-character hex');
    });

    it('should reject sessionHash longer than 64 chars', () => {
      const result = validateReport(validReport({ sessionHash: 'a'.repeat(65) }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('64-character hex');
    });

    it('should reject sessionHash with non-hex characters', () => {
      const result = validateReport(validReport({ sessionHash: 'g'.repeat(64) }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('64-character hex');
    });
  });

  describe('appVersion validation', () => {
    it('should reject non-semver appVersion', () => {
      const result = validateReport(validReport({ appVersion: 'not-semver' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('semver');
    });

    it('should reject appVersion with only major.minor', () => {
      const result = validateReport(validReport({ appVersion: '1.2' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('semver');
    });
  });

  describe('buildNumber validation', () => {
    it('should reject non-numeric buildNumber', () => {
      const result = validateReport(validReport({ buildNumber: 'abc' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('numeric');
    });

    it('should reject buildNumber with decimal', () => {
      const result = validateReport(validReport({ buildNumber: '1.5' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('numeric');
    });
  });

  describe('platform validation', () => {
    it('should reject invalid platform', () => {
      const result = validateReport(validReport({ platform: 'chromeos' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('platform');
      expect(result.error).toContain('android');
    });
  });

  describe('connectionType validation', () => {
    it('should reject invalid connectionType', () => {
      const result = validateReport(validReport({ connectionType: 'wifi' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('connectionType');
    });

    it('should reject non-string connectionType', () => {
      const result = validateReport(validReport({ connectionType: 42 }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('connectionType');
    });
  });

  describe('errors array validation', () => {
    it('should reject non-array errors field', () => {
      const result = validateReport(validReport({ errors: 'not-an-array' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('errors');
      expect(result.error).toContain('array');
    });

    it('should reject error with invalid category', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'invalid-category',
              message: 'test',
              signature: 'sig',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('category');
    });

    it('should reject error with missing message', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crash',
              signature: 'sig',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('message');
    });

    it('should reject error with missing signature', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crash',
              message: 'test',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signature');
    });

    it('should reject error with negative count', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crash',
              message: 'test',
              signature: 'sig',
              count: -1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('count');
    });

    it('should reject error with non-string stackTrace', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crash',
              message: 'test',
              signature: 'sig',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
              stackTrace: 42,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('stackTrace');
    });

    it('should report correct index for invalid error in array', () => {
      const result = validateReport(
        validReport({
          errors: [
            {
              category: 'crash',
              message: 'valid error',
              signature: 'sig1',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
            {
              category: 'invalid',
              message: 'invalid error',
              signature: 'sig2',
              count: 1,
              firstOccurrence: 1000,
              lastOccurrence: 2000,
            },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('errors[1]');
    });
  });

  describe('performance validation', () => {
    it('should reject non-object performance', () => {
      const result = validateReport(validReport({ performance: 'not-object' }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('performance');
    });

    it('should reject negative startupTimeMs', () => {
      const result = validateReport(validReport({ performance: { startupTimeMs: -100 } }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('startupTimeMs');
    });

    it('should reject non-number frameRateAvg', () => {
      const result = validateReport(validReport({ performance: { frameRateAvg: 'fast' } }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('frameRateAvg');
    });

    it('should accept zero values for performance metrics', () => {
      const result = validateReport(
        validReport({
          performance: {
            startupTimeMs: 0,
            frameRateAvg: 0,
            memoryUsageMb: 0,
          },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('should accept partial performance metrics', () => {
      const result = validateReport(
        validReport({
          performance: { startupTimeMs: 500 },
        }),
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('network validation', () => {
    it('should reject non-object network', () => {
      const result = validateReport(validReport({ network: 42 }));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('network');
    });

    it('should reject success rate greater than 1', () => {
      const result = validateReport(
        validReport({
          network: { signalingConnectSuccessRate: 1.5, signalingConnectAttempts: 10 },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('signalingConnectSuccessRate');
    });

    it('should reject negative success rate', () => {
      const result = validateReport(
        validReport({
          network: { webrtcEstablishSuccessRate: -0.1, webrtcEstablishAttempts: 10 },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('webrtcEstablishSuccessRate');
    });

    it('should accept rate values at boundaries (0 and 1)', () => {
      const result = validateReport(
        validReport({
          network: {
            signalingConnectSuccessRate: 0,
            webrtcEstablishSuccessRate: 1,
            relayUsageRate: 0.5,
          },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('should reject negative avgLatencyMs', () => {
      const result = validateReport(
        validReport({
          network: { avgLatencyMs: -10 },
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('avgLatencyMs');
    });
  });
});
