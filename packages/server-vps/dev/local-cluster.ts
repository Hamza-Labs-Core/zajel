/**
 * Local Federation Cluster
 *
 * Starts a mock bootstrap server + multiple VPS server instances for
 * local development and federation testing.
 *
 * Usage:
 *   npx tsx dev/local-cluster.ts [server-count]
 *   npm run dev:cluster
 *   npm run dev:cluster -- 2   (2 servers instead of default 3)
 *
 * Ports:
 *   Bootstrap:  http://localhost:8080
 *   VPS Server 1: ws://localhost:9001  (region: us-east)
 *   VPS Server 2: ws://localhost:9002  (region: eu-west)
 *   VPS Server 3: ws://localhost:9003  (region: ap-south)
 *
 * Flutter app:
 *   flutter run --dart-define=BOOTSTRAP_URL=http://localhost:8080 --dart-define=ENV=dev
 *   flutter run --dart-define=SIGNALING_URL=ws://localhost:9001 --dart-define=ENV=dev
 */

import { MockBootstrapServer } from '../tests/harness/mock-bootstrap.js';
import { createZajelServer, type ZajelServer } from '../src/index.js';
import type { ServerConfig } from '../src/types.js';

const BOOTSTRAP_PORT = 8080;
const VPS_BASE_PORT = 9001;
const REGIONS = ['us-east', 'eu-west', 'ap-south', 'af-south', 'sa-east'];

const serverCount = parseInt(process.argv[2] || '3', 10);

interface RunningServer {
  server: ZajelServer;
  port: number;
  region: string;
}

const running: RunningServer[] = [];
let bootstrap: MockBootstrapServer | null = null;
let shuttingDown = false;

function buildServerConfig(
  port: number,
  region: string,
  bootstrapUrl: string
): Partial<ServerConfig> {
  return {
    network: {
      host: '127.0.0.1',
      port,
      publicEndpoint: `ws://127.0.0.1:${port}`,
      region,
    },
    bootstrap: {
      serverUrl: bootstrapUrl,
      heartbeatInterval: 10000, // 10s heartbeat for dev (faster discovery)
      nodes: [],
      retryInterval: 2000,
      maxRetries: 0, // Infinite retries in dev
    },
    storage: {
      type: 'sqlite',
      path: `./data/dev-server-${port}.db`,
    },
    identity: {
      keyPath: `./data/dev-server-${port}.key`,
      ephemeralIdPrefix: `dev-${region}`,
    },
    gossip: {
      interval: 2000,
      suspicionTimeout: 5000,
      failureTimeout: 10000,
      indirectPingCount: 2,
      stateExchangeInterval: 10000,
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
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('\n[Cluster] Shutting down...');

  for (const { server, port, region } of running) {
    try {
      console.log(`[Cluster] Stopping VPS server ${region} (port ${port})...`);
      await server.shutdown();
    } catch (err) {
      console.warn(`[Cluster] Error stopping server ${port}:`, err);
    }
  }

  if (bootstrap) {
    console.log('[Cluster] Stopping mock bootstrap...');
    await bootstrap.stop();
  }

  console.log('[Cluster] All servers stopped.');
  process.exit(0);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           Zajel Local Federation Cluster                ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();

  // Ensure data directory exists
  const fs = await import('fs');
  if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data', { recursive: true });
  }

  // 1. Start mock bootstrap server
  console.log(`[Cluster] Starting mock bootstrap on port ${BOOTSTRAP_PORT}...`);
  bootstrap = new MockBootstrapServer({
    port: BOOTSTRAP_PORT,
    host: '127.0.0.1',
    autoCleanup: true,
    cleanupInterval: 30000,
    serverTtl: 5 * 60 * 1000,
  });
  await bootstrap.start();
  const bootstrapUrl = bootstrap.getUrl();
  console.log(`[Cluster] ✓ Bootstrap server running at ${bootstrapUrl}`);
  console.log();

  // 2. Start VPS servers
  const count = Math.min(serverCount, REGIONS.length);
  console.log(`[Cluster] Starting ${count} VPS servers...`);
  console.log();

  for (let i = 0; i < count; i++) {
    const port = VPS_BASE_PORT + i;
    const region = REGIONS[i]!;
    const config = buildServerConfig(port, region, bootstrapUrl);

    console.log(`[Cluster] Starting VPS server ${i + 1}/${count} (${region}, port ${port})...`);
    const server = await createZajelServer(config);
    running.push({ server, port, region });
    console.log(`[Cluster] ✓ VPS server ${region} running at ws://127.0.0.1:${port}`);
    console.log(`[Cluster]   Server ID: ${server.identity.serverId.substring(0, 20)}...`);
  }

  // 3. Wait for registration
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // 4. Print summary
  console.log();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Cluster is running! Press Ctrl+C to stop.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log('  Bootstrap server:');
  console.log(`    ${bootstrapUrl}`);
  console.log(`    ${bootstrapUrl}/servers   (list registered VPS servers)`);
  console.log(`    ${bootstrapUrl}/health    (health check)`);
  console.log();
  console.log('  VPS servers:');
  for (const { port, region, server } of running) {
    console.log(`    ws://127.0.0.1:${port}  (${region})  id=${server.identity.serverId.substring(0, 16)}...`);
  }
  console.log();
  console.log('  Flutter app (server discovery via bootstrap):');
  console.log(`    flutter run --dart-define=BOOTSTRAP_URL=${bootstrapUrl} --dart-define=ENV=dev`);
  console.log();
  console.log('  Flutter app (direct connection to server 1):');
  console.log(`    flutter run --dart-define=SIGNALING_URL=ws://localhost:${VPS_BASE_PORT} --dart-define=ENV=dev`);
  console.log();
  console.log('  Registered servers in bootstrap:');
  const servers = bootstrap.getServers();
  for (const s of servers) {
    console.log(`    ${s.serverId.substring(0, 20)}... → ${s.endpoint} (${s.region})`);
  }
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
}

// Handle signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  console.error('[Cluster] Fatal error:', error);
  shutdown().catch(() => process.exit(1));
});
