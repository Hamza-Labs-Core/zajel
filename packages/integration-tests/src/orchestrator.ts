/**
 * Test Orchestrator
 *
 * Coordinates cross-app integration tests between VPS server, web-client,
 * and (potentially) Flutter app. Manages test infrastructure lifecycle,
 * timing, and synchronization between components.
 */

import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import http, { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import {
  TIMEOUTS,
  NETWORK,
  PROTOCOL,
  POLL_INTERVALS,
  delay as delayFn,
  safeCleanup,
  cleanupAll,
} from './test-constants.js';

// Get the directory of this file for relative path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../..');

// Dynamic import for server-vps to handle build timing
let createZajelServer: (config?: Partial<ServerConfig>) => Promise<ZajelServer>;

// Local type definitions to avoid complex cross-package imports
export interface ServerConfig {
  identity: {
    keyPath: string;
    ephemeralIdPrefix: string;
  };
  network: {
    host: string;
    port: number;
    publicEndpoint: string;
    region?: string;
  };
  bootstrap: {
    serverUrl: string;
    heartbeatInterval: number;
    nodes: string[];
    retryInterval: number;
    maxRetries: number;
  };
  gossip: {
    interval: number;
    suspicionTimeout: number;
    failureTimeout: number;
    indirectPingCount: number;
    stateExchangeInterval: number;
  };
  dht?: {
    replicationFactor: number;
    writeQuorum: number;
    readQuorum: number;
    virtualNodes: number;
  };
  storage: {
    type: 'sqlite';
    path: string;
  };
  client: {
    maxConnectionsPerPeer: number;
    heartbeatInterval: number;
    heartbeatTimeout: number;
    pairRequestTimeout: number;
    pairRequestWarningTime: number;
  };
  cleanup?: {
    interval: number;
    dailyPointTtl: number;
    hourlyTokenTtl: number;
  };
}

export interface ZajelServer {
  httpServer: unknown;
  wss: unknown;
  federation: unknown;
  bootstrap: unknown;
  clientHandler: unknown;
  config: ServerConfig;
  identity: {
    serverId: string;
    nodeId: string;
    ephemeralId: string;
    publicKey: Uint8Array;
    privateKey: Uint8Array;
  };
  shutdown: () => Promise<void>;
}

export interface BootstrapServerEntry {
  serverId: string;
  endpoint: string;
  publicKey: string;
  region: string;
  registeredAt: number;
  lastSeen: number;
}

// Port allocation for tests - use random base to avoid conflicts
let portCounter = NETWORK.BASE_PORT + Math.floor(Math.random() * NETWORK.PORT_RANGE);
export const getNextPort = () => portCounter++;

/**
 * Configuration for the TestOrchestrator
 */
export interface OrchestratorConfig {
  /** Whether to run browser in headless mode (default: true) */
  headless?: boolean;
  /** VPS server port (auto-assigned if not provided) */
  vpsPort?: number;
  /** Web client dev server port (auto-assigned if not provided) */
  webClientPort?: number;
  /** Timeout for startup operations in ms (default: 30000) */
  startupTimeout?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Mock CF Workers bootstrap server for testing
 */
interface MockBootstrapStore {
  servers: Map<string, BootstrapServerEntry>;
}

/**
 * Web client instance with browser context
 */
export interface WebClientInstance {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  port: number;
}

/**
 * TestOrchestrator coordinates test infrastructure for cross-app integration tests
 */
export class TestOrchestrator {
  private config: Required<OrchestratorConfig>;
  private vpsServer: ZajelServer | null = null;
  private webClientProcess: ChildProcess | null = null;
  private webClientPort: number = 0;
  private browsers: Browser[] = [];
  private mockBootstrapServer: HttpServer | null = null;
  private mockBootstrapStore: MockBootstrapStore = { servers: new Map() };
  private mockBootstrapPort: number = 0;
  private tempEnvFile: string | null = null;

  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      headless: config.headless ?? true,
      vpsPort: config.vpsPort ?? 0,
      webClientPort: config.webClientPort ?? 0,
      startupTimeout: config.startupTimeout ?? TIMEOUTS.STARTUP,
      verbose: config.verbose ?? (process.env.LOG_LEVEL !== 'error'),
    };
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[Orchestrator] ${message}`);
    }
  }

  /**
   * Start mock CF Workers bootstrap server for server discovery
   */
  async startMockBootstrap(): Promise<string> {
    this.mockBootstrapPort = getNextPort();
    this.mockBootstrapStore = { servers: new Map() };

    this.mockBootstrapServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://localhost:${this.mockBootstrapPort}`);

      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'zajel-bootstrap-mock' }));
        return;
      }

      // Server registration
      if (req.method === 'POST' && url.pathname === '/servers') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const entry: BootstrapServerEntry = {
              serverId: data.serverId,
              endpoint: data.endpoint,
              publicKey: data.publicKey,
              region: data.region,
              registeredAt: Date.now(),
              lastSeen: Date.now(),
            };
            this.mockBootstrapStore.servers.set(data.serverId, entry);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, server: entry }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
          }
        });
        return;
      }

      // Server list
      if (req.method === 'GET' && url.pathname === '/servers') {
        const servers = Array.from(this.mockBootstrapStore.servers.values());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ servers }));
        return;
      }

      // Heartbeat
      if (req.method === 'POST' && url.pathname === '/servers/heartbeat') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const server = this.mockBootstrapStore.servers.get(data.serverId);
            if (!server) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Server not found' }));
              return;
            }
            server.lastSeen = Date.now();
            const peers = Array.from(this.mockBootstrapStore.servers.values())
              .filter(s => s.serverId !== data.serverId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, peers }));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request body' }));
          }
        });
        return;
      }

      // Unregister
      if (req.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
        const serverId = decodeURIComponent(url.pathname.slice('/servers/'.length));
        this.mockBootstrapStore.servers.delete(serverId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    await new Promise<void>((resolve) => {
      this.mockBootstrapServer!.listen(this.mockBootstrapPort, '127.0.0.1', () => {
        this.log(`Mock bootstrap server started on port ${this.mockBootstrapPort}`);
        resolve();
      });
    });

    return `http://127.0.0.1:${this.mockBootstrapPort}`;
  }

  /**
   * Start the VPS server using the server-vps package directly
   */
  async startVpsServer(configOverrides?: Partial<ServerConfig>): Promise<ZajelServer> {
    // Dynamic import to handle the case where server-vps may not be built yet
    if (!createZajelServer) {
      const serverVps = await import('@zajel/server-vps');
      createZajelServer = serverVps.createZajelServer;
    }

    const port = this.config.vpsPort || getNextPort();
    const bootstrapUrl = this.mockBootstrapServer
      ? `http://127.0.0.1:${this.mockBootstrapPort}`
      : 'http://127.0.0.1:59999'; // Invalid URL if no mock

    const testConfig: Partial<ServerConfig> = {
      network: {
        host: '127.0.0.1',
        port,
        publicEndpoint: `ws://127.0.0.1:${port}`,
        region: 'test-region',
      },
      bootstrap: {
        serverUrl: bootstrapUrl,
        heartbeatInterval: PROTOCOL.BOOTSTRAP_HEARTBEAT,
        nodes: [],
        retryInterval: PROTOCOL.RETRY_INTERVAL,
        maxRetries: 3,
      },
      storage: {
        type: 'sqlite',
        path: ':memory:',
      },
      identity: {
        keyPath: `/tmp/zajel-integration-test-${port}-${Date.now()}.key`,
        ephemeralIdPrefix: 'test',
      },
      gossip: {
        interval: PROTOCOL.GOSSIP_INTERVAL,
        suspicionTimeout: PROTOCOL.GOSSIP_INTERVAL * 2,
        failureTimeout: PROTOCOL.GOSSIP_INTERVAL * 4,
        indirectPingCount: 2,
        stateExchangeInterval: PROTOCOL.STATE_EXCHANGE_INTERVAL,
      },
      client: {
        maxConnectionsPerPeer: 20,
        heartbeatInterval: PROTOCOL.HEARTBEAT_INTERVAL,
        heartbeatTimeout: PROTOCOL.HEARTBEAT_TIMEOUT,
        pairRequestTimeout: PROTOCOL.PAIR_REQUEST_TIMEOUT,
        pairRequestWarningTime: PROTOCOL.PAIR_REQUEST_WARNING,
      },
      ...configOverrides,
    };

    this.log(`Starting VPS server on port ${port}...`);
    this.vpsServer = await createZajelServer(testConfig);
    this.log(`VPS server started: ${this.vpsServer.identity.serverId}`);

    return this.vpsServer;
  }

  /**
   * Start the web-client Vite dev server
   */
  async startWebClient(): Promise<number> {
    if (!this.vpsServer) {
      throw new Error('VPS server not started. Call startVpsServer() first.');
    }

    this.webClientPort = this.config.webClientPort || getNextPort();

    // Get the VPS server's WebSocket URL for the web client to connect to
    const vpsEndpoint = this.vpsServer.config.network.publicEndpoint;
    this.log(`Starting web-client dev server on port ${this.webClientPort}...`);
    this.log(`Web client will connect to VPS at: ${vpsEndpoint}`);

    // Use shell: true to find npm via PATH, and resolve cwd dynamically
    const webClientDir = resolve(PROJECT_ROOT, 'packages/web-client');

    // Write a temporary .env.local file for Vite to pick up
    // Vite loads env vars from .env.local in the project root (highest priority)
    this.tempEnvFile = resolve(webClientDir, '.env.local');
    const envContent = `VITE_SIGNALING_URL=${vpsEndpoint}\n`;
    this.log(`Writing temp .env.local file: ${this.tempEnvFile}`);
    writeFileSync(this.tempEnvFile, envContent);

    this.webClientProcess = spawn('npm', ['run', 'dev', '--', '--port', String(this.webClientPort)], {
      cwd: webClientDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true, // Required for CI environments where npm isn't directly in PATH
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        // Also pass as env var in case Vite picks it up from process.env
        VITE_SIGNALING_URL: vpsEndpoint,
      },
    });

    let startupOutput = '';
    let processExited = false;
    let exitCode: number | null = null;

    this.webClientProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      startupOutput += output;
      if (this.config.verbose) {
        process.stdout.write(`[Vite stdout] ${output}`);
      }
    });

    this.webClientProcess.stderr?.on('data', (data) => {
      const output = data.toString();
      startupOutput += output;
      if (this.config.verbose) {
        process.stderr.write(`[Vite stderr] ${output}`);
      }
    });

    this.webClientProcess.on('error', (err) => {
      this.log(`Web client process error: ${err.message}`);
      processExited = true;
    });

    this.webClientProcess.on('exit', (code) => {
      processExited = true;
      exitCode = code;
      if (code !== 0 && code !== null) {
        this.log(`Web client process exited with code ${code}`);
      }
    });

    // Use polling to check when the server is ready
    const startTime = Date.now();
    const timeout = this.config.startupTimeout;

    while (Date.now() - startTime < timeout) {
      if (processExited && exitCode !== 0) {
        throw new Error(`Web client process exited with code ${exitCode}\nOutput: ${startupOutput}`);
      }

      // Try to connect to the server to see if it's ready
      const isReady = await this.checkPortReady(this.webClientPort);
      if (isReady) {
        this.log(`Web client dev server ready on port ${this.webClientPort}`);
        // Give Vite a moment to fully initialize
        await delayFn(POLL_INTERVALS.HEALTH_CHECK);
        return this.webClientPort;
      }

      await delayFn(POLL_INTERVALS.SLOW);
    }

    throw new Error(`Web client startup timeout after ${timeout}ms\nOutput: ${startupOutput}`);
  }

  /**
   * Check if a port is ready by attempting an HTTP connection
   */
  private async checkPortReady(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        // Any response means the server is up
        res.resume(); // Consume response to free up resources
        resolve(true);
      });
      req.on('error', () => {
        resolve(false);
      });
      req.setTimeout(POLL_INTERVALS.SLOW * 2, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Launch a Playwright browser instance connected to the web client
   */
  async connectWebBrowser(): Promise<WebClientInstance> {
    if (!this.webClientPort) {
      throw new Error('Web client not started. Call startWebClient() first.');
    }

    this.log('Launching Playwright browser...');

    const browser = await chromium.launch({
      headless: this.config.headless,
    });

    this.browsers.push(browser);

    const context = await browser.newContext({
      // Allow insecure localhost connections
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    // Navigate to web client
    await page.goto(`http://localhost:${this.webClientPort}`, {
      waitUntil: 'networkidle',
      timeout: this.config.startupTimeout,
    });

    this.log('Browser connected to web client');

    return {
      browser,
      context,
      page,
      port: this.webClientPort,
    };
  }

  /**
   * Create an additional browser instance (for multi-peer tests)
   */
  async createAdditionalBrowser(): Promise<WebClientInstance> {
    if (!this.webClientPort) {
      throw new Error('Web client not started. Call startWebClient() first.');
    }

    const browser = await chromium.launch({
      headless: this.config.headless,
    });

    this.browsers.push(browser);

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    await page.goto(`http://localhost:${this.webClientPort}`, {
      waitUntil: 'networkidle',
      timeout: this.config.startupTimeout,
    });

    return {
      browser,
      context,
      page,
      port: this.webClientPort,
    };
  }

  /**
   * Create a WebSocket client connection to the VPS server.
   * Returns an extended WebSocket with message buffering to prevent race conditions.
   */
  async createWsClient(timeout: number = NETWORK.WS_CONNECT_TIMEOUT): Promise<{ ws: WebSocket & { messageBuffer: unknown[] }; serverInfo: unknown }> {
    if (!this.vpsServer) {
      throw new Error('VPS server not started. Call startVpsServer() first.');
    }

    const port = this.vpsServer.config.network.port;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`) as WebSocket & { messageBuffer: unknown[] };

      // Initialize message buffer - ALL messages go here, consumed by waitForMessage
      ws.messageBuffer = [];
      let serverInfoReceived = false;
      let resolved = false;

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, timeout);

      // Single message handler that buffers everything
      const bufferHandler = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          ws.messageBuffer.push(message);

          // Debug logging
          if (this.config.verbose) {
            console.log(`[WS] Received message type: ${message.type}, buffer size: ${ws.messageBuffer.length}`);
          }

          // Check for server_info to resolve the connection promise
          if (message.type === 'server_info' && !serverInfoReceived) {
            serverInfoReceived = true;
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              resolve({ ws, serverInfo: message });
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.on('message', bufferHandler);

      ws.on('error', (err) => {
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  /**
   * Wait for a specific message type on a WebSocket.
   * Uses polling approach on the message buffer to avoid race conditions.
   */
  async waitForMessage(ws: WebSocket & { messageBuffer?: unknown[] }, messageType: string, timeout: number = NETWORK.WS_MESSAGE_TIMEOUT): Promise<unknown> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check the message buffer for the target message type
      if (ws.messageBuffer) {
        const bufferIndex = ws.messageBuffer.findIndex(
          (msg: unknown) => (msg as { type?: string }).type === messageType
        );
        if (bufferIndex !== -1) {
          // Remove from buffer and return
          const message = ws.messageBuffer.splice(bufferIndex, 1)[0];
          return message;
        }
      }

      // Wait a bit before checking again
      await delayFn(POLL_INTERVALS.FAST);
    }

    throw new Error(`Timeout waiting for message type: ${messageType}`);
  }

  /**
   * Get the VPS server instance
   */
  getVpsServer(): ZajelServer | null {
    return this.vpsServer;
  }

  /**
   * Get the web client port
   */
  getWebClientPort(): number {
    return this.webClientPort;
  }

  /**
   * Get the VPS server WebSocket URL
   */
  getVpsWsUrl(): string {
    if (!this.vpsServer) {
      throw new Error('VPS server not started');
    }
    return `ws://127.0.0.1:${this.vpsServer.config.network.port}`;
  }

  /**
   * Clean up all test infrastructure.
   * Uses safe cleanup to ensure all resources are cleaned even if some fail.
   */
  async cleanup(): Promise<void> {
    this.log('Cleaning up test infrastructure...');

    // Collect all cleanup operations
    const cleanups: Array<{ name: string; fn: () => Promise<void> }> = [];

    // Close all browsers
    for (let i = 0; i < this.browsers.length; i++) {
      const browser = this.browsers[i];
      cleanups.push({
        name: `browser-${i}`,
        fn: async () => { await browser.close(); }
      });
    }

    // Stop web client dev server
    if (this.webClientProcess) {
      const proc = this.webClientProcess;
      cleanups.push({
        name: 'web-client-process',
        fn: async () => {
          proc.kill('SIGTERM');
        }
      });
    }

    // Remove temporary .env file
    if (this.tempEnvFile && existsSync(this.tempEnvFile)) {
      const envFile = this.tempEnvFile;
      cleanups.push({
        name: 'temp-env-file',
        fn: async () => {
          unlinkSync(envFile);
          this.log(`Removed temp .env file: ${envFile}`);
        }
      });
    }

    // Shutdown VPS server
    if (this.vpsServer) {
      const server = this.vpsServer;
      cleanups.push({
        name: 'vps-server',
        fn: async () => { await server.shutdown(); }
      });
    }

    // Stop mock bootstrap server
    if (this.mockBootstrapServer) {
      const mockServer = this.mockBootstrapServer;
      cleanups.push({
        name: 'mock-bootstrap-server',
        fn: async () => {
          await new Promise<void>((resolve) => {
            mockServer.close(() => resolve());
          });
        }
      });
    }

    // Run all cleanups, collecting errors
    await cleanupAll(cleanups);

    // Reset state
    this.browsers = [];
    this.webClientProcess = null;
    this.webClientPort = 0;
    this.tempEnvFile = null;
    this.vpsServer = null;
    this.mockBootstrapServer = null;
    this.mockBootstrapStore.servers.clear();

    this.log('Cleanup complete');
  }
}

/**
 * Helper: Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = TIMEOUTS.MEDIUM,
  pollInterval: number = POLL_INTERVALS.STANDARD
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // Condition threw, continue waiting
    }
    await delayFn(pollInterval);
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Helper: Create a promise that resolves after a delay
 */
export function delay(ms: number): Promise<void> {
  return delayFn(ms);
}

// Re-export constants for use in test files
export {
  TIMEOUTS,
  NETWORK,
  PROTOCOL,
  POLL_INTERVALS,
  LIMITS,
  isCI,
  ciTimeout,
  safeCleanup,
  cleanupAll,
  createMessageWaiter,
} from './test-constants.js';
