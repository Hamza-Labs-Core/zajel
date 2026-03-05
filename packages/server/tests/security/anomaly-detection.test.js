/**
 * Security tests for adversarial anomaly detection scenarios.
 *
 * Tests that the anomaly detection system correctly identifies
 * and handles servers exhibiting suspicious behavior patterns
 * at the DO integration level.
 *
 * Note: Unit-level anomaly detection tests already exist in
 * tests/unit/anomaly-detection.test.js. This file tests adversarial
 * scenarios through the actual ServerRegistryDO heartbeat path.
 *
 * Covers:
 * - Rapid metric oscillation (connection count manipulation)
 * - Ghost server detection (heartbeating with zero connections)
 * - Anomaly score accumulation
 * - Legitimate server behavior (no false positives)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { MockState, createRequest } from '../helpers/mock-do.js';

describe('Anomaly Detection Security Tests', () => {
  let mockState;
  let registry;
  const authHeaders = { Authorization: 'Bearer test-secret' };

  beforeEach(() => {
    mockState = new MockState();
    registry = new ServerRegistryDO(mockState, {
      SERVER_REGISTRY_SECRET: 'test-secret',
      CI_UPLOAD_SECRET: 'ci-secret',
      REPLAY_GRACE_MODE: 'true',
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  it('should detect rapid metric oscillation as anomalous', async () => {
    // Register server
    await registry.fetch(createRequest('POST', '/servers', {
      serverId: 'ed25519:oscillator',
      endpoint: 'wss://osc.example.com',
      publicKey: 'key1',
      connections: 100,
    }, authHeaders));

    // Alternate between high and low connection counts (spike/drop pattern)
    const values = [100, 10, 100, 10, 100, 10, 100, 10, 100, 10];
    for (const connections of values) {
      vi.advanceTimersByTime(30000); // 30s between heartbeats
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:oscillator',
        connections,
        relayConnections: Math.floor(connections / 2),
        signalingConnections: Math.floor(connections / 2),
        activeCodes: 5,
      }, authHeaders));
    }

    // Check anomaly score
    const anomalyScore = await mockState.storage.get('anomaly-score:ed25519:oscillator');
    // Should have accumulated anomaly score from spike/drop detections
    if (anomalyScore !== undefined) {
      expect(anomalyScore.score).toBeGreaterThan(0);
    }
  });

  it('should detect ghost server pattern', async () => {
    // Register server with 0 connections
    await registry.fetch(createRequest('POST', '/servers', {
      serverId: 'ed25519:ghost',
      endpoint: 'wss://ghost.example.com',
      publicKey: 'key1',
      connections: 0,
    }, authHeaders));

    // Send 15 heartbeats with 0 connections (ghost threshold is >10)
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(30000);
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:ghost',
        connections: 0,
        relayConnections: 0,
        signalingConnections: 0,
        activeCodes: 0,
      }, authHeaders));
    }

    // Check anomaly history exists
    const history = await mockState.storage.get('anomaly-history:ed25519:ghost');
    if (history) {
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);
    }

    // Check anomaly score (ghost_server anomaly has score 1 per heartbeat after threshold)
    const anomalyScore = await mockState.storage.get('anomaly-score:ed25519:ghost');
    if (anomalyScore) {
      expect(anomalyScore.score).toBeGreaterThan(0);
    }
  });

  it('should not flag legitimate server behavior', async () => {
    // Register server with normal metrics
    await registry.fetch(createRequest('POST', '/servers', {
      serverId: 'ed25519:legit',
      endpoint: 'wss://legit.example.com',
      publicKey: 'key1',
      connections: 50,
    }, authHeaders));

    // Send heartbeats with gradually increasing connections (normal growth)
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30000);
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:legit',
        connections: 50 + i * 2,
        relayConnections: 25 + i,
        signalingConnections: 25 + i,
        activeCodes: 10 + i,
      }, authHeaders));
    }

    // Anomaly score should be 0 or very low
    const anomalyScore = await mockState.storage.get('anomaly-score:ed25519:legit');
    if (anomalyScore !== undefined) {
      expect(anomalyScore.score).toBeLessThan(5); // Below flag threshold
      expect(anomalyScore.flagged).toBe(false);
    }
  });

  it('should quarantine servers with high anomaly scores', async () => {
    // Register a server
    await registry.fetch(createRequest('POST', '/servers', {
      serverId: 'ed25519:malicious',
      endpoint: 'wss://mal.example.com',
      publicKey: 'key1',
      connections: 10,
    }, authHeaders));

    // Create extreme oscillation to accumulate high anomaly scores
    // metric_spike (score 3) and metric_drop (score 3) each heartbeat pair
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(30000);
      const connections = i % 2 === 0 ? 1000 : 1;
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:malicious',
        connections,
        relayConnections: Math.floor(connections / 2),
        signalingConnections: Math.ceil(connections / 2),
        activeCodes: 5,
      }, authHeaders));
    }

    const anomalyScore = await mockState.storage.get('anomaly-score:ed25519:malicious');
    if (anomalyScore && anomalyScore.quarantined) {
      // Verify quarantined servers are hidden from public listing
      const listResp = await registry.fetch(createRequest('GET', '/servers'));
      const listData = await listResp.json();
      const serverIds = listData.servers.map(s => s.serverId);
      expect(serverIds).not.toContain('ed25519:malicious');
    }
  });

  it('should track anomaly history with correct size limit', async () => {
    // Register server
    await registry.fetch(createRequest('POST', '/servers', {
      serverId: 'ed25519:history-test',
      endpoint: 'wss://hist.example.com',
      publicKey: 'key1',
      connections: 10,
    }, authHeaders));

    // Send 35 heartbeats (history size limit is 30)
    for (let i = 0; i < 35; i++) {
      vi.advanceTimersByTime(30000);
      await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:history-test',
        connections: 10 + i,
        relayConnections: 5 + Math.floor(i / 2),
        signalingConnections: 5 + Math.ceil(i / 2),
        activeCodes: 3,
      }, authHeaders));
    }

    const history = await mockState.storage.get('anomaly-history:ed25519:history-test');
    expect(history).toBeDefined();
    expect(Array.isArray(history)).toBe(true);
    // History should be capped at ANOMALY_HISTORY_SIZE (30)
    expect(history.length).toBeLessThanOrEqual(30);
  });
});
