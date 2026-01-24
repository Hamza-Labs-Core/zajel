/**
 * Zajel VPS Server
 *
 * Federated signaling server for the Zajel P2P messaging network.
 * Implements SWIM gossip protocol, consistent hashing, and distributed
 * rendezvous for peer discovery.
 */

import { createServer, type Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { loadConfig, type ServerConfig } from './config.js';
import { WEBSOCKET } from './constants.js';
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
  const bootstrap = createBootstrapClient(config, identity);

  // Mutable reference for clientHandler (set after creation, used in HTTP handlers)
  let clientHandlerRef: ClientHandler | null = null;

  // Mutable reference for admin module (set after creation)
  let adminModuleRef: AdminModule | null = null;

  // Create HTTP server
  const httpServer = createServer(async (req, res) => {
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
        version: process.env.APP_VERSION || 'unknown',
        env: process.env.NODE_ENV || 'development',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Stats endpoint
    if (req.url === '/stats') {
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

    // Metrics endpoint (Issue #41: Pairing code entropy monitoring)
    if (req.url === '/metrics') {
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
  });

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

  const clientHandler = new ClientHandler(
    identity,
    config.network.publicEndpoint,
    clientHandlerConfig,
    relayRegistry,
    distributedRendezvous,
    metadata
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

  // Handle client WebSocket connections
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
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
      await clientHandler.handleDisconnect(ws);
      logger.clientConnection('disconnected', clientIp);
    });

    ws.on('error', (error) => {
      console.error(`[Zajel] Client WebSocket error:`, error);
    });
  });

  // Register with CF Workers bootstrap server and get peers
  try {
    await bootstrap.register();
    const discoveredPeers = await bootstrap.getServers();
    if (discoveredPeers.length > 0) {
      console.log(`[Zajel] Discovered ${discoveredPeers.length} peers from bootstrap server`);
      // Add discovered peers to federation config
      for (const peer of discoveredPeers) {
        if (!federationConfig.bootstrap.nodes.includes(peer.endpoint)) {
          federationConfig.bootstrap.nodes.push(peer.endpoint);
        }
      }
    }
  } catch (error) {
    console.warn('[Zajel] Bootstrap registration failed, continuing without:', error);
  }

  // Start federation
  await federation.start(federationWss);
  console.log('[Zajel] Federation started');

  // Start bootstrap heartbeat
  bootstrap.startHeartbeat();

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

  // Start listening
  await new Promise<void>((resolve) => {
    httpServer.listen(config.network.port, config.network.host, () => {
      console.log(`[Zajel] Listening on ${config.network.host}:${config.network.port}`);
      console.log(`[Zajel] Public endpoint: ${config.network.publicEndpoint}`);
      resolve();
    });
  });

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
