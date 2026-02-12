/**
 * Test Server Harness
 *
 * Utility for starting/stopping real VPS server instances during integration tests.
 * Supports dynamic port allocation, multiple server instances, and log capture.
 */

import { createZajelServer, type ZajelServer } from '../../src/index.js';
import type { ServerConfig } from '../../src/types.js';
import { EventEmitter } from 'events';

export interface TestServerHarnessOptions {
  /** Base port for dynamic allocation. Each server gets basePort + index */
  basePort?: number;
  /** Region for the server (used in server_info) */
  region?: string;
  /** Bootstrap server URL (should point to mock bootstrap) */
  bootstrapUrl?: string;
  /** Direct bootstrap nodes (peer endpoints) */
  bootstrapNodes?: string[];
  /** Custom configuration overrides */
  configOverrides?: Partial<ServerConfig>;
  /** Whether to capture server logs */
  captureLogs?: boolean;
  /** Shutdown timeout in milliseconds */
  shutdownTimeout?: number;
}

export interface ServerLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  data?: unknown;
}

// Port allocator to avoid conflicts — wide range to reduce collision with parallel CI jobs
let nextPort = 30000 + Math.floor(Math.random() * 20000);
const allocatedPorts = new Set<number>();

function allocatePort(): number {
  let port = nextPort++;
  // Ensure we don't reuse ports within a test run
  while (allocatedPorts.has(port)) {
    port = nextPort++;
  }
  allocatedPorts.add(port);
  return port;
}

function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

/**
 * TestServerHarness - Manages a real VPS server instance for testing
 */
export class TestServerHarness extends EventEmitter {
  private server: ZajelServer | null = null;
  private _port: number;
  private _logs: ServerLog[] = [];
  private _options: TestServerHarnessOptions;
  private _isRunning = false;
  private _startTime = 0;
  private _keyPath: string;

  constructor(options: TestServerHarnessOptions = {}) {
    super();
    this._options = {
      basePort: undefined,
      region: 'test-region',
      bootstrapUrl: 'http://localhost:59999', // Invalid by default, should be overridden
      bootstrapNodes: [],
      configOverrides: {},
      captureLogs: true,
      shutdownTimeout: 10000,
      ...options,
    };
    this._port = options.basePort ?? allocatePort();
    this._keyPath = `/tmp/zajel-test-${this._port}-${Date.now()}.key`;
  }

  /**
   * Start the server instance, retrying on EADDRINUSE with a new port.
   */
  async start(): Promise<void> {
    if (this._isRunning) {
      throw new Error('Server is already running');
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const config = this.buildConfig();
      try {
        this._startTime = Date.now();
        this.server = await createZajelServer(config);
        this._isRunning = true;

        this.log('info', `Server started on port ${this._port}`);
        this.emit('started', { port: this._port, serverId: this.server.identity.serverId });
        return;
      } catch (error: any) {
        if (error?.code === 'EADDRINUSE' && attempt < maxRetries) {
          this.log('warn', `Port ${this._port} in use, retrying with new port`);
          releasePort(this._port);
          this._port = allocatePort();
          continue;
        }
        this.log('error', `Failed to start server: ${error}`);
        throw error;
      }
    }
  }

  /**
   * Stop the server instance with timeout
   */
  async stop(): Promise<void> {
    if (!this._isRunning || !this.server) {
      return;
    }

    const timeout = this._options.shutdownTimeout ?? 10000;

    try {
      const shutdownPromise = this.server.shutdown();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Shutdown timeout')), timeout);
      });

      await Promise.race([shutdownPromise, timeoutPromise]);

