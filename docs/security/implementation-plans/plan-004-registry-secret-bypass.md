# Implementation Plan 004: Fix SERVER_REGISTRY_SECRET Auth Bypass

**Story Reference**: `/docs/security/stories/story-004-registry-secret-bypass.md`

**Priority**: IMMEDIATE
**Severity**: CRITICAL
**Estimated Effort**: 2-4 hours
**Risk Level**: Medium (requires coordinated deployment)

---

## 1. Summary

The `ServerRegistryDO` authentication check uses a fail-open pattern that bypasses authentication entirely when `SERVER_REGISTRY_SECRET` is not configured. The expression `if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request))` short-circuits to `false` when the secret is undefined, allowing unauthenticated access to all protected endpoints. This affects:

- `POST /servers` (server registration)
- `DELETE /servers/:serverId` (server unregistration)
- `POST /servers/heartbeat` (heartbeat updates)
- `GET /servers/anomalies` (anomaly data viewing)

The fix changes the pattern from fail-open (allow when unconfigured) to fail-closed (deny when unconfigured) by introducing a `requireServerAuth()` helper that returns 503 Service Unavailable when the secret is not set.

---

## 2. Files to Modify

### Primary Files

| File | Location | Lines Affected |
|------|----------|----------------|
| `server-registry-do.js` | `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js` | 346-351, 376-381, 392-396, 418-423, 429-434, 677-691 |

### Test Files to Create

| File | Location | Purpose |
|------|----------|---------|
| `server-registry-auth.test.js` | `/home/meywd/zajel-ddos/packages/server/tests/unit/server-registry-auth.test.js` | Unit tests for auth bypass fix |

### Configuration Files (No Changes Required)

The fix does not require changes to `wrangler.jsonc` or any configuration files. Operators must set `SERVER_REGISTRY_SECRET` via `wrangler secret put` before deployment.

---

## 3. Implementation Steps

### Step 1: Add `requireServerAuth()` Helper Method

**Location**: `/home/meywd/zajel-ddos/packages/server/src/durable-objects/server-registry-do.js`

**After line 351** (after the `verifyServerAuth` method), add the new helper:

**Before**:
```javascript
  verifyServerAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.SERVER_REGISTRY_SECRET) return false;
    if (!authHeader) return false;
    return timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
  }

  /**
   * Verify CI authentication using CI_UPLOAD_SECRET.
   * Same pattern as the attestation registry.
   */
  verifyCIAuth(request) {
```

**After**:
```javascript
  verifyServerAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.SERVER_REGISTRY_SECRET) return false;
    if (!authHeader) return false;
    return timingSafeEqual(authHeader, `Bearer ${this.env.SERVER_REGISTRY_SECRET}`);
  }

  /**
   * Require server authentication for protected endpoints.
   * Returns an error Response if auth is not configured or fails, null if auth passes.
   *
   * @param {Request} request - The incoming request
   * @param {object} corsHeaders - CORS headers to include in error responses
   * @returns {Response|null} Error response if auth fails, null if auth passes
   */
  requireServerAuth(request, corsHeaders) {
    // Fail-closed: deny access if auth is not configured
    if (!this.env.SERVER_REGISTRY_SECRET) {
      this.logger.warn('[audit] Protected endpoint accessed without SERVER_REGISTRY_SECRET configured', {
        action: 'auth_unconfigured',
        method: request.method,
        path: new URL(request.url).pathname,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Server authentication not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Verify credentials
    if (!this.verifyServerAuth(request)) {
      this.logger.warn('[audit] Unauthorized server registry access attempt', {
        action: 'auth_failed',
        method: request.method,
        path: new URL(request.url).pathname,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Auth passed
    return null;
  }

  /**
   * Verify CI authentication using CI_UPLOAD_SECRET.
   * Same pattern as the attestation registry.
   */
  verifyCIAuth(request) {
```

### Step 2: Replace Auth Check in `POST /servers`

**Location**: Lines 375-382

**Before**:
```javascript
      // POST /servers - Register a server (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers') {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.registerServer(request, corsHeaders);
      }
```

**After**:
```javascript
      // POST /servers - Register a server (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers') {
        const authError = this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        return await this.registerServer(request, corsHeaders);
      }
```

### Step 3: Replace Auth Check in `DELETE /servers/:serverId`

**Location**: Lines 390-397

**Before**:
```javascript
      // DELETE /servers/:serverId - Unregister a server (requires auth)
      if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        const pathParts = url.pathname.split('/').filter(Boolean);
```

