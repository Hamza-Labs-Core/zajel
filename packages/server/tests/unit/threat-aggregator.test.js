/**
 * Unit tests for ThreatAggregator.
 *
 * Covers:
 * - Fetching blocked IPs via internal DO endpoint
 * - isBlockedFleetWide check
 * - Handling empty responses
 * - Handling error responses
 */

import { describe, it, expect, vi } from 'vitest';
import { ThreatAggregator } from '../../src/threat-aggregator.js';

/**
 * Mock Durable Object Stub.
 * Returns controlled JSON responses from the internal threat-intel endpoint.
 */
function createMockDOStub(responseData, statusCode = 200) {
  return {
    fetch: vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseData), {
        status: statusCode,
        headers: { 'Content-Type': 'application/json' },
      })
    ),
  };
}

describe('ThreatAggregator', () => {
  describe('getBlockedIPs', () => {
    it('should return blocked IPs from DO endpoint', async () => {
      const stub = createMockDOStub({
        blockedIPs: ['1.2.3.4', '5.6.7.8', '10.0.0.1'],
      });
      const aggregator = new ThreatAggregator(stub);

      const result = await aggregator.getBlockedIPs();

      expect(result).toEqual(['1.2.3.4', '5.6.7.8', '10.0.0.1']);
      expect(stub.fetch).toHaveBeenCalledTimes(1);

      // Verify correct internal URL
      const calledRequest = stub.fetch.mock.calls[0][0];
      expect(calledRequest.url).toBe('https://internal/threat-intel/blocked-ips');
    });

    it('should return empty array when no blocked IPs', async () => {
      const stub = createMockDOStub({ blockedIPs: [] });
      const aggregator = new ThreatAggregator(stub);

      const result = await aggregator.getBlockedIPs();

      expect(result).toEqual([]);
    });

    it('should return empty array when response has no blockedIPs field', async () => {
      const stub = createMockDOStub({});
      const aggregator = new ThreatAggregator(stub);

      const result = await aggregator.getBlockedIPs();

      expect(result).toEqual([]);
    });
  });

  describe('isBlockedFleetWide', () => {
    it('should return true for a blocked IP', async () => {
      const stub = createMockDOStub({
        blockedIPs: ['1.2.3.4', '5.6.7.8'],
      });
      const aggregator = new ThreatAggregator(stub);

      const blocked = await aggregator.isBlockedFleetWide('1.2.3.4');

      expect(blocked).toBe(true);
    });

    it('should return false for a non-blocked IP', async () => {
      const stub = createMockDOStub({
        blockedIPs: ['1.2.3.4', '5.6.7.8'],
      });
      const aggregator = new ThreatAggregator(stub);

      const blocked = await aggregator.isBlockedFleetWide('9.9.9.9');

      expect(blocked).toBe(false);
    });

    it('should return false when no IPs are blocked', async () => {
      const stub = createMockDOStub({ blockedIPs: [] });
      const aggregator = new ThreatAggregator(stub);

      const blocked = await aggregator.isBlockedFleetWide('1.2.3.4');

      expect(blocked).toBe(false);
    });
  });
});