      this.log('info', `Server stopped after ${Date.now() - this._startTime}ms`);
    } catch (error) {
      this.log('warn', `Shutdown error: ${error}`);
    } finally {
      this._isRunning = false;
      this.server = null;
      releasePort(this._port);
      this.emit('stopped', { port: this._port });
    }
  }

  /**
   * Get the HTTP URL for this server
   */
  getUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  /**
   * Get the WebSocket URL for this server
   */
  getWsUrl(): string {
    return `ws://127.0.0.1:${this._port}`;
  }

  /**
   * Get the port number
   */
  get port(): number {
    return this._port;
  }

  /**
   * Check if server is running
   */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get the server identity (serverId, nodeId, etc.)
   */
  get identity() {
    if (!this.server) {
      throw new Error('Server not started');
    }
    return this.server.identity;
  }

  /**
   * Get the underlying ZajelServer instance
   */
  get serverInstance(): ZajelServer {
    if (!this.server) {
      throw new Error('Server not started');
    }
    return this.server;
  }

  /**
   * Get captured logs
   */
  get logs(): ServerLog[] {
    return [...this._logs];
  }

  /**
   * Clear captured logs
   */
  clearLogs(): void {
    this._logs = [];
  }

  /**
   * Wait for the server to be healthy (responds to /health endpoint)
   */
  async waitForHealthy(timeout = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(`${this.getUrl()}/health`);
        if (response.ok) {
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  /**
   * Build the server configuration
   */
  private buildConfig(): Partial<ServerConfig> {
    const baseConfig: Partial<ServerConfig> = {
      network: {
        host: '127.0.0.1',
        port: this._port,
        publicEndpoint: `ws://127.0.0.1:${this._port}`,
        region: this._options.region,
      },
      bootstrap: {
        serverUrl: this._options.bootstrapUrl!,
        heartbeatInterval: 2000, // Faster for testing
        nodes: this._options.bootstrapNodes || [],
        retryInterval: 500,
        maxRetries: 3,
      },
      storage: {
        type: 'sqlite',
        path: ':memory:', // In-memory database for tests
      },
      identity: {
        keyPath: this._keyPath,
        ephemeralIdPrefix: 'test',
      },
      gossip: {
        interval: 1000,
        suspicionTimeout: 2000,
        failureTimeout: 4000,
        indirectPingCount: 2,
        stateExchangeInterval: 3000,
      },
      client: {
        maxConnectionsPerPeer: 20,
        heartbeatInterval: 30000,
        heartbeatTimeout: 60000,
        pairRequestTimeout: 120000,
        pairRequestWarningTime: 30000,
      },
      cleanup: {
        interval: 60000,
        dailyPointTtl: 48 * 60 * 60 * 1000,
        hourlyTokenTtl: 3 * 60 * 60 * 1000,
      },
    };

    // Merge custom overrides
    return this.deepMerge(baseConfig, this._options.configOverrides || {});
  }

  /**
   * Log a message and optionally capture it
   */
  private log(level: ServerLog['level'], message: string, data?: unknown): void {
    const log: ServerLog = {
      timestamp: Date.now(),
      level,
      message,
      data,
    };

    if (this._options.captureLogs) {
      this._logs.push(log);
    }

    this.emit('log', log);
  }

  /**
   * Deep merge two objects
   */
  private deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
    const result = { ...target };
    for (const key of Object.keys(source) as (keyof T)[]) {
      const sourceValue = source[key];
      if (sourceValue !== undefined) {
        if (
          typeof sourceValue === 'object' &&
          sourceValue !== null &&
          !Array.isArray(sourceValue) &&
          typeof result[key] === 'object' &&
          result[key] !== null
        ) {
          result[key] = this.deepMerge(
            result[key] as Record<string, unknown>,
            sourceValue as Record<string, unknown>
          ) as T[keyof T];
        } else {
          result[key] = sourceValue as T[keyof T];
        }
      }
    }
    return result;
  }
}

/**
 * Create multiple server harnesses for federation testing
 */
export async function createServerCluster(
  count: number,
  options: Omit<TestServerHarnessOptions, 'basePort'> = {}
): Promise<TestServerHarness[]> {
  const servers: TestServerHarness[] = [];

  for (let i = 0; i < count; i++) {
    const region = options.region ? `${options.region}-${i + 1}` : `region-${i + 1}`;
    const harness = new TestServerHarness({
      ...options,
      region,
    });
    servers.push(harness);
  }

  return servers;
}

/**
 * Start all servers in a cluster
 */
export async function startCluster(servers: TestServerHarness[]): Promise<void> {
  await Promise.all(servers.map((s) => s.start()));
}

/**
 * Stop all servers in a cluster
 */
export async function stopCluster(servers: TestServerHarness[]): Promise<void> {
  await Promise.all(servers.map((s) => s.stop()));
}