**After**:
```javascript
      // DELETE /servers/:serverId - Unregister a server (requires auth)
      if (request.method === 'DELETE' && url.pathname.startsWith('/servers/')) {
        const authError = this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        const pathParts = url.pathname.split('/').filter(Boolean);
```

### Step 4: Replace Auth Check in `POST /servers/heartbeat`

**Location**: Lines 416-424

**Before**:
```javascript
      // POST /servers/heartbeat - Update server timestamp (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers/heartbeat') {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.heartbeat(request, corsHeaders);
      }
```

**After**:
```javascript
      // POST /servers/heartbeat - Update server timestamp (requires auth)
      if (request.method === 'POST' && url.pathname === '/servers/heartbeat') {
        const authError = this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        return await this.heartbeat(request, corsHeaders);
      }
```

### Step 5: Replace Auth Check in `GET /servers/anomalies`

**Location**: Lines 427-435

**Before**:
```javascript
      // GET /servers/anomalies - View anomaly scores for all servers (requires auth)
      if (request.method === 'GET' && url.pathname === '/servers/anomalies') {
        if (this.env.SERVER_REGISTRY_SECRET && !this.verifyServerAuth(request)) {
          return new Response(
            JSON.stringify({ error: 'Unauthorized' }),
            { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        return await this.listAnomalies(corsHeaders);
      }
```

**After**:
```javascript
      // GET /servers/anomalies - View anomaly scores for all servers (requires auth)
      if (request.method === 'GET' && url.pathname === '/servers/anomalies') {
        const authError = this.requireServerAuth(request, corsHeaders);
        if (authError) return authError;
        return await this.listAnomalies(corsHeaders);
      }
```

### Step 6: Fix Secondary Auth Check in `unregisterServer()`

**Location**: Lines 677-691

**Before**:
```javascript
    // When SERVER_REGISTRY_SECRET is configured, auth is verified in fetch().
    // When not configured, verify ownership via publicKey in Authorization header
    // if one is provided (defense in depth without breaking non-auth deployments).
    if (!this.env.SERVER_REGISTRY_SECRET) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const providedKey = authHeader.substring(7);
        if (providedKey !== server.publicKey) {
          return new Response(
            JSON.stringify({ error: 'Not authorized to delete this server' }),
            { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
      }
    }
```

**After**:
```javascript
    // Defense-in-depth: This method should only be reached if auth passed in fetch(),
    // but as an extra safety check, deny if SERVER_REGISTRY_SECRET is not configured.
    if (!this.env.SERVER_REGISTRY_SECRET) {
      this.logger.warn('[audit] unregisterServer called without SERVER_REGISTRY_SECRET configured', {
        action: 'unregister_no_auth',
        serverId,
        ip: request.headers.get('CF-Connecting-IP'),
      });
      return new Response(
        JSON.stringify({ error: 'Server authentication not configured' }),
        { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
```

### Step 7: Optional DEV_MODE Escape Hatch (If Required for Local Development)

**Note**: The story mentions a DEV_MODE flag as an optional escape hatch. Based on the current code, `DEV_MODE` is only used for endpoint validation (line 495). We can add an optional bypass for local development, but this should be clearly documented as insecure.

**If needed**, modify `requireServerAuth()` to include a DEV_MODE check:

```javascript
  requireServerAuth(request, corsHeaders) {
    // DEV_MODE escape hatch for local development (INSECURE - do not use in production)
    const isDev = this.env.DEV_MODE === 'true';
    if (isDev && !this.env.SERVER_REGISTRY_SECRET) {
      this.logger.warn('[audit] DEV_MODE enabled: bypassing SERVER_REGISTRY_SECRET check (INSECURE)', {
        action: 'dev_mode_auth_bypass',
        method: request.method,
        path: new URL(request.url).pathname,
      });
      return null; // Allow access in dev mode
    }

    // Fail-closed: deny access if auth is not configured
    if (!this.env.SERVER_REGISTRY_SECRET) {
      // ... rest of the method as shown in Step 1
    }
  }
```

**Decision**: This escape hatch should only be added if there is a demonstrated need for local development. Otherwise, omit it to enforce secure-by-default behavior.

---

## 4. Test Plan

### 4.1 Unit Tests

Create `/home/meywd/zajel-ddos/packages/server/tests/unit/server-registry-auth.test.js`:

