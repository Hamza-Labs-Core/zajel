/**
 * Zajel VPS Server
 *
 * Federated signaling server for the Zajel P2P messaging network.
 * Implements SWIM gossip protocol, consistent hashing, and distributed
 * rendezvous for peer discovery.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { loadConfig, type ServerConfig } from './config.js';
import { WEBSOCKET, CONNECTION_LIMITS } from './constants.js';
import { loadOrGenerateIdentity, type ServerIdentity } from './identity/server-identity.js';
import { SQLiteStorage } from './storage/sqlite.js';
import { FederationManager, type FederationConfig } from './federation/federation-manager.js';
import { createBootstrapClient, type BootstrapClient } from './federation/bootstrap-client.js';
import { RelayRegistry } from './registry/relay-registry.js';
import { RendezvousRegistry } from './registry/rendezvous-registry.js';
import { DistributedRendezvous } from './registry/distributed-rendezvous.js';
import { ClientHandler, type ClientHandlerConfig } from './client/handler.js';
import { logger } from './utils/logger.js';
import { createAdminModule, type AdminModule } from './admin/index.js';
import { requireAuth } from './admin/auth.js';


export interface ZajelServer {
  httpServer: HttpServer;
  wss: WebSocketServer;
  federation: FederationManager;
  bootstrap: BootstrapClient;
  clientHandler: ClientHandler;
  adminModule: AdminModule;
  config: ServerConfig;
  identity: ServerIdentity;
  shutdown: () => Promise<void>;
}

/**
 * Create and start the Zajel server
 */
