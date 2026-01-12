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
import type { Browser, BrowserContext } from 'playwright';
import { chromium } from 'playwright';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';

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
let portCounter = 15000 + Math.floor(Math.random() * 5000);
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

  constructor(config: OrchestratorConfig = {}) {
    this.config = {
      headless: config.headless ?? true,
      vpsPort: config.vpsPort ?? 0,
      webClientPort: config.webClientPort ?? 0,
      startupTimeout: config.startupTimeout ?? 30000,
      verbose: config.verbose ?? false,
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
        heartbeatInterval: 5000,
        nodes: [],
        retryInterval: 1000,
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
        interval: 2000,
        suspicionTimeout: 4000,
        failureTimeout: 8000,
        indirectPingCount: 2,
        stateExchangeInterval: 5000,
      },
      client: {
        maxConnectionsPerPeer: 20,
        heartbeatInterval: 30000,
        heartbeatTimeout: 60000,
        pairRequestTimeout: 120000,
        pairRequestWarningTime: 30000,
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
    this.webClientPort = this.config.webClientPort || getNextPort();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Web client startup timeout'));
      }, this.config.startupTimeout);

      this.log(`Starting web-client dev server on port ${this.webClientPort}...`);

      this.webClientProcess = spawn('npm', ['run', 'dev', '--', '--port', String(this.webClientPort)], {
        cwd: '/home/meywd/zajel/packages/web-client',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: '0',
        },
      });

      let startupOutput = '';

      this.webClientProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        startupOutput += output;
        if (this.config.verbose) {
          process.stdout.write(output);
        }

        // Vite outputs "Local: http://localhost:PORT/" when ready
        if (output.includes('Local:') || output.includes('ready in')) {
          clearTimeout(timeout);
          this.log(`Web client dev server ready on port ${this.webClientPort}`);
          // Give Vite a moment to fully initialize
          setTimeout(() => resolve(this.webClientPort), 500);
        }
      });

      this.webClientProcess.stderr?.on('data', (data) => {
        if (this.config.verbose) {
          process.stderr.write(data.toString());
        }
      });

      this.webClientProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.webClientProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Web client process exited with code ${code}\nOutput: ${startupOutput}`));
        }
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
   * Create a WebSocket client connection to the VPS server
   */
  async createWsClient(timeout: number = 10000): Promise<{ ws: WebSocket; serverInfo: unknown }> {
    if (!this.vpsServer) {
      throw new Error('VPS server not started. Call startVpsServer() first.');
    }

    const port = this.vpsServer.config.network.port;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);

      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, timeout);

      ws.on('open', () => {
        const messageHandler = (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'server_info') {
              clearTimeout(timer);
              ws.off('message', messageHandler);
              resolve({ ws, serverInfo: message });
            }
          } catch {
            // Ignore parse errors
          }
        };
        ws.on('message', messageHandler);
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Wait for a specific message type on a WebSocket
   */
  async waitForMessage(ws: WebSocket, messageType: string, timeout: number = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for message type: ${messageType}`));
      }, timeout);

      const handler = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === messageType) {
            clearTimeout(timer);
            ws.off('message', handler);
            resolve(message);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.on('message', handler);
    });
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
   * Clean up all test infrastructure
   */
  async cleanup(): Promise<void> {
    this.log('Cleaning up test infrastructure...');

    // Close all browsers
    for (const browser of this.browsers) {
      try {
        await browser.close();
      } catch (err) {
        console.error('Error closing browser:', err);
      }
    }
    this.browsers = [];

    // Stop web client dev server
    if (this.webClientProcess) {
      this.webClientProcess.kill('SIGTERM');
      this.webClientProcess = null;
      this.webClientPort = 0;
    }

    // Shutdown VPS server
    if (this.vpsServer) {
      try {
        await this.vpsServer.shutdown();
      } catch (err) {
        console.error('Error shutting down VPS server:', err);
      }
      this.vpsServer = null;
    }

    // Stop mock bootstrap server
    if (this.mockBootstrapServer) {
      await new Promise<void>((resolve) => {
        this.mockBootstrapServer!.close(() => resolve());
      });
      this.mockBootstrapServer = null;
      this.mockBootstrapStore.servers.clear();
    }

    this.log('Cleanup complete');
  }
}

/**
 * Helper: Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 10000,
  pollInterval: number = 100
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  throw new Error('Timeout waiting for condition');
}

/**
 * Helper: Create a promise that resolves after a delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