```javascript
/**
 * Unit tests for ServerRegistryDO authentication fix (Story 004)
 *
 * Tests the fail-closed authentication pattern for protected endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ServerRegistryDO } from '../../src/durable-objects/server-registry-do.js';

class MockStorage {
  constructor() {
    this.data = new Map();
  }
  async get(key) { return this.data.get(key); }
  async put(key, value) { this.data.set(key, value); }
  async delete(key) { this.data.delete(key); }
  async list({ prefix }) {
    const results = new Map();
    for (const [key, value] of this.data) {
      if (key.startsWith(prefix)) results.set(key, value);
    }
    return results;
  }
  async getAlarm() { return null; }
  async setAlarm() {}
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
  }
  blockConcurrencyWhile(fn) { return fn(); }
}

function createRequest(method, path, body = null, authHeader = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (authHeader) {
    options.headers['Authorization'] = authHeader;
  }
  if (body) {
    options.body = JSON.stringify(body);
  }
  return new Request(`https://test.workers.dev${path}`, options);
}

describe('ServerRegistryDO Authentication (Story 004)', () => {
  describe('POST /servers', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {}; // No SERVER_REGISTRY_SECRET
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toContain('not configured');
    });

    it('should return 401 when SERVER_REGISTRY_SECRET is set but no auth header provided', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret-123' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 when wrong auth token is provided', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      }, 'Bearer wrong-secret');

      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed when correct auth token is provided', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
      }, 'Bearer correct-secret');

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  describe('DELETE /servers/:serverId', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      // Pre-populate a server
      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        lastSeen: Date.now(),
      });

      const request = createRequest('DELETE', '/servers/test-server');
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth header when secret is configured', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret' };
      const registry = new ServerRegistryDO(state, env);

      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        lastSeen: Date.now(),
      });

      const request = createRequest('DELETE', '/servers/test-server');
      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed with correct auth', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        lastSeen: Date.now(),
      });

      const request = createRequest('DELETE', '/servers/test-server', null, 'Bearer correct-secret');
      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('POST /servers/heartbeat', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers/heartbeat', { serverId: 'test-server' });
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth when secret is configured', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('POST', '/servers/heartbeat', { serverId: 'test-server' });
      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed with correct auth', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      // Pre-register server
      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'test-key',
        connections: 0,
        lastSeen: Date.now(),
      });

      const request = createRequest('POST', '/servers/heartbeat', { serverId: 'test-server' }, 'Bearer correct-secret');
      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('GET /servers/anomalies', () => {
    it('should return 503 when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('GET', '/servers/anomalies');
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);
    });

    it('should return 401 without auth when secret is configured', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('GET', '/servers/anomalies');
      const response = await registry.fetch(request);
      expect(response.status).toBe(401);
    });

    it('should succeed with correct auth', async () => {
      const state = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'correct-secret' };
      const registry = new ServerRegistryDO(state, env);

      const request = createRequest('GET', '/servers/anomalies', null, 'Bearer correct-secret');
      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('GET /servers (public endpoint)', () => {
    it('should remain accessible without auth regardless of SERVER_REGISTRY_SECRET', async () => {
      const state = new MockState();

      // Test without secret
      const registryNoSecret = new ServerRegistryDO(state, {});
      let request = createRequest('GET', '/servers');
      let response = await registryNoSecret.fetch(request);
      expect(response.status).toBe(200);

      // Test with secret (should still be public)
      const registryWithSecret = new ServerRegistryDO(state, { SERVER_REGISTRY_SECRET: 'secret' });
      request = createRequest('GET', '/servers');
      response = await registryWithSecret.fetch(request);
      expect(response.status).toBe(200);
    });
  });

  describe('Secondary auth check in unregisterServer()', () => {
    it('should deny deletion when SERVER_REGISTRY_SECRET is not configured', async () => {
      const state = new MockState();
      const env = {};
      const registry = new ServerRegistryDO(state, env);

      // Pre-populate server
      await state.storage.put('server:test-server', {
        serverId: 'test-server',
        endpoint: 'wss://test.example.com',
        publicKey: 'server-public-key',
        lastSeen: Date.now(),
      });

      // Attempt delete without auth (should fail at fetch() guard)
      const request = createRequest('DELETE', '/servers/test-server');
      const response = await registry.fetch(request);
      expect(response.status).toBe(503);

      // Server should still exist
      const server = await state.storage.get('server:test-server');
      expect(server).toBeDefined();
    });
  });
});
```

### 4.2 Integration Tests

Add to existing `/home/meywd/zajel-ddos/packages/server/tests/e2e/integration.test.js`:

```javascript
  describe('Authentication Enforcement (Story 004)', () => {
    it('should block server registration when SERVER_REGISTRY_SECRET is not set', async () => {
      // Create registry without secret
      const mockState = new MockState();
      const registry = new ServerRegistryDO(mockState, {});

      const response = await registry.fetch(createRequest('POST', '/servers', {
        serverId: 'ed25519:blocked-server',
        endpoint: 'wss://blocked.example.com',
        publicKey: 'blocked-key',
      }));

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toContain('not configured');
    });

    it('should allow registration with valid auth', async () => {
      const mockState = new MockState();
      const env = { SERVER_REGISTRY_SECRET: 'test-secret-123' };
      const registry = new ServerRegistryDO(mockState, env);

      const request = new Request('https://test.workers.dev/servers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret-123',
        },
        body: JSON.stringify({
          serverId: 'ed25519:auth-server',
          endpoint: 'wss://auth.example.com',
          publicKey: 'auth-key',
        }),
      });

      const response = await registry.fetch(request);
      expect(response.status).toBe(200);
    });
  });
