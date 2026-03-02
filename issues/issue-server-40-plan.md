# Plan: Stats and metrics endpoints accessible without authentication

**Retargeted**: This issue was originally identified in dead CF Worker code. The same vulnerability exists in the VPS server.

**Issue**: issue-server-40.md
**Severity**: LOW
**Area**: Server (VPS)
**Files to modify**: `packages/server-vps/src/index.ts`

## Analysis

In `packages/server-vps/src/index.ts`, the `/stats` endpoint (lines 100-118) and `/metrics` endpoint (lines 121-143) return internal operational statistics without any authentication:

**`/stats` endpoint (lines 100-118):**
```ts
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
```

**`/metrics` endpoint (lines 121-143):**
```ts
if (req.url === '/metrics') {
  const handler = clientHandlerRef;
  // ...
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
```

The exposed data reveals:
- `serverId` and `nodeId`: Server identity information
- `endpoint`: Public endpoint URL
- `region`: Server deployment region
- `uptime`: How long the server has been running (useful for timing attacks)
- `connections` / `relayConnections` / `signalingConnections`: Number of active connections (reveals usage patterns)
- `activeCodes`: Number of active pairing codes (reveals real-time user activity)
- `collisionRisk`: Pairing code entropy risk level
- `pairingCodeEntropy`: Detailed entropy metrics including `peakActiveCodes`, `totalRegistrations`, `collisionAttempts`

Unlike the original CF Worker target (which was dead code), these endpoints are **live and reachable** in the VPS server on every deployment.

## Fix Steps

1. **Add authentication to both `/stats` and `/metrics` endpoints** in `packages/server-vps/src/index.ts`. Require a bearer token from an environment variable:

```ts
// Helper function (add near the top of createZajelServer or as a module-level function)
function checkStatsAuth(req: IncomingMessage, config: ServerConfig): boolean {
  const adminSecret = config.admin?.statsSecret || process.env['STATS_SECRET'];
  if (!adminSecret) return false; // If no secret configured, deny all access

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${adminSecret}`) {
    return false;
  }
  return true;
}
```

2. **Update the `/stats` endpoint** (replace lines 100-118):

```ts
if (req.url === '/stats') {
  if (!checkStatsAuth(req, config)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
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
```

3. **Update the `/metrics` endpoint** (replace lines 121-143):

```ts
if (req.url === '/metrics') {
  if (!checkStatsAuth(req, config)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
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
```

4. **Add `STATS_SECRET` to the server configuration**. In `packages/server-vps/src/config.ts`, add a `statsSecret` field to the admin config section, reading from the `STATS_SECRET` environment variable.

5. **Note: `/health` endpoint remains unauthenticated**. The health check at line 86 only returns `status: 'healthy'`, version, and uptime. This is intentionally public for load balancer health checks. However, consider removing `uptime` from the health response as well, since it leaks operational information.

## Testing

- Test that `/stats` without auth returns 401.
- Test that `/stats` with wrong secret returns 401.
- Test that `/stats` with correct `STATS_SECRET` returns the stats JSON with 200.
- Test that `/metrics` without auth returns 401.
- Test that `/metrics` with correct `STATS_SECRET` returns the metrics JSON with 200.
- Test that `/health` remains accessible without auth (public health check).
- Verify the admin dashboard at `/admin` is not affected (uses its own JWT auth).

## Risk Assessment

- **Low complexity**: The fix is a simple auth check on two HTTP handlers, straightforward to implement.
- **Live production risk**: Unlike the CF Worker version, these endpoints are reachable in production. Any internet user can currently query `/stats` and `/metrics` to learn server identity, connection counts, and pairing code entropy.
- **Deployment note**: After deploying, the `STATS_SECRET` environment variable must be set on the VPS. Without it, the endpoints will return 401 for all requests (fail-closed behavior).
- **Backward compatibility**: Any monitoring tools or dashboards that consume `/stats` or `/metrics` will need to be updated to include the `Authorization: Bearer <secret>` header.
