/**
 * Configuration management for the Zajel federated server
 */

import { config as loadEnv } from 'dotenv';
import type { ServerConfig } from './types.js';

export type { ServerConfig };

loadEnv();

function envString(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function envNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function envArray(key: string, defaultValue: string[]): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): ServerConfig {
  return {
    identity: {
      keyPath: envString('ZAJEL_KEY_PATH', './data/server.key'),
      ephemeralIdPrefix: envString('ZAJEL_ID_PREFIX', 'srv'),
    },

    network: {
      host: envString('ZAJEL_HOST', '0.0.0.0'),
      port: envNumber('ZAJEL_PORT', 9000),
      publicEndpoint: envString('ZAJEL_PUBLIC_ENDPOINT', `ws://localhost:${envNumber('ZAJEL_PORT', 9000)}`),
      region: process.env['ZAJEL_REGION'],
    },

    bootstrap: {
      // CF Workers bootstrap server URL
      serverUrl: envString('ZAJEL_BOOTSTRAP_URL', 'https://zajel-signaling.mahmoud-s-darwish.workers.dev'),
      // Heartbeat interval (how often to ping CF)
      heartbeatInterval: envNumber('ZAJEL_BOOTSTRAP_HEARTBEAT', 60000), // 1 minute
      // Legacy: direct peer nodes (optional, for manual configuration)
      nodes: envArray('ZAJEL_BOOTSTRAP_NODES', []),
      retryInterval: envNumber('ZAJEL_BOOTSTRAP_RETRY_INTERVAL', 5000),
      maxRetries: envNumber('ZAJEL_BOOTSTRAP_MAX_RETRIES', 10),
    },

    gossip: {
      interval: envNumber('ZAJEL_GOSSIP_INTERVAL', 1000),
      suspicionTimeout: envNumber('ZAJEL_SUSPICION_TIMEOUT', 2000),
      failureTimeout: envNumber('ZAJEL_FAILURE_TIMEOUT', 5000),
      indirectPingCount: envNumber('ZAJEL_INDIRECT_PING_COUNT', 3),
      stateExchangeInterval: envNumber('ZAJEL_STATE_EXCHANGE_INTERVAL', 30000),
    },

    dht: {
      replicationFactor: envNumber('ZAJEL_REPLICATION_FACTOR', 3),
      writeQuorum: envNumber('ZAJEL_WRITE_QUORUM', 2),
      readQuorum: envNumber('ZAJEL_READ_QUORUM', 1),
      virtualNodes: envNumber('ZAJEL_VIRTUAL_NODES', 150),
    },

    storage: {
      type: 'sqlite',
      path: envString('ZAJEL_DB_PATH', './data/zajel.db'),
    },

    client: {
      maxConnectionsPerPeer: envNumber('ZAJEL_MAX_CONNECTIONS_PER_PEER', 20),
      heartbeatInterval: envNumber('ZAJEL_HEARTBEAT_INTERVAL', 30000),
      heartbeatTimeout: envNumber('ZAJEL_HEARTBEAT_TIMEOUT', 60000),
    },

    cleanup: {
      interval: envNumber('ZAJEL_CLEANUP_INTERVAL', 300000), // 5 minutes
      dailyPointTtl: envNumber('ZAJEL_DAILY_POINT_TTL', 48 * 60 * 60 * 1000), // 48 hours
      hourlyTokenTtl: envNumber('ZAJEL_HOURLY_TOKEN_TTL', 3 * 60 * 60 * 1000), // 3 hours
    },
  };
}

export const config = loadConfig();