```

### 4.3 Manual Testing Checklist

- [ ] Deploy to staging without `SERVER_REGISTRY_SECRET` configured
- [ ] Verify `POST /servers` returns 503
- [ ] Verify `DELETE /servers/:id` returns 503
- [ ] Verify `POST /servers/heartbeat` returns 503
- [ ] Verify `GET /servers/anomalies` returns 503
- [ ] Verify `GET /servers` still works (public endpoint)
- [ ] Set `SERVER_REGISTRY_SECRET` via `wrangler secret put`
- [ ] Verify all protected endpoints return 401 without auth header
- [ ] Verify all protected endpoints return 401 with wrong auth header
- [ ] Verify all protected endpoints work with correct auth header
- [ ] Check audit logs for "auth_unconfigured" and "auth_failed" events

### 4.4 Regression Testing

Ensure existing integration tests still pass:

```bash
cd /home/meywd/zajel-ddos/packages/server
npm test tests/e2e/integration.test.js
```

Note: Existing tests in `integration.test.js` do NOT set `SERVER_REGISTRY_SECRET` and will now fail unless updated to either:
1. Set the secret in the mock env, OR
2. Add Authorization headers to protected endpoint calls

**Required Update to Existing Tests**:

Modify the `beforeEach` in `integration.test.js` to include the secret:

```javascript
  beforeEach(() => {
    mockState = new MockState();
    serverRegistry = new ServerRegistryDO(mockState, {
      SERVER_REGISTRY_SECRET: 'test-integration-secret'
    });
    env = createMockEnv(serverRegistry);
    vi.useFakeTimers();
  });
```

And update all helper functions to include auth:

```javascript
async function registerServer(registry, serverData) {
  const request = new Request('https://test.workers.dev/servers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-integration-secret',
    },
    body: JSON.stringify(serverData),
  });
  const response = await registry.fetch(request);
  return response.json();
}

async function sendHeartbeat(registry, serverId) {
  const request = new Request('https://test.workers.dev/servers/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-integration-secret',
    },
    body: JSON.stringify({ serverId }),
  });
  const response = await registry.fetch(request);
  return response.json();
}

