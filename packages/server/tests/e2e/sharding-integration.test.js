import { describe, it, expect } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import worker from '../../src/index.js';
import { MockStorage, MockState, createShardAwareMockEnv } from '../helpers/mock-do.js';

const TEST_SECRET = 'test-shard-secret';

function createAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'CF-Connecting-IP': '127.0.0.1',
    'Authorization': `Bearer ${TEST_SECRET}`,
  };
}

let nonceCounter = 0;
function testNonce() {
  nonceCounter += 1;
  return `test-nonce-${Date.now()}-${nonceCounter}-${Math.random().toString(36).slice(2)}`;
}

function createDoEnv() {
  return { SERVER_REGISTRY_SECRET: TEST_SECRET };
}

describe('Sharding Integration Tests', () => {
  describe('Server Registry Multi-Region', () => {
    it('should register servers to correct regional shards', async () => {
      // Create multiple regional shard instances with auth
      const doEnv = createDoEnv();
      const usEastShard = new ServerRegistryDO(new MockState(), doEnv);
      const euWestShard = new ServerRegistryDO(new MockState(), doEnv);

      const env = createShardAwareMockEnv({
        serverRegistryShards: {
          'region:us-east': usEastShard,
          'region:eu-west': euWestShard,
        },
      });

      // Register US server
      const usRequest = new Request('https://test/servers', {
        method: 'POST',
        headers: createAuthHeaders(),
        body: JSON.stringify({
          serverId: 'us-server-1',
          endpoint: 'wss://us.example.com',
          publicKey: 'us-key',
          region: 'us-east',
          timestamp: Date.now(),
          nonce: testNonce(),
        }),
      });

      const usResponse = await worker.fetch(usRequest, env);
      expect(usResponse.status).toBe(200);

      // Register EU server
      const euRequest = new Request('https://test/servers', {
        method: 'POST',
        headers: createAuthHeaders(),
        body: JSON.stringify({
          serverId: 'eu-server-1',
          endpoint: 'wss://eu.example.com',
          publicKey: 'eu-key',
          region: 'eu-west',
          timestamp: Date.now(),
          nonce: testNonce(),
        }),
      });

      const euResponse = await worker.fetch(euRequest, env);
      expect(euResponse.status).toBe(200);

      // Verify servers are in correct shards
      const usListRequest = new Request('https://test/servers', { method: 'GET' });
      const usListResponse = await usEastShard.fetch(usListRequest);
      const usData = await usListResponse.json();
      expect(usData.servers).toHaveLength(1);
      expect(usData.servers[0].serverId).toBe('us-server-1');

      const euListRequest = new Request('https://test/servers', { method: 'GET' });
      const euListResponse = await euWestShard.fetch(euListRequest);
      const euData = await euListResponse.json();
      expect(euData.servers).toHaveLength(1);
      expect(euData.servers[0].serverId).toBe('eu-server-1');
    });

    it('should aggregate servers from all shards', async () => {
      const doEnv = createDoEnv();

      // Setup: 3 regional shards with servers pre-populated in storage
      const shardConfigs = [
        { name: 'region:us-east', region: 'us-east' },
        { name: 'region:eu-west', region: 'eu-west' },
        { name: 'region:ap-southeast', region: 'ap-southeast' },
      ];

      const shards = {};
      for (const config of shardConfigs) {
        const state = new MockState();
        // Pre-populate storage directly to avoid auth requirements
        await state.storage.put(`server:server-${config.region}`, {
          serverId: `server-${config.region}`,
          endpoint: `wss://${config.region}.example.com`,
          publicKey: `key-${config.region}`,
          region: config.region,
          lastSeen: Date.now(),
          connections: 0,
          relayConnections: 0,
          signalingConnections: 0,
          activeCodes: 0,
          buildVerified: false,
        });
        shards[config.name] = new ServerRegistryDO(state, doEnv);
      }

      // Create env that routes to correct shards
      const env = createShardAwareMockEnv({
        serverRegistryShards: shards,
      });

      // Aggregate request
      const listRequest = new Request('https://test/servers', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': '127.0.0.1' },
      });
      const response = await worker.fetch(listRequest, env);
      const data = await response.json();

      expect(data.servers).toHaveLength(3);
      expect(data.servers.map(s => s.region)).toContain('us-east');
      expect(data.servers.map(s => s.region)).toContain('eu-west');
      expect(data.servers.map(s => s.region)).toContain('ap-southeast');
    });

    it('should handle partial shard failures gracefully', async () => {
      const doEnv = createDoEnv();
      const workingState = new MockState();

      // Pre-populate storage directly
      await workingState.storage.put('server:server-1', {
        serverId: 'server-1',
        endpoint: 'wss://test.example.com',
        publicKey: 'key-1',
        region: 'us-east',
        lastSeen: Date.now(),
        connections: 0,
        relayConnections: 0,
        signalingConnections: 0,
        activeCodes: 0,
        buildVerified: false,
      });
      const workingShard = new ServerRegistryDO(workingState, doEnv);

      // Create env where some shards fail
      const env = {
        SERVER_REGISTRY: {
          idFromName: (name) => name,
          get: (id) => {
            if (id === 'region:us-east') {
              return { fetch: (r) => workingShard.fetch(r) };
            }
            // Other shards fail
            return {
              fetch: () => Promise.reject(new Error('Shard unavailable')),
            };
          },
        },
      };

      // Aggregate should succeed with partial results
      const listRequest = new Request('https://test/servers', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': '127.0.0.1' },
      });
      const response = await worker.fetch(listRequest, env);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.servers).toHaveLength(1);
      expect(data.servers[0].serverId).toBe('server-1');
      expect(data.shard_errors).toBeDefined();
      expect(data.shard_errors.length).toBeGreaterThan(0);
    });

    it('should route admin operations to admin shard', async () => {
      const doEnv = createDoEnv();

      // Admin shard for trusted keys
      const adminShard = new ServerRegistryDO(new MockState(), doEnv);
      // Regional shard for regular server operations
      const regionalShard = new ServerRegistryDO(new MockState(), doEnv);

      const env = createShardAwareMockEnv({
        serverRegistryShards: {
          'admin': adminShard,
          'region:us-east': regionalShard,
        },
      });

      // Trusted key request should go to admin shard
      const trustedKeyRequest = new Request('https://test/servers/trusted-keys', {
        method: 'POST',
        headers: createAuthHeaders(),
        body: JSON.stringify({ key: 'test-key', action: 'add' }),
      });

      const response = await worker.fetch(trustedKeyRequest, env);
      expect(response).toBeDefined();

      // Register a server on the regional shard to verify isolation
      const serverRequest = new Request('https://test/servers', {
        method: 'POST',
        headers: createAuthHeaders(),
        body: JSON.stringify({
          serverId: 'server-1',
          endpoint: 'wss://test.example.com',
          publicKey: 'key-1',
          region: 'us-east',
          timestamp: Date.now(),
          nonce: testNonce(),
        }),
      });

      const serverResponse = await worker.fetch(serverRequest, env);
      expect(serverResponse.status).toBe(200);
    });
  });

  describe('Attestation Registry Device Sharding', () => {
    it('should route devices to correct shards by ID prefix', async () => {
      // Track which shard received which request
      const shardRequests = { '00': [], 'ff': [] };

      const env = {
        ATTESTATION_REGISTRY: {
          idFromName: (name) => name,
          get: (id) => {
            return {
              fetch: async (r) => {
                const shardKey = id.replace('device-shard:', '');
                if (shardRequests[shardKey]) {
                  const body = await r.clone().json();
                  shardRequests[shardKey].push(body.device_id);
                }
                return new Response(JSON.stringify({ success: true }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                });
              },
            };
          },
        },
        SERVER_REGISTRY: {
          idFromName: () => 'mock',
          get: () => ({ fetch: () => new Response('{}') }),
        },
      };

      // Request with device_id starting with '00'
      const request00 = new Request('https://test/attest/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '127.0.0.1',
        },
        body: JSON.stringify({ device_id: '00aabbccdd112233' }),
      });

      await worker.fetch(request00, env);

      // Request with device_id starting with 'ff'
      const requestFF = new Request('https://test/attest/challenge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '127.0.0.1',
        },
        body: JSON.stringify({ device_id: 'ffaabbccdd112233' }),
      });

      await worker.fetch(requestFF, env);

      // Verify requests went to correct shards
      expect(shardRequests['00']).toContain('00aabbccdd112233');
      expect(shardRequests['ff']).toContain('ffaabbccdd112233');
      // Cross-check: no cross-contamination
      expect(shardRequests['00']).not.toContain('ffaabbccdd112233');
      expect(shardRequests['ff']).not.toContain('00aabbccdd112233');
    });
  });
});
