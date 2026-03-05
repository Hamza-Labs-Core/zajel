/**
 * Unit tests for KV counter logic (counters.ts).
 *
 * Verifies increment, get, and bulk heartbeat counter updates
 * with correct keys, values, and TTL.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  incrementCounter,
  getCounter,
  updateHeartbeatCounters,
} from '../../src/counters.js';

// ---------------------------------------------------------------------------
// Mock KV
// ---------------------------------------------------------------------------

interface StoreEntry {
  value: string;
  opts?: { expirationTtl?: number };
}

function createMockKV(): KVNamespace & { _store: Map<string, StoreEntry> } {
  const store = new Map<string, StoreEntry>();
  return {
    _store: store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      return entry?.value ?? null;
    },
    async put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, { value, opts });
    },
    async delete(_key: string): Promise<void> {
      store.delete(_key);
    },
    async list(): Promise<{ keys: { name: string }[] }> {
      return { keys: [] };
    },
    async getWithMetadata(): Promise<{ value: null; metadata: null }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace & { _store: Map<string, StoreEntry> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getCounter', () => {
  let kv: KVNamespace & { _store: Map<string, StoreEntry> };

  beforeEach(() => {
    kv = createMockKV();
  });

  it('returns 0 for a missing key', async () => {
    const value = await getCounter(kv, 'nonexistent');
    expect(value).toBe(0);
  });

  it('returns the stored integer value', async () => {
    kv._store.set('my_counter', { value: '42' });
    const value = await getCounter(kv, 'my_counter');
    expect(value).toBe(42);
  });

  it('returns 0 for non-numeric stored value', async () => {
    kv._store.set('bad_counter', { value: 'not-a-number' });
    const value = await getCounter(kv, 'bad_counter');
    expect(value).toBe(0);
  });

  it('returns 0 for empty string', async () => {
    kv._store.set('empty', { value: '' });
    const value = await getCounter(kv, 'empty');
    expect(value).toBe(0);
  });
});

describe('incrementCounter', () => {
  let kv: KVNamespace & { _store: Map<string, StoreEntry> };

  beforeEach(() => {
    kv = createMockKV();
  });

  it('increments a new counter from 0 to 1', async () => {
    await incrementCounter(kv, 'test_counter');
    expect(kv._store.get('test_counter')?.value).toBe('1');
  });

  it('increments an existing counter', async () => {
    kv._store.set('test_counter', { value: '5' });
    await incrementCounter(kv, 'test_counter');
    expect(kv._store.get('test_counter')?.value).toBe('6');
  });

  it('increments by a custom delta', async () => {
    kv._store.set('test_counter', { value: '10' });
    await incrementCounter(kv, 'test_counter', 3);
    expect(kv._store.get('test_counter')?.value).toBe('13');
  });

  it('writes with 15-minute TTL (900 seconds)', async () => {
    await incrementCounter(kv, 'test_counter');
    const entry = kv._store.get('test_counter');
    expect(entry).toBeDefined();
    expect(entry!.opts?.expirationTtl).toBe(900);
  });

  it('preserves TTL on subsequent increments', async () => {
    await incrementCounter(kv, 'test_counter');
    await incrementCounter(kv, 'test_counter');
    const entry = kv._store.get('test_counter');
    expect(entry!.opts?.expirationTtl).toBe(900);
    expect(entry!.value).toBe('2');
  });
});

describe('updateHeartbeatCounters', () => {
  let kv: KVNamespace & { _store: Map<string, StoreEntry> };

  beforeEach(() => {
    kv = createMockKV();
  });

  it('updates total, platform, and version counters', async () => {
    await updateHeartbeatCounters(kv, 'android', '1.2.3');

    expect(kv._store.get('active_clients:total')?.value).toBe('1');
    expect(kv._store.get('active_clients:platform:android')?.value).toBe('1');
    expect(kv._store.get('active_clients:version:1.2.3')?.value).toBe('1');
  });

  it('updates connection counter when connectionType is provided', async () => {
    await updateHeartbeatCounters(kv, 'ios', '2.0.0', 'relay');

    expect(kv._store.get('active_clients:total')?.value).toBe('1');
    expect(kv._store.get('active_clients:platform:ios')?.value).toBe('1');
    expect(kv._store.get('active_clients:version:2.0.0')?.value).toBe('1');
    expect(kv._store.get('active_clients:connection:relay')?.value).toBe('1');
  });

  it('does not write connection counter when connectionType is undefined', async () => {
    await updateHeartbeatCounters(kv, 'web', '1.0.0', undefined);

    expect(kv._store.has('active_clients:total')).toBe(true);
    expect(kv._store.has('active_clients:platform:web')).toBe(true);
    expect(kv._store.has('active_clients:version:1.0.0')).toBe(true);

    const connectionKeys = [...kv._store.keys()].filter((k) =>
      k.startsWith('active_clients:connection:'),
    );
    expect(connectionKeys).toHaveLength(0);
  });

  it('accumulates counts across multiple calls', async () => {
    await updateHeartbeatCounters(kv, 'android', '1.0.0', 'direct_p2p');
    await updateHeartbeatCounters(kv, 'android', '1.0.0', 'relay');
    await updateHeartbeatCounters(kv, 'ios', '1.0.0', 'direct_p2p');

    expect(kv._store.get('active_clients:total')?.value).toBe('3');
    expect(kv._store.get('active_clients:platform:android')?.value).toBe('2');
    expect(kv._store.get('active_clients:platform:ios')?.value).toBe('1');
    expect(kv._store.get('active_clients:version:1.0.0')?.value).toBe('3');
    expect(
      kv._store.get('active_clients:connection:direct_p2p')?.value,
    ).toBe('2');
    expect(kv._store.get('active_clients:connection:relay')?.value).toBe('1');
  });

  it('all counters have 15-minute TTL', async () => {
    await updateHeartbeatCounters(kv, 'linux', '3.0.0', 'none');

    for (const [, entry] of kv._store) {
      expect(entry.opts?.expirationTtl).toBe(900);
    }
  });
});
