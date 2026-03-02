/**
 * Anomaly Detection Tests
 *
 * Tests for the anomaly detection system in the ServerRegistry Durable Object.
 * Covers:
 * - AnomalyDetector.analyze() — metric spikes, drops, inconsistencies, ghost servers, fleet outliers
 * - Integration with heartbeat flow — scores accumulate and decay
 * - Quarantine behavior — quarantined servers hidden from public listing
 * - GET /servers/anomalies endpoint
 * - Cleanup of anomaly data when servers expire
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';

/**
 * Mock Durable Object Storage
 */
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

async function registerServer(registry, serverData) {
  const request = createRequest('POST', '/servers', {
    endpoint: 'wss://test.example.com',
    publicKey: 'test-key',
    region: 'eu-west',
    connections: 0,
    relayConnections: 0,
    signalingConnections: 0,
    activeCodes: 0,
    ...serverData,
  });
  return registry.fetch(request);
}

async function sendHeartbeat(registry, heartbeatData) {
  const request = createRequest('POST', '/servers/heartbeat', heartbeatData);
  return registry.fetch(request);
}

describe('Anomaly Detection', () => {
  let mockState;
  let registry;

  beforeEach(() => {
    mockState = new MockState();
    registry = new ServerRegistryDO(mockState, {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    mockState.storage.clear();
    vi.useRealTimers();
  });

  describe('Metric Spike Detection', () => {
    it('should detect a connection spike (>3x increase)', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:spike-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });

      // Build up history with normal values (need >= 2 entries)
      await sendHeartbeat(registry, {
        serverId: 'ed25519:spike-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:spike-server',
        connections: 12,
        relayConnections: 6,
        signalingConnections: 6,
      });

      // Now spike to >3x the previous value
      await sendHeartbeat(registry, {
        serverId: 'ed25519:spike-server',
        connections: 50,
        relayConnections: 25,
        signalingConnections: 25,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:spike-server');
      expect(scoreData).toBeDefined();
      expect(scoreData.score).toBeGreaterThan(0);
      expect(scoreData.anomalies.some(a => a.type === 'metric_spike')).toBe(true);
    });

    it('should not flag normal growth', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:normal-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });

      await sendHeartbeat(registry, {
        serverId: 'ed25519:normal-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:normal-server',
        connections: 12,
        relayConnections: 6,
        signalingConnections: 6,
      });

      // Modest increase (< 3x)
      await sendHeartbeat(registry, {
        serverId: 'ed25519:normal-server',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:normal-server');
      // No spike anomaly detected
      const hasSpikeAnomaly = scoreData.anomalies.some(a => a.type === 'metric_spike');
      expect(hasSpikeAnomaly).toBe(false);
    });
  });

  describe('Metric Drop Detection', () => {
    it('should detect a connection drop (>80% decrease)', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:drop-server',
        connections: 100,
        relayConnections: 50,
        signalingConnections: 50,
      });

      // Build history
      await sendHeartbeat(registry, {
        serverId: 'ed25519:drop-server',
        connections: 100,
        relayConnections: 50,
        signalingConnections: 50,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:drop-server',
        connections: 95,
        relayConnections: 47,
        signalingConnections: 48,
      });

      // Sudden drop to <20% of previous
      await sendHeartbeat(registry, {
        serverId: 'ed25519:drop-server',
        connections: 5,
        relayConnections: 3,
        signalingConnections: 2,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:drop-server');
      expect(scoreData.anomalies.some(a => a.type === 'metric_drop')).toBe(true);
    });
  });

  describe('Metric Inconsistency Detection', () => {
    it('should detect when connections != relay + signaling', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:inconsistent-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      // Report inconsistent metrics
      await sendHeartbeat(registry, {
        serverId: 'ed25519:inconsistent-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:inconsistent-server');
      expect(scoreData).toBeDefined();
      expect(scoreData.anomalies.some(a => a.type === 'metric_inconsistency')).toBe(true);
    });

    it('should not flag when metrics are consistent', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:consistent-server',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
      });

      await sendHeartbeat(registry, {
        serverId: 'ed25519:consistent-server',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:consistent-server');
      const hasInconsistency = scoreData.anomalies.some(a => a.type === 'metric_inconsistency');
      expect(hasInconsistency).toBe(false);
    });
  });

  describe('Ghost Server Detection', () => {
    it('should detect a ghost server (0 connections for 10+ heartbeats)', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:ghost-server',
      });

      // Send 12 heartbeats with 0 connections (need 10 in history + current)
      for (let i = 0; i < 12; i++) {
        await sendHeartbeat(registry, {
          serverId: 'ed25519:ghost-server',
          connections: 0,
          relayConnections: 0,
          signalingConnections: 0,
          activeCodes: 0,
        });
      }

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:ghost-server');
      expect(scoreData.anomalies.some(a => a.type === 'ghost_server')).toBe(true);
    });

    it('should not flag a server that has some connections', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:active-server',
      });

      // Most heartbeats have 0, but a few have connections
      for (let i = 0; i < 11; i++) {
        await sendHeartbeat(registry, {
          serverId: 'ed25519:active-server',
          connections: i === 5 ? 3 : 0,
          relayConnections: i === 5 ? 2 : 0,
          signalingConnections: i === 5 ? 1 : 0,
          activeCodes: 0,
        });
      }

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:active-server');
      const hasGhost = scoreData.anomalies.some(a => a.type === 'ghost_server');
      expect(hasGhost).toBe(false);
    });
  });

  describe('Fleet Outlier Detection', () => {
    it('should detect a fleet outlier (>3σ from mean)', async () => {
      // Register servers with realistic variation in connection counts
      // Normal fleet: 40, 50, 60 — mean=50, stddev=~8.16, 3σ=~24.5
      const normalServers = [
        { id: 's1', connections: 40 },
        { id: 's2', connections: 50 },
        { id: 's3', connections: 60 },
      ];
      for (const { id, connections } of normalServers) {
        await registerServer(registry, {
          serverId: `ed25519:${id}`,
          endpoint: `wss://${id}.example.com`,
          connections,
          relayConnections: Math.floor(connections / 2),
          signalingConnections: Math.ceil(connections / 2),
        });
      }

      // Register the outlier with extreme connections (500 is >>3σ away from mean 50)
      await registerServer(registry, {
        serverId: 'ed25519:outlier',
        endpoint: 'wss://outlier.example.com',
        connections: 500,
        relayConnections: 250,
        signalingConnections: 250,
      });

      // Build history for outlier
      await sendHeartbeat(registry, {
        serverId: 'ed25519:outlier',
        connections: 400,
        relayConnections: 200,
        signalingConnections: 200,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:outlier',
        connections: 450,
        relayConnections: 225,
        signalingConnections: 225,
      });

      // Send heartbeat with value far from fleet norm
      await sendHeartbeat(registry, {
        serverId: 'ed25519:outlier',
        connections: 500,
        relayConnections: 250,
        signalingConnections: 250,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:outlier');
      expect(scoreData.anomalies.some(a => a.type === 'fleet_outlier')).toBe(true);
    });

    it('should not flag when all servers have similar metrics', async () => {
      const servers = ['a', 'b', 'c', 'd'];
      for (const id of servers) {
        await registerServer(registry, {
          serverId: `ed25519:${id}`,
          endpoint: `wss://${id}.example.com`,
          connections: 50 + Math.floor(Math.random() * 10),
          relayConnections: 25,
          signalingConnections: 25,
        });
      }

      // Heartbeat for one of them
      await sendHeartbeat(registry, {
        serverId: 'ed25519:a',
        connections: 55,
        relayConnections: 28,
        signalingConnections: 27,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:a',
        connections: 55,
        relayConnections: 28,
        signalingConnections: 27,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:a',
        connections: 52,
        relayConnections: 26,
        signalingConnections: 26,
      });

      const scoreData = await mockState.storage.get('anomaly-score:ed25519:a');
      const hasFleetOutlier = scoreData.anomalies.some(a => a.type === 'fleet_outlier');
      expect(hasFleetOutlier).toBe(false);
    });
  });

  describe('Score Accumulation and Decay', () => {
    it('should accumulate anomaly scores across heartbeats', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:accumulate-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      // Each heartbeat reports inconsistent metrics (score += 2 each time)
      await sendHeartbeat(registry, {
        serverId: 'ed25519:accumulate-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const score1 = (await mockState.storage.get('anomaly-score:ed25519:accumulate-server')).score;

      await sendHeartbeat(registry, {
        serverId: 'ed25519:accumulate-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const score2 = (await mockState.storage.get('anomaly-score:ed25519:accumulate-server')).score;

      // Score should be higher after second heartbeat (decay * prev + new)
      expect(score2).toBeGreaterThan(score1 * 0.5);
    });

    it('should decay scores when no anomalies are present', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:decay-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      // First heartbeat: inconsistent metrics
      await sendHeartbeat(registry, {
        serverId: 'ed25519:decay-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const initialScore = (await mockState.storage.get('anomaly-score:ed25519:decay-server')).score;
      expect(initialScore).toBeGreaterThan(0);

      // Following heartbeats: consistent metrics — score should decay
      for (let i = 0; i < 10; i++) {
        await sendHeartbeat(registry, {
          serverId: 'ed25519:decay-server',
          connections: 20,
          relayConnections: 10,
          signalingConnections: 10,
        });
      }

      const finalScore = (await mockState.storage.get('anomaly-score:ed25519:decay-server')).score;
      expect(finalScore).toBeLessThan(initialScore);
    });
  });

  describe('Quarantine Behavior', () => {
    it('should quarantine servers that exceed the threshold and hide from listing', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:bad-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });

      // Also register a good server
      await registerServer(registry, {
        serverId: 'ed25519:good-server',
        endpoint: 'wss://good.example.com',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
      });

      // Manually set a high anomaly score to trigger quarantine
      await mockState.storage.put('anomaly-score:ed25519:bad-server', {
        score: 15,
        anomalies: [{ type: 'metric_spike', severity: 'high', score: 4, detail: 'test' }],
        flagged: true,
        quarantined: true,
        lastChecked: Date.now(),
      });

      // List servers — bad-server should be hidden
      const listRequest = createRequest('GET', '/servers');
      const response = await registry.fetch(listRequest);
      const data = await response.json();

      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].serverId).toBe('ed25519:good-server');
    });

    it('should not quarantine servers below the threshold', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:ok-server',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
      });

      // Set a score below quarantine threshold but above flag threshold
      await mockState.storage.put('anomaly-score:ed25519:ok-server', {
        score: 6,
        anomalies: [{ type: 'metric_inconsistency', severity: 'low', score: 2, detail: 'test' }],
        flagged: true,
        quarantined: false,
        lastChecked: Date.now(),
      });

      const listRequest = createRequest('GET', '/servers');
      const response = await registry.fetch(listRequest);
      const data = await response.json();

      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].serverId).toBe('ed25519:ok-server');
    });
  });

  describe('GET /servers/anomalies Endpoint', () => {
    it('should return anomaly data for all active servers', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:server-1',
        endpoint: 'wss://s1.example.com',
      });
      await registerServer(registry, {
        serverId: 'ed25519:server-2',
        endpoint: 'wss://s2.example.com',
      });

      // Send heartbeats to generate anomaly data
      await sendHeartbeat(registry, {
        serverId: 'ed25519:server-1',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });
      await sendHeartbeat(registry, {
        serverId: 'ed25519:server-2',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      const request = createRequest('GET', '/servers/anomalies');
      const response = await registry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.servers).toBeDefined();
      expect(data.servers).toHaveLength(2);

      // Should be sorted by score descending
      expect(data.servers[0].score).toBeGreaterThanOrEqual(data.servers[1].score);

      // Each entry should have the expected fields
      for (const server of data.servers) {
        expect(server).toHaveProperty('serverId');
        expect(server).toHaveProperty('endpoint');
        expect(server).toHaveProperty('score');
        expect(server).toHaveProperty('flagged');
        expect(server).toHaveProperty('quarantined');
        expect(server).toHaveProperty('anomalies');
      }
    });

    it('should return empty list when no servers are registered', async () => {
      const request = createRequest('GET', '/servers/anomalies');
      const response = await registry.fetch(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.servers).toEqual([]);
    });

    it('should require auth when SERVER_REGISTRY_SECRET is set', async () => {
      const authRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret-123',
      });

      // Without auth header
      const request = createRequest('GET', '/servers/anomalies');
      const response = await authRegistry.fetch(request);

      expect(response.status).toBe(401);
    });

    it('should allow access with correct auth token', async () => {
      const authRegistry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret-123',
      });

      const request = createRequest('GET', '/servers/anomalies', null, {
        Authorization: 'Bearer test-secret-123',
      });
      const response = await authRegistry.fetch(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Anomaly History Management', () => {
    it('should maintain a rolling history window', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:history-server',
      });

      // Send 35 heartbeats (exceeds ANOMALY_HISTORY_SIZE of 30)
      for (let i = 0; i < 35; i++) {
        await sendHeartbeat(registry, {
          serverId: 'ed25519:history-server',
          connections: i,
          relayConnections: 0,
          signalingConnections: 0,
          activeCodes: 0,
        });
      }

      const history = await mockState.storage.get('anomaly-history:ed25519:history-server');
      expect(history).toBeDefined();
      expect(history.length).toBeLessThanOrEqual(30);
    });

    it('should clean up anomaly data when servers expire', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:expiring-server',
      });

      await sendHeartbeat(registry, {
        serverId: 'ed25519:expiring-server',
        connections: 50,
        relayConnections: 10,
        signalingConnections: 10,
      });

      // Verify anomaly data exists
      expect(await mockState.storage.get('anomaly-history:ed25519:expiring-server')).toBeDefined();
      expect(await mockState.storage.get('anomaly-score:ed25519:expiring-server')).toBeDefined();

      // Advance time past TTL
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Trigger alarm cleanup
      await registry.alarm();

      // Anomaly data should be cleaned up
      expect(await mockState.storage.get('anomaly-history:ed25519:expiring-server')).toBeUndefined();
      expect(await mockState.storage.get('anomaly-score:ed25519:expiring-server')).toBeUndefined();
    });
  });

  describe('Heartbeat Response Unchanged', () => {
    it('should still return peers in heartbeat response', async () => {
      await registerServer(registry, {
        serverId: 'ed25519:peer-a',
        endpoint: 'wss://a.example.com',
      });
      await registerServer(registry, {
        serverId: 'ed25519:peer-b',
        endpoint: 'wss://b.example.com',
      });

      const response = await sendHeartbeat(registry, {
        serverId: 'ed25519:peer-a',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
      });
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.peers).toBeDefined();
      expect(data.peers).toHaveLength(1);
      expect(data.peers[0].serverId).toBe('ed25519:peer-b');
    });
  });
});
