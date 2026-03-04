/**
 * Security tests for concurrent access patterns.
 *
 * Note on DO concurrency: Durable Objects serialize all requests internally
 * via blockConcurrencyWhile. In the mock environment, concurrent Promise.all()
 * calls execute sequentially. These tests verify that sequential execution
 * under concurrent submission produces consistent results and does not corrupt state.
 *
 * Covers:
 * - Concurrent heartbeats for same serverId (verify state consistency)
 * - Concurrent nonce creation for same device_id
 * - Concurrent key updates (POST /servers/trusted-keys)
 * - Alarm cleanup running during request processing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
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

describe('Race Condition Security Tests', () => {
  describe('Concurrent Heartbeats', () => {
    let mockState;
    let registry;

    beforeEach(() => {
      mockState = new MockState();
      registry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
        REPLAY_GRACE_MODE: 'true',
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should handle concurrent heartbeats for same server without state corruption', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Register a server first
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:concurrent-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'key1',
      }, authHeaders));

      // Fire multiple heartbeats concurrently at the same timestamp.
      // The server enforces a 30s minimum interval between heartbeats,
      // so only the first should succeed and subsequent ones get 429.
      const heartbeats = Array.from({ length: 3 }, (_, i) =>
        registry.fetch(createRequest('POST', '/servers/heartbeat', {
          serverId: 'ed25519:concurrent-server',
          connections: 10 + i,
          relayConnections: 5 + i,
          signalingConnections: 5,
          activeCodes: 2,
        }, authHeaders))
      );

      const results = await Promise.all(heartbeats);
      const statuses = results.map(r => r.status);

      // First heartbeat should succeed, rest should be rate-limited
      expect(statuses[0]).toBe(200);
      for (let i = 1; i < statuses.length; i++) {
        expect(statuses[i]).toBe(429);
      }

      // Server entry should exist and have consistent data from the accepted heartbeat
      const entry = await mockState.storage.get('server:ed25519:concurrent-server');
      expect(entry).toBeDefined();
      expect(typeof entry.connections).toBe('number');
      expect(Number.isFinite(entry.connections)).toBe(true);
    });

    it('should accept sequential heartbeats with sufficient interval', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Register a server first
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:sequential-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'key1',
      }, authHeaders));

      // First heartbeat
      const resp1 = await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:sequential-server',
        connections: 10,
        relayConnections: 5,
        signalingConnections: 5,
        activeCodes: 2,
      }, authHeaders));
      expect(resp1.status).toBe(200);

      // Advance time past the 30s minimum interval
      vi.advanceTimersByTime(31000);

      // Second heartbeat should succeed
      const resp2 = await registry.fetch(createRequest('POST', '/servers/heartbeat', {
        serverId: 'ed25519:sequential-server',
        connections: 20,
        relayConnections: 10,
        signalingConnections: 10,
        activeCodes: 4,
      }, authHeaders));
      expect(resp2.status).toBe(200);

      // Server entry should reflect the latest heartbeat data
      const entry = await mockState.storage.get('server:ed25519:sequential-server');
      expect(entry.connections).toBe(20);
    });

    it('should handle concurrent registrations for different servers', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      const registrations = Array.from({ length: 10 }, (_, i) =>
        registry.fetch(createRequest('POST', '/servers', {
          serverId: `ed25519:server-${i}`,
          endpoint: `wss://s${i}.example.com`,
          publicKey: `key${i}`,
        }, authHeaders))
      );

      const results = await Promise.all(registrations);

      for (const resp of results) {
        expect(resp.status).toBe(200);
      }

      // All 10 servers should be stored
      const servers = await mockState.storage.list({ prefix: 'server:' });
      expect(servers.size).toBe(10);
    });
  });

  describe('Concurrent Nonce Creation', () => {
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
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should issue unique nonces for concurrent challenge requests', async () => {
      const signingKey = await importAttestationSigningKey(seedHex);
      const tokenPayload = JSON.stringify({
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        timestamp: Date.now(),
      });
      const signature = await signPayloadEd25519(signingKey, tokenPayload);
      const buildToken = { payload: tokenPayload, signature };

      // Register device
      await attestationDO.fetch(createRequest('POST', '/attest/register', {
        build_token: buildToken,
        device_id: 'device-concurrent',
      }));

      // Upload reference so challenges can succeed
      await attestationDO.fetch(createRequest('POST', '/attest/upload-reference', {
        version: '1.0.0',
        platform: 'android',
        build_hash: 'abc123',
        size: 1024,
        critical_regions: [
          { offset: 0, length: 16, data_hex: 'deadbeefcafebabe0123456789abcdef' },
          { offset: 100, length: 16, data_hex: 'cafebabe0123456789abcdefdeadbeef' },
          { offset: 200, length: 16, data_hex: '0123456789abcdefdeadbeefcafebabe' },
        ],
      }, { Authorization: 'Bearer test-secret' }));

      // Request multiple challenges concurrently
      const challenges = Array.from({ length: 5 }, () =>
        attestationDO.fetch(createRequest('POST', '/attest/challenge', {
          device_id: 'device-concurrent',
          build_version: '1.0.0',
        }))
      );

      const results = await Promise.all(challenges);
      const nonces = [];

      for (const resp of results) {
        expect(resp.status).toBe(200);
        const data = await resp.json();
        expect(data.nonce).toBeDefined();
        nonces.push(data.nonce);
      }

      // All nonces should be unique
      const uniqueNonces = new Set(nonces);
      expect(uniqueNonces.size).toBe(nonces.length);
    });
  });

  describe('Concurrent Key Updates', () => {
    let mockState;
    let registry;

    beforeEach(() => {
      mockState = new MockState();
      registry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should handle concurrent trusted key updates without corruption', async () => {
      const authHeaders = { Authorization: 'Bearer ci-secret' };

      // Fire multiple key update requests concurrently
      const updates = Array.from({ length: 3 }, (_, i) =>
        registry.fetch(createRequest('POST', '/servers/trusted-keys', {
          keys: [`key-batch-${i}-a`, `key-batch-${i}-b`],
        }, authHeaders))
      );

      const results = await Promise.all(updates);

      for (const resp of results) {
        expect(resp.status).toBe(200);
      }

      // Storage should have a valid trusted_build_keys entry (last write wins)
      const stored = await mockState.storage.get('trusted_build_keys');
      expect(stored).toBeDefined();
      expect(stored.encrypted).toBe(true);
    });
  });

  describe('Alarm vs Request Races', () => {
    let mockState;
    let registry;

    beforeEach(() => {
      mockState = new MockState();
      registry = new ServerRegistryDO(mockState, {
        SERVER_REGISTRY_SECRET: 'test-secret',
        CI_UPLOAD_SECRET: 'ci-secret',
        REPLAY_GRACE_MODE: 'true',
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      mockState.storage.clear();
      vi.useRealTimers();
    });

    it('should handle alarm cleanup concurrent with server listing', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Register a server
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:alarm-race-server',
        endpoint: 'wss://alarm.example.com',
        publicKey: 'key1',
      }, authHeaders));

      // Advance time past TTL so alarm would clean it
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Fire alarm and list concurrently
      const [alarmResult, listResult] = await Promise.all([
        registry.alarm(),
        registry.fetch(createRequest('GET', '/servers')),
      ]);

      // Both should complete without throwing
      expect(listResult.status).toBe(200);
    });

    it('should handle alarm cleanup concurrent with registration', async () => {
      const authHeaders = { Authorization: 'Bearer test-secret' };

      // Register old server
      await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:old-server',
        endpoint: 'wss://old.example.com',
        publicKey: 'key1',
      }, authHeaders));

      // Advance time past TTL
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Fire alarm and new registration concurrently
      const [, regResult] = await Promise.all([
        registry.alarm(),
        registry.fetch(createRequest('POST', '/servers', {
          serverId: 'ed25519:new-server',
          endpoint: 'wss://new.example.com',
          publicKey: 'key2',
        }, authHeaders)),
      ]);

      expect(regResult.status).toBe(200);

      // New server should exist
      const newEntry = await mockState.storage.get('server:ed25519:new-server');
      expect(newEntry).toBeDefined();
    });
  });
});
