/**
 * Mock Bootstrap Server
 *
 * Simulates the CF Workers bootstrap API for testing VPS server federation.
 * Provides endpoints for server registration, heartbeat, and discovery.
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { EventEmitter } from 'events';

export interface BootstrapServerEntry {
  serverId: string;
  endpoint: string;
  publicKey: string;
  region: string;
  registeredAt: number;
  lastSeen: number;
}

export interface MockBootstrapOptions {
  /** Port to listen on (0 for dynamic allocation) */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** TTL for server entries in milliseconds (default: 5 minutes) */
  serverTtl?: number;
  /** Enable automatic cleanup of stale servers */
  autoCleanup?: boolean;
  /** Cleanup interval in milliseconds */
  cleanupInterval?: number;
}

export interface MockBootstrapStats {
  totalRegistrations: number;
  totalHeartbeats: number;
  totalUnregistrations: number;
  currentServers: number;
}

/**
 * MockBootstrapServer - In-memory mock of CF Workers bootstrap API
 */
export class MockBootstrapServer extends EventEmitter {
  private httpServer: HttpServer | null = null;
  private servers: Map<string, BootstrapServerEntry> = new Map();
  private _port = 0;
  private _host: string;
  private _options: MockBootstrapOptions;
  private _isRunning = false;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private stats: MockBootstrapStats = {
    totalRegistrations: 0,
    totalHeartbeats: 0,
    totalUnregistrations: 0,
    currentServers: 0,
  };

  constructor(options: MockBootstrapOptions = {}) {
    super();
    this._options = {
      port: 0,
      host: '127.0.0.1',
      serverTtl: 5 * 60 * 1000, // 5 minutes
      autoCleanup: false,
      cleanupInterval: 30000,
      ...options,
    };
    this._host = this._options.host!;
  }

  /**
   * Start the mock bootstrap server
   */
  async start(): Promise<void> {
    if (this._isRunning) {
      throw new Error('Mock bootstrap server is already running');
    }

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on('error', reject);
      this.httpServer!.listen(this._options.port, this._host, () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        this._isRunning = true;
        resolve();
      });
    });

    // Start cleanup timer if enabled
    if (this._options.autoCleanup) {
      this.cleanupTimer = setInterval(() => {
        this.cleanupStaleServers();
      }, this._options.cleanupInterval);
    }

    this.emit('started', { port: this._port });
  }

  /**
   * Stop the mock bootstrap server
   */
  async stop(): Promise<void> {
    if (!this._isRunning || !this.httpServer) {
      return;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    await new Promise<void>((resolve) => {
      this.httpServer!.close(() => {
        this._isRunning = false;
        resolve();
      });
    });

    this.emit('stopped');
  }

  /**
   * Get the URL for this bootstrap server
   */
  getUrl(): string {
    return `http://${this._host}:${this._port}`;
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
   * Get all registered servers
   */
  getServers(): BootstrapServerEntry[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get a specific server by ID
   */
  getServer(serverId: string): BootstrapServerEntry | undefined {
    return this.servers.get(serverId);
  }

  /**
   * Get server count
   */
  get serverCount(): number {
    return this.servers.size;
  }

  /**
   * Get statistics
   */
  getStats(): MockBootstrapStats {
    return {
      ...this.stats,
      currentServers: this.servers.size,
    };
  }

  /**
   * Clear all registered servers
   */
  clear(): void {
    this.servers.clear();
    this.emit('cleared');
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRegistrations: 0,
      totalHeartbeats: 0,
      totalUnregistrations: 0,
      currentServers: 0,
    };
  }

  /**
   * Manually register a server (for test setup)
   */
  registerServer(entry: BootstrapServerEntry): void {
    this.servers.set(entry.serverId, entry);
    this.stats.totalRegistrations++;
    this.emit('server-registered', entry);
  }

  /**
   * Remove stale servers (last seen > TTL)
   */
  private cleanupStaleServers(): void {
    const now = Date.now();
    const ttl = this._options.serverTtl!;
    let removed = 0;

    for (const [serverId, entry] of this.servers.entries()) {
      if (now - entry.lastSeen > ttl) {
        this.servers.delete(serverId);
        removed++;
        this.emit('server-expired', entry);
      }
    }

    if (removed > 0) {
      this.emit('cleanup', { removed });
    }
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${this._host}:${this._port}`);
    const method = req.method?.toUpperCase();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route handling
    if (method === 'GET' && url.pathname === '/health') {
      this.handleHealth(res);
    } else if (method === 'POST' && url.pathname === '/servers') {
      this.handleRegister(req, res);
    } else if (method === 'GET' && url.pathname === '/servers') {
      this.handleGetServers(res);
    } else if (method === 'POST' && url.pathname === '/servers/heartbeat') {
      this.handleHeartbeat(req, res);
    } else if (method === 'DELETE' && url.pathname.startsWith('/servers/')) {
      const serverId = decodeURIComponent(url.pathname.slice('/servers/'.length));
      this.handleUnregister(serverId, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  }

  /**
   * Handle health check endpoint
   */
  private handleHealth(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'zajel-bootstrap-mock',
      timestamp: Date.now(),
      serverCount: this.servers.size,
    }));
  }

  /**
   * Handle server registration
   */
  private handleRegister(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as {
          serverId: string;
          endpoint: string;
          publicKey: string;
          region?: string;
        };

        if (!data.serverId || !data.endpoint || !data.publicKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields' }));
          return;
        }

        const entry: BootstrapServerEntry = {
          serverId: data.serverId,
          endpoint: data.endpoint,
          publicKey: data.publicKey,
          region: data.region || 'unknown',
          registeredAt: Date.now(),
          lastSeen: Date.now(),
        };

        this.servers.set(data.serverId, entry);
        this.stats.totalRegistrations++;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, server: entry }));

        this.emit('server-registered', entry);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
  }

  /**
   * Handle get servers list
   */
  private handleGetServers(res: ServerResponse): void {
    const servers = Array.from(this.servers.values());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers }));
  }

  /**
   * Handle heartbeat
   */
  private handleHeartbeat(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as { serverId: string };

        if (!data.serverId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing serverId' }));
          return;
        }

        const server = this.servers.get(data.serverId);

        if (!server) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Server not found' }));
          return;
        }

        // Update last seen
        server.lastSeen = Date.now();
        this.servers.set(data.serverId, server);
        this.stats.totalHeartbeats++;

        // Return other servers as peers
        const peers = Array.from(this.servers.values())
          .filter(s => s.serverId !== data.serverId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, peers }));

        this.emit('heartbeat', { serverId: data.serverId, peersReturned: peers.length });
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
  }

  /**
   * Handle server unregistration
   */
  private handleUnregister(serverId: string, res: ServerResponse): void {
    const existed = this.servers.has(serverId);
    const entry = this.servers.get(serverId);
    this.servers.delete(serverId);

    if (existed) {
      this.stats.totalUnregistrations++;
      this.emit('server-unregistered', entry);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: existed }));
  }
}

/**
 * Create and start a mock bootstrap server
 */
export async function createMockBootstrap(options: MockBootstrapOptions = {}): Promise<MockBootstrapServer> {
  const server = new MockBootstrapServer(options);
  await server.start();
  return server;
}