export async function createZajelServer(
  configOverrides: Partial<ServerConfig> = {}
): Promise<ZajelServer> {
  // Load configuration
  const config = { ...loadConfig(), ...configOverrides };

  console.log('[Zajel] Starting server...');
  console.log(`[Zajel] Region: ${config.network.region || 'unknown'}`);

  // Initialize storage
  const storage = new SQLiteStorage(config.storage.path);
  await storage.init();
  console.log('[Zajel] Storage initialized');

  // Load or generate server identity
  const identity = await loadOrGenerateIdentity(
    config.identity.keyPath,
    config.identity.ephemeralIdPrefix
  );
  logger.info(`[Zajel] Server ID: ${logger.serverId(identity.serverId)}`);
  logger.info(`[Zajel] Node ID: ${logger.serverId(identity.nodeId)}`);

  // Create bootstrap client for CF Workers discovery
  const bootstrap = createBootstrapClient(config, identity, () => ({
    connections: (clientHandlerRef?.clientCount ?? 0) + (clientHandlerRef?.signalingClientCount ?? 0),
    relayConnections: clientHandlerRef?.clientCount ?? 0,
    signalingConnections: clientHandlerRef?.signalingClientCount ?? 0,
    activeCodes: clientHandlerRef?.getEntropyMetrics().activeCodes ?? 0,
  }));

  // Mutable reference for clientHandler (set after creation, used in HTTP handlers)
  let clientHandlerRef: ClientHandler | null = null;

  // Mutable reference for admin module (set after creation)
  let adminModuleRef: AdminModule | null = null;

  // Create HTTP or HTTPS server depending on TLS config
  const requestHandler = async (req: IncomingMessage, res: import('http').ServerResponse) => {
    // Admin dashboard routes (handled first)
    if (req.url?.startsWith('/admin')) {
      if (adminModuleRef) {
        const handled = await adminModuleRef.handleRequest(req, res);
        if (handled) return;
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Admin module not initialized' }));
        return;
      }
    }

    // Health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        serverId: identity.serverId,
        version: process.env['APP_VERSION'] || 'unknown',
        env: process.env['NODE_ENV'] || 'development',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Stats endpoint (requires auth when JWT is configured)
    if (req.url === '/stats') {
      if (config.admin.jwtSecret) {
        const auth = requireAuth(req, res, config.admin.jwtSecret);
        if (!auth) return; // requireAuth already sent 401
      }

      const handler = clientHandlerRef;
      const stats = {
        serverId: identity.serverId,
        nodeId: identity.nodeId,
        endpoint: config.network.publicEndpoint,
        region: config.network.region,
        uptime: process.uptime(),
        connections: handler ? handler.clientCount + handler.signalingClientCount : 0,
        relayConnections: handler?.clientCount || 0,
        signalingConnections: handler?.signalingClientCount || 0,
        activeCodes: handler?.getEntropyMetrics().activeCodes || 0,
        collisionRisk: handler?.getEntropyMetrics().collisionRisk || 'low',
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    // Metrics endpoint (Issue #41: Pairing code entropy monitoring, requires auth)
    if (req.url === '/metrics') {
      if (config.admin.jwtSecret) {
        const auth = requireAuth(req, res, config.admin.jwtSecret);
        if (!auth) return; // requireAuth already sent 401
      }

      const handler = clientHandlerRef;
      if (!handler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server not fully initialized' }));
        return;
      }

      const entropyMetrics = handler.getEntropyMetrics();
      const metrics = {
        serverId: identity.serverId,
        uptime: process.uptime(),
        connections: {
          relay: handler.clientCount,
          signaling: handler.signalingClientCount,
        },
        pairingCodeEntropy: entropyMetrics,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
      return;
    }

    // Default response
    res.writeHead(404);
    res.end('Not Found');
  };

  let httpServer: HttpServer;
  if (config.tls.enabled) {
    const tlsOptions = {
      cert: readFileSync(config.tls.certPath),
      key: readFileSync(config.tls.keyPath),
    };
    httpServer = createHttpsServer(tlsOptions, requestHandler);
    console.log('[Zajel] TLS enabled');
  } else {
    httpServer = createHttpServer(requestHandler);
  }

  // Create WebSocket servers (separate for clients and federation)
  // maxPayload enforces size limits at the protocol level before buffering
  // Messages exceeding the limit are rejected with close code 1009 ("Message Too Big")
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE,
  });
  const federationWss = new WebSocketServer({
    noServer: true,
    maxPayload: WEBSOCKET.MAX_MESSAGE_SIZE,
  });

  // Federation configuration
  const federationConfig: FederationConfig = {
    gossip: {
      pingInterval: config.gossip.interval,
      pingTimeout: config.gossip.interval / 2,
      suspicionTimeout: config.gossip.suspicionTimeout,
      failureTimeout: config.gossip.failureTimeout,
      indirectPingCount: config.gossip.indirectPingCount,
      stateExchangeInterval: config.gossip.stateExchangeInterval,
    },
    transport: {
      handshakeTimeout: 10000,
      reconnectInterval: 1000,
      reconnectMaxInterval: 30000,
      pingInterval: 30000,
      maxReconnectAttempts: 0, // Infinite
    },
    dht: {
      replicationFactor: config.dht.replicationFactor,
      virtualNodes: config.dht.virtualNodes,
    },
    bootstrap: {
      nodes: config.bootstrap.nodes,
      retryInterval: config.bootstrap.retryInterval,
      maxRetries: config.bootstrap.maxRetries,
    },
  };

  const metadata = {
    region: config.network.region,
  };

  // Create federation manager
  const federation = new FederationManager(
    identity,
    config.network.publicEndpoint,
    federationConfig,
    storage,
    metadata
  );

  // Create registries
  const relayRegistry = new RelayRegistry();
  const rendezvousRegistry = new RendezvousRegistry(storage, {
    dailyTtl: config.cleanup.dailyPointTtl,
    hourlyTtl: config.cleanup.hourlyTokenTtl,
  });

  // Create distributed rendezvous layer
  const distributedRendezvous = new DistributedRendezvous(
    rendezvousRegistry,
    federation.getRoutingTable(),
    federation.getRing(),
    { replicationFactor: config.dht.replicationFactor }
  );

  // Create client handler
  const clientHandlerConfig: ClientHandlerConfig = {
    heartbeatInterval: config.client.heartbeatInterval,
    heartbeatTimeout: config.client.heartbeatTimeout,
    maxConnectionsPerPeer: config.client.maxConnectionsPerPeer,
  };

  // Build attestation config if attestation settings are present
  const attestationConfig = config.attestation ? {
    bootstrapUrl: config.attestation.bootstrapUrl,
    vpsIdentityKey: config.attestation.vpsIdentityKey,
    sessionTokenTtl: config.attestation.sessionTokenTtl,
    gracePeriod: config.attestation.gracePeriod,
  } : undefined;

  const clientHandler = new ClientHandler(
    identity,
    config.network.publicEndpoint,
    clientHandlerConfig,
    relayRegistry,
    distributedRendezvous,
    metadata,
    storage,
    attestationConfig,
    federation
  );

  // Set the reference for HTTP handler (used by /metrics endpoint)
  clientHandlerRef = clientHandler;

  // Handle WebSocket upgrades
  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url || '/', `http://${request.headers.host}`).pathname;

    // Admin WebSocket (real-time metrics)
    if (pathname === '/admin/ws') {
      if (adminModuleRef?.handleUpgrade(request, socket, head as Buffer)) {
        return;
      }
    }

    if (pathname === '/federation' || pathname === '/server') {
      // Server-to-server connections
      federationWss.handleUpgrade(request, socket, head, (ws) => {
        federationWss.emit('connection', ws, request);
      });
    } else {
      // Client connections (default)
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  // Per-IP connection tracking for rate limiting
  const ipConnectionCounts = new Map<string, number>();

  // Handle client WebSocket connections
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress || 'unknown';

    // Check total connection limit
    const totalConnections = clientHandler.clientCount + clientHandler.signalingClientCount;
    if (totalConnections >= CONNECTION_LIMITS.MAX_TOTAL_CONNECTIONS) {
      ws.close(1013, 'Server at capacity');
      return;
    }

    // Check per-IP connection limit
    const ipCount = ipConnectionCounts.get(clientIp) || 0;
    if (ipCount >= CONNECTION_LIMITS.MAX_CONNECTIONS_PER_IP) {
      ws.close(1013, 'Too many connections from this IP');
      return;
    }
    ipConnectionCounts.set(clientIp, ipCount + 1);

    logger.clientConnection('connected', clientIp);

    // Send server info
    clientHandler.handleConnection(ws);

    // Handle messages
    ws.on('message', async (data) => {
      // Track message for admin metrics
      adminModuleRef?.recordMessage();
      await clientHandler.handleMessage(ws, data.toString());
    });

    // Handle disconnect
    ws.on('close', async () => {
      // Decrement per-IP count
      const count = ipConnectionCounts.get(clientIp) || 1;
      if (count <= 1) {
        ipConnectionCounts.delete(clientIp);
      } else {
        ipConnectionCounts.set(clientIp, count - 1);
      }

      await clientHandler.handleDisconnect(ws);
      logger.clientConnection('disconnected', clientIp);
    });

    ws.on('error', (error) => {
      console.error(`[Zajel] Client WebSocket error:`, error);
    });
  });

  // Start listening early so health check endpoint is available during
  // bootstrap registration and federation startup (which involve network I/O
  // and can be slow during simultaneous multi-server deployments).
  await new Promise<void>((resolve) => {
    httpServer.listen(config.network.port, config.network.host, () => {
      console.log(`[Zajel] Listening on ${config.network.host}:${config.network.port}`);
      console.log(`[Zajel] Public endpoint: ${config.network.publicEndpoint}`);
      resolve();
    });
  });

  // Register with CF Workers bootstrap server and get peers
  let discoveredPeers: import('./federation/bootstrap-client.js').BootstrapServerEntry[] = [];
  try {
    await bootstrap.register();
    discoveredPeers = await bootstrap.getServers();
    if (discoveredPeers.length > 0) {
      console.log(`[Zajel] Discovered ${discoveredPeers.length} peers from bootstrap server`);
      // Peers will be added to membership + ring via addDiscoveredPeer after
      // federation starts. We no longer push into bootstrap.nodes because
      // federation.start() → bootstrap() would try to WebSocket-connect to
      // each endpoint, blocking startup when peers aren't ready yet.
    }
  } catch (error) {
    console.warn('[Zajel] Bootstrap registration failed, continuing without:', error);
  }

  // Start federation
  await federation.start(federationWss);
  console.log('[Zajel] Federation started');

  // After federation starts, add initially discovered peers directly
  for (const peer of discoveredPeers) {
    federation.addDiscoveredPeer(peer).catch((err) => {
      console.warn(`[Zajel] Failed to connect to discovered peer ${peer.serverId}:`, err);
    });
  }

  // Start bootstrap heartbeat with callback to feed new peers into federation
  bootstrap.startHeartbeat((peers) => {
    for (const peer of peers) {
      federation.addDiscoveredPeer(peer).catch((err) => {
        console.warn(`[Zajel] Failed to connect to heartbeat peer ${peer.serverId}:`, err);
      });
    }
  });

  // Create admin module (requires clientHandler and federation)
  const adminModule = createAdminModule({
    clientHandler,
    federation,
    serverId: identity.serverId,
    jwtSecret: config.admin.jwtSecret,
    cfAdminUrl: config.admin.cfAdminUrl,
  });
  adminModuleRef = adminModule;

  if (config.admin.jwtSecret) {
    console.log('[Zajel] Admin dashboard enabled at /admin/');
  }

  // Set up cleanup interval
  const cleanupInterval = setInterval(async () => {
    try {
      // Clean up expired rendezvous entries
      const { dailyRemoved, hourlyRemoved } = await rendezvousRegistry.cleanup();
      if (dailyRemoved > 0 || hourlyRemoved > 0) {
        console.log(`[Zajel] Cleanup: removed ${dailyRemoved} daily, ${hourlyRemoved} hourly entries`);
      }

      // Clean up stale clients
      const staleClients = await clientHandler.cleanup();
      if (staleClients > 0) {
        console.log(`[Zajel] Cleanup: disconnected ${staleClients} stale clients`);
      }
    } catch (error) {
      console.error('[Zajel] Cleanup error:', error);
    }
  }, config.cleanup.interval);

  // Federation events
  federation.on('ready', () => {
    console.log('[Zajel] Federation ready');
    console.log(`[Zajel] Known servers: ${federation.getAliveCount()}`);
  });

  federation.on('member-join', (entry) => {
    logger.federationEvent('joined', entry.serverId);
  });

  federation.on('member-failed', (entry) => {
    logger.federationEvent('failed', entry.serverId);
  });

  // Shutdown function
  const shutdown = async () => {
    console.log('[Zajel] Shutting down...');

    clearInterval(cleanupInterval);

    // Stop admin module
    adminModule.shutdown();

    // Stop bootstrap heartbeat and unregister
    bootstrap.stopHeartbeat();
    await bootstrap.unregister();

    await clientHandler.shutdown();
    await federation.shutdown();

    wss.close();
    federationWss.close();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    storage.close();

    console.log('[Zajel] Shutdown complete');
  };

  return {
    httpServer,
    wss,
    federation,
    bootstrap,
    clientHandler,
    adminModule,
    config,
    identity,
    shutdown,
  };
}

// Main entry point when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  createZajelServer()
    .then((server) => {
      // Handle graceful shutdown
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

      for (const signal of signals) {
        process.on(signal, async () => {
          console.log(`\n[Zajel] Received ${signal}`);
          await server.shutdown();
          process.exit(0);
        });
      }
    })
    .catch((error) => {
      console.error('[Zajel] Failed to start:', error);
      process.exit(1);
    });
}
