/**
 * Shared mock infrastructure for Durable Object tests.
 *
 * Provides reusable mocks for:
 * - Durable Object Storage
 * - Durable Object State
 * - Durable Object Stub
 * - Request creation utilities
 * - Shard-aware mock environments for sharding tests
 */

/**
 * Mock implementation of Durable Object Storage API.
 */
export class MockStorage {
  constructor() {
    this.data = new Map();
    this._alarm = null;
  }

  async get(key) {
    if (Array.isArray(key)) {
      const result = new Map();
      for (const k of key) {
        if (this.data.has(k)) {
          result.set(k, this.data.get(k));
        }
      }
      return result;
    }
    return this.data.get(key) ?? null;
  }

  async put(key, value) {
    if (key instanceof Map) {
      for (const [k, v] of key) {
        this.data.set(k, v);
      }
    } else if (typeof key === 'object' && !Array.isArray(key)) {
      for (const [k, v] of Object.entries(key)) {
        this.data.set(k, v);
      }
    } else {
      this.data.set(key, value);
    }
  }

  async delete(keyOrKeys) {
    if (Array.isArray(keyOrKeys)) {
      let count = 0;
      for (const k of keyOrKeys) {
        if (this.data.delete(k)) count++;
      }
      return count;
    }
    return this.data.delete(keyOrKeys);
  }

  async list(options = {}) {
    const { prefix, limit, start, end, reverse } = options;
    let entries = [...this.data.entries()];

    if (prefix) {
      entries = entries.filter(([key]) => key.startsWith(prefix));
    }
    if (start) {
      entries = entries.filter(([key]) => key >= start);
    }
    if (end) {
      entries = entries.filter(([key]) => key < end);
    }

    entries.sort(([a], [b]) => reverse ? b.localeCompare(a) : a.localeCompare(b));

    if (limit) {
      entries = entries.slice(0, limit);
    }

    return new Map(entries);
  }

  async getAlarm() {
    return this._alarm;
  }

  async setAlarm(time) {
    this._alarm = time;
  }

  async deleteAlarm() {
    this._alarm = null;
  }

  clear() {
    this.data.clear();
    this._alarm = null;
  }
}

/**
 * Mock implementation of Durable Object State.
 */
export class MockState {
  constructor() {
    this.storage = new MockStorage();
    this.id = { toString: () => 'mock-do-id' };
  }

  /**
   * blockConcurrencyWhile - Executes the callback immediately (no concurrency
   * control in tests). This ensures migration helpers like migrateFromGlobalIfNeeded()
   * actually execute during construction.
   */
  async blockConcurrencyWhile(callback) {
    await callback();
  }
}

/**
 * Mock implementation of Durable Object Stub.
 */
export class MockDurableObjectStub {
  constructor(doInstance) {
    this.doInstance = doInstance;
  }

  async fetch(request) {
    return this.doInstance.fetch(request);
  }
}

/**
 * Create a mock environment object with default values.
 */
export function createMockEnv(overrides = {}) {
  return {
    SERVER_REGISTRY_SECRET: 'test-secret',
    CI_UPLOAD_SECRET: 'test-ci-secret',
    ATTESTATION_SIGNING_KEY: null,
    TRUSTED_BUILD_KEYS: '',
    DEV_MODE: 'false',
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

/**
 * createShardAwareMockEnv - Creates a mock Cloudflare Worker environment with
 * DO namespace bindings that route to provided shard instances.
 *
 * @param {object} options - Configuration for mock environment
 * @param {object} options.serverRegistryShards - Map of shard name to DO instance
 * @param {object} options.attestationRegistryShards - Map of shard name to DO instance
 * @returns {object} Mock environment
 */
export function createShardAwareMockEnv(options = {}) {
  const serverShards = options.serverRegistryShards || {};
  const attestationShards = options.attestationRegistryShards || {};

  return {
    SERVER_REGISTRY: {
      idFromName: (name) => name,
      get: (id) => {
        const shard = serverShards[id];
        if (shard) {
          return { fetch: (r) => shard.fetch(r) };
        }
        // Return a stub that responds with empty servers for unknown shards
        return {
          fetch: () => Promise.resolve(
            new Response(JSON.stringify({ servers: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          ),
        };
      },
    },
    ATTESTATION_REGISTRY: {
      idFromName: (name) => name,
      get: (id) => {
        const shard = attestationShards[id];
        if (shard) {
          return { fetch: (r) => shard.fetch(r) };
        }
        return {
          fetch: () => Promise.resolve(
            new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          ),
        };
      },
    },
  };
}

/**
 * Create a Request object for testing.
 */
export function createRequest(method, path, body = null, headers = {}) {
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
