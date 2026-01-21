/**
 * Admin Dashboard Module for VPS Server
 *
 * Provides:
 * - Authentication via shared JWT with CF Workers
 * - Real-time metrics via WebSocket
 * - REST API for metrics, federation, scaling
 * - Dashboard UI
 */

import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientHandler } from '../client/handler.js';
import type { FederationManager } from '../federation/federation-manager.js';
import { MetricsCollector } from './metrics.js';
import { AdminRoutes } from './routes.js';
import { AdminWebSocketHandler } from './websocket.js';
import { verifyJwt, extractToken } from './auth.js';
import type { AdminConfig } from './types.js';

export interface AdminModule {
  metricsCollector: MetricsCollector;
  routes: AdminRoutes;
  wsHandler: AdminWebSocketHandler;
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  handleUpgrade: (req: IncomingMessage, socket: unknown, head: Buffer) => boolean;
  recordMessage: () => void;
  shutdown: () => void;
}

export interface CreateAdminModuleOptions {
  clientHandler: ClientHandler;
  federation: FederationManager;
  serverId: string;
  jwtSecret: string;
  cfAdminUrl?: string;
}

/**
 * Create the admin module
 */
export function createAdminModule(options: CreateAdminModuleOptions): AdminModule {
  const { clientHandler, federation, serverId, jwtSecret, cfAdminUrl } = options;

  // Validate JWT secret is configured
  if (!jwtSecret) {
    console.warn('[Admin] JWT_SECRET not configured - admin dashboard disabled');
    return createDisabledModule();
  }

  const config: AdminConfig = {
    jwtSecret,
    cfAdminUrl,
    metricsHistorySeconds: 3600, // 1 hour
  };

  // Create metrics collector
  const metricsCollector = new MetricsCollector(
    clientHandler,
    federation,
    serverId,
    config.metricsHistorySeconds
  );

  // Create routes handler
  const routes = new AdminRoutes(metricsCollector, config);

  // Create WebSocket server for admin connections
  const adminWss = new WebSocketServer({ noServer: true });

  // Create WebSocket handler
  const wsHandler = new AdminWebSocketHandler(adminWss, metricsCollector, jwtSecret);
  wsHandler.start();

  console.log('[Admin] Dashboard module initialized');

  return {
    metricsCollector,
    routes,
    wsHandler,

    /**
     * Handle HTTP requests for admin routes
     */
    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = url.pathname;

      // Only handle /admin/* routes
      if (!path.startsWith('/admin')) {
        return false;
      }

      return routes.handleRequest(req, res, path);
    },

    /**
     * Handle WebSocket upgrades for admin WebSocket
     */
    handleUpgrade(req: IncomingMessage, socket: unknown, head: Buffer): boolean {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = url.pathname;

      // Only handle /admin/ws
      if (path !== '/admin/ws') {
        return false;
      }

      // Verify authentication before upgrade
      const token = extractToken(req);
      if (!token || !verifyJwt(token, jwtSecret)) {
        // Reject upgrade
        const s = socket as import('net').Socket;
        s.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        s.destroy();
        return true;
      }

      adminWss.handleUpgrade(req, socket as import('net').Socket, head, (ws: WebSocket) => {
        adminWss.emit('connection', ws, req);
      });

      return true;
    },

    /**
     * Record a message for rate tracking
     */
    recordMessage(): void {
      metricsCollector.recordMessage();
    },

    /**
     * Shutdown the admin module
     */
    shutdown(): void {
      wsHandler.shutdown();
      adminWss.close();
      console.log('[Admin] Dashboard module shut down');
    },
  };
}

/**
 * Create a disabled admin module (when JWT secret not configured)
 */
function createDisabledModule(): AdminModule {
  const noopCollector = {
    recordMessage: () => {},
    takeSnapshot: () => ({} as never),
    getHistory: () => ({ snapshots: [], startTime: 0, endTime: 0 }),
    getFederationTopology: () => ({ nodes: [], edges: [] }),
    getScalingRecommendation: () => ({
      level: 'normal' as const,
      message: 'Admin disabled',
      metrics: { connectionLoad: 0, entropyPressure: 0, federationHealth: 100 },
      recommendations: [],
    }),
  };

  return {
    metricsCollector: noopCollector as unknown as MetricsCollector,
    routes: null as unknown as AdminRoutes,
    wsHandler: null as unknown as AdminWebSocketHandler,
    handleRequest: async () => false,
    handleUpgrade: () => false,
    recordMessage: () => {},
    shutdown: () => {},
  };
}

// Re-export types
export type { AdminConfig, MetricsSnapshot, FederationTopology, ScalingRecommendation } from './types.js';