async function unregisterServer(registry, serverId) {
  const request = new Request(`https://test.workers.dev/servers/${serverId}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-integration-secret',
    },
  });
  const response = await registry.fetch(request);
  return response.json();
}
```

---

## 5. Rollback Risk Assessment

### Risk Level: **MEDIUM**

### Breaking Changes

**YES** - This is a breaking change for any deployment that does not have `SERVER_REGISTRY_SECRET` configured:

1. **VPS servers currently registering without auth** will be blocked immediately upon deployment
2. **Existing heartbeat loops** will start failing with 503 errors
3. **Any automation scripts** calling protected endpoints will break

### Affected Deployments

| Deployment | Impact | Mitigation |
|------------|--------|------------|
| **Production CF Workers** | HIGH - If `SERVER_REGISTRY_SECRET` is not set, all VPS servers will lose ability to register/heartbeat | MUST set secret BEFORE deploying this fix |
| **Staging CF Workers** | HIGH - Same as production | Set secret before deployment |
| **Local Development** | MEDIUM - Developers will need to configure secret in `.dev.vars` | Optional: Add DEV_MODE escape hatch |
| **CI/CD Tests** | LOW - Mock environments already control env vars | Update test fixtures to include secret |

### Rollback Procedure

If this change causes issues in production:

1. **Immediate Rollback** via `wrangler rollback`:
   ```bash
   cd /home/meywd/zajel-ddos/packages/server
   wrangler rollback --message "Rollback Story 004 auth fix"
   ```

2. **Emergency Fix** - Temporarily set `DEV_MODE=true` to bypass auth:
   ```bash
   wrangler secret put DEV_MODE
   # Enter: true
   ```
   **WARNING**: This is INSECURE and should only be used as a last resort. Immediately investigate why `SERVER_REGISTRY_SECRET` was not set.

3. **Root Cause Analysis**:
   - Check if `SERVER_REGISTRY_SECRET` was accidentally deleted
   - Verify VPS servers have the correct secret for registration
   - Check audit logs for "auth_unconfigured" events

### Pre-Deployment Checklist

Before deploying this fix to ANY environment:

- [ ] Verify `SERVER_REGISTRY_SECRET` is configured via `wrangler secret list`
- [ ] Document the secret value in a secure location (password manager, etc.)
- [ ] Ensure all VPS server deployment scripts/configs include the secret
- [ ] Update monitoring/alerting to watch for 503 errors on protected endpoints
- [ ] Communicate deployment window to VPS server operators
- [ ] Have rollback command ready in terminal

---

## 6. Dependencies on Other Stories

### Direct Dependencies

- **Story 002: Trusted Keys Deny-Default** - Both stories fix fail-open patterns in the same file (`server-registry-do.js`). They can be implemented independently but should be deployed together to ensure consistent security posture.

### Recommended Deployment Order

1. **Deploy Story 004 FIRST** (this plan) - Ensures auth is enforced before fixing build verification
2. **Deploy Story 002 SECOND** - Ensures build verification defaults to deny

**Rationale**: If Story 002 is deployed first, attackers can still register rogue servers without auth. If Story 004 is deployed first, registration is locked down, and Story 002 can be deployed safely.

### Merge Conflict Risk

**HIGH** - Both stories modify the same methods:
- `registerServer()` (Story 002: lines 586, Story 004: lines 376-381)
- `heartbeat()` (Story 002: lines 751, Story 004: lines 418-423)

**Resolution**: Implement both stories in the same branch or ensure Story 004 is merged first, then rebase Story 002.

### Combined Testing

After deploying both fixes, verify:
- [ ] Unauthenticated requests are blocked (Story 004)
- [ ] Authenticated requests with untrusted build keys get `buildVerified: false` (Story 002)
- [ ] Authenticated requests with trusted build keys get `buildVerified: true` (Story 002)

---

## 7. Additional Notes

### Audit Logging

The `requireServerAuth()` helper includes comprehensive audit logging:
- Logs when protected endpoints are accessed without `SERVER_REGISTRY_SECRET` configured
- Logs failed authentication attempts with IP address
- Uses consistent `[audit]` prefix for filtering/alerting

### CORS Headers

The fix preserves CORS headers in all error responses to ensure browser clients can read the error messages.

### Status Code Choices

- **503 Service Unavailable**: Used when `SERVER_REGISTRY_SECRET` is not configured, indicating the service is not ready to accept requests
- **401 Unauthorized**: Used when credentials are missing or invalid

### Security Hardening

Consider these additional hardening measures (out of scope for this story):

1. **Rate limiting** on auth failures to prevent brute force attacks
2. **IP allowlisting** for VPS server registration (if feasible)
3. **Mutual TLS** for server-to-registry authentication
4. **Audit log shipping** to external SIEM for monitoring

### Documentation Updates

After deployment, update:
- [ ] Deployment guide to mention `SERVER_REGISTRY_SECRET` is required
- [ ] VPS server setup guide to include auth token configuration
- [ ] API documentation to reflect 503 error for unconfigured auth
- [ ] Troubleshooting guide with common auth failure scenarios

---

## 8. Success Criteria

The implementation is considered successful when:

- [ ] All unit tests in `server-registry-auth.test.js` pass
- [ ] All existing integration tests pass with updated auth configuration
- [ ] Deployment to staging with `SERVER_REGISTRY_SECRET` unset returns 503 for protected endpoints
- [ ] Deployment to staging with `SERVER_REGISTRY_SECRET` set allows authenticated access
- [ ] Audit logs show "auth_unconfigured" events when secret is missing
- [ ] Audit logs show "auth_failed" events for invalid credentials
- [ ] `GET /servers` remains publicly accessible
- [ ] No regression in server registration/heartbeat functionality when properly authenticated
- [ ] Production deployment completes without breaking VPS server connectivity

---

**Prepared by**: Claude (AI Assistant)
**Date**: 2026-03-03
**Version**: 1.0
