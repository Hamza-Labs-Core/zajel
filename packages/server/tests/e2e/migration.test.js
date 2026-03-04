import { describe, it, expect } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';
import { MockState } from '../helpers/mock-do.js';

describe('Migration from Global to Sharded', () => {
  it('should detect legacy global shard on first access', async () => {
    // Simulate existing global shard with data
    const globalState = new MockState();

    // Pre-populate storage with a server entry to simulate legacy data
    await globalState.storage.put('server:legacy-server-1', {
      serverId: 'legacy-server-1',
      endpoint: 'wss://legacy.example.com',
      publicKey: 'legacy-key',
      region: 'us-east',
      lastSeen: Date.now(),
    });

    // Construct the DO - this triggers blockConcurrencyWhile which calls
    // migrateFromGlobalIfNeeded(). Since storage already has server: entries,
    // it should detect this as a legacy global shard.
    const globalDO = new ServerRegistryDO(globalState, {});

    // Wait for blockConcurrencyWhile to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify legacy marker is set after migration check
    const legacyMarker = await globalState.storage.get('_legacy_global_shard');
    expect(legacyMarker).toBe(true);
  });

  it('should not set legacy marker on empty shard', async () => {
    // New shard with no data should not be marked as legacy
    const emptyState = new MockState();
    const emptyDO = new ServerRegistryDO(emptyState, {});

    await new Promise(resolve => setTimeout(resolve, 10));

    const legacyMarker = await emptyState.storage.get('_legacy_global_shard');
    expect(legacyMarker).toBeNull();
  });

  it('should not re-run migration if already migrated', async () => {
    const state = new MockState();

    // Pre-populate with data and migration marker
    await state.storage.put('server:existing-server', {
      serverId: 'existing-server',
      endpoint: 'wss://existing.example.com',
      publicKey: 'existing-key',
      lastSeen: Date.now(),
    });
    await state.storage.put('_migrated_to_shards', true);

    // Construct the DO
    const dO = new ServerRegistryDO(state, {});
    await new Promise(resolve => setTimeout(resolve, 10));

    // Legacy marker should NOT be set because _migrated_to_shards was already present
    const legacyMarker = await state.storage.get('_legacy_global_shard');
    expect(legacyMarker).toBeNull();
  });

  it('should serve data from default shard after migration', async () => {
    // After migration, data should be accessible via region:default
    const defaultState = new MockState();

    // Pre-populate storage with server data (simulating a registration)
    await defaultState.storage.put('server:new-server-1', {
      serverId: 'new-server-1',
      endpoint: 'wss://new.example.com',
      publicKey: 'new-key',
      region: 'default',
      lastSeen: Date.now(),
      connections: 0,
      relayConnections: 0,
      signalingConnections: 0,
      activeCodes: 0,
      buildVerified: false,
    });

    const defaultDO = new ServerRegistryDO(defaultState, {});

    // List should return server from default shard
    const listRequest = new Request('https://test/servers', { method: 'GET' });
    const response = await defaultDO.fetch(listRequest);
    const data = await response.json();

    expect(data.servers).toHaveLength(1);
    expect(data.servers[0].serverId).toBe('new-server-1');
  });
});
