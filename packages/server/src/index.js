/**
 * Zajel Bootstrap Server - Cloudflare Worker
 *
 * A server registry and attestation authority for the Zajel infrastructure.
 *
 * Endpoints (with per-endpoint rate limits):
 * - GET /health [read: 200/min per IP]
 * - GET /servers [30/min per IP]
 * - GET /servers/trusted-keys [10/min per IP]
 * - GET /attest/versions [read: 200/min per IP]
 * - POST /servers [5/min per IP] - Register a VPS server
 * - DELETE /servers/:id [write: 30/min per IP] - Unregister a server
 * - POST /servers/heartbeat [write: 30/min per IP] (+ 2/min per serverId, max 1 per 30s in DO)
 * - POST /attest/register [attest: 20/min per IP] - Register device with build token
 * - POST /attest/challenge [attest: 20/min per IP] - Request attestation challenge
 * - POST /attest/verify [attest: 20/min per IP] - Verify attestation responses
 * - POST /attest/upload-reference [admin: 10/min per IP] - CI uploads reference metadata
 * - POST /attest/versions [admin: 10/min per IP] - Update version policy
 * - POST /servers/trusted-keys [5/min per IP] - Update trusted build keys
 */

import { importSigningKey, signPayload } from './crypto/signing.js';
import { getCorsHeaders } from './cors.js';
import { rateLimiter } from './rate-limiter.js';

import {
  getServerRegistryShard,
  aggregateServerList,
  findServerRegion,
} from './sharding/server-registry-sharding.js';

import {
  getAttestationShard,
  extractDeviceIdFromRequest,
} from './sharding/attestation-sharding.js';

import {
  getServerRegistryAdminShard,
  getAttestationAdminShard,
} from './sharding/admin-operations.js';

import {
  getVersionPolicy,
  invalidateVersionPolicyCache,
} from './sharding/version-policy-cache.js';

export { ServerRegistryDO } from './durable-objects/server-registry-do.js';
export { AttestationRegistryDO } from './durable-objects/attestation-registry-do.js';
export { AuditLogDO } from './durable-objects/audit-log-do.js';
export { TufMetadataDO } from './durable-objects/tuf-metadata-do.js';

/**
 * Per-endpoint rate limits.
 * Each endpoint has its own rate limit key and independent counter per IP.
 * More sensitive or expensive endpoints get tighter limits.
 */
const RATE_LIMITS = {
  // Read endpoints
  read:                 { limit: 200, windowMs: 60000 },  // GET /health, OPTIONS, /, /api/info, /tuf/*
  'GET:/servers':       { limit: 30,  windowMs: 60000 },  // GET /servers — server list
  'GET:/servers/trusted-keys': { limit: 10, windowMs: 60000 }, // GET /servers/trusted-keys
  // Write endpoints
  'POST:/servers':      { limit: 5,   windowMs: 60000 },  // POST /servers — registration
  write:                { limit: 30,  windowMs: 60000 },  // DELETE /servers/:id, POST /servers/heartbeat
  // Attestation endpoints
  attest:               { limit: 20,  windowMs: 60000 },  // POST /attest/register, challenge, verify
  // Admin endpoints
  admin:                { limit: 10,  windowMs: 60000 },  // POST /attest/upload-reference, /attest/versions
  'POST:/servers/trusted-keys': { limit: 5, windowMs: 60000 }, // POST /servers/trusted-keys
};

/**
 * Determine rate limit key for the given request.
 * Returns a key that maps to a RATE_LIMITS entry.
 * @param {string} method - HTTP method (GET, POST, DELETE, etc.)
 * @param {string} pathname - URL pathname (e.g., "/servers", "/attest/verify")
 * @returns {string} Rate limit key matching a RATE_LIMITS entry
 */
function getEndpointRateLimitKey(method, pathname) {
  // OPTIONS preflight — always read tier
  if (method === 'OPTIONS') {
    return 'read';
  }

  // Per-endpoint overrides (most specific first)
  if (method === 'GET' && pathname === '/servers/trusted-keys') {
    return 'GET:/servers/trusted-keys';
  }
  if (method === 'GET' && pathname === '/servers') {
    return 'GET:/servers';
  }
  if (method === 'POST' && pathname === '/servers/trusted-keys') {
    return 'POST:/servers/trusted-keys';
  }
  if (method === 'POST' && pathname === '/servers') {
    return 'POST:/servers';
  }

  // GET requests default to read tier
  if (method === 'GET') {
    return 'read';
  }

  // Admin endpoints: CI uploads, version management
  if (pathname === '/attest/upload-reference' ||
      pathname === '/attest/versions') {
    return 'admin';
  }

  // Attestation endpoints: register, challenge, verify
  if (pathname.startsWith('/attest')) {
    return 'attest';
  }

  // All other mutations (POST /servers/heartbeat, DELETE /servers/:id)
  return 'write';
}

export { getEndpointRateLimitKey, RATE_LIMITS };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, env);

    // Reject requests without CF-Connecting-IP to prevent 'unknown' bypass
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) {
      return new Response(
        JSON.stringify({ error: 'Missing client IP' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Per-endpoint rate limiting with differentiated limits
    const rateLimitKey = getEndpointRateLimitKey(request.method, url.pathname);
    const { limit, windowMs } = RATE_LIMITS[rateLimitKey];
    const { allowed, remaining, retryAfter } = rateLimiter.check(`${ip}:${rateLimitKey}`, limit, windowMs);

    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Too Many Requests' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': retryAfter.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Limit': limit.toString(),
            ...corsHeaders,
          },
        }
      );
    }

    // Helper to add rate limit headers to all responses
    const addRateLimitHeaders = (response) => {
      response.headers.set('X-RateLimit-Remaining', remaining.toString());
      response.headers.set('X-RateLimit-Limit', limit.toString());
      return response;
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      const response = new Response(null, { headers: corsHeaders });
      return addRateLimitHeaders(response);
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      const response = new Response(
        JSON.stringify({
          status: 'ok',
          service: 'zajel-bootstrap',
          timestamp: new Date().toISOString(),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
      return addRateLimitHeaders(response);
    }

    // API info
    if (url.pathname === '/' || url.pathname === '/api/info') {
      const response = new Response(
        JSON.stringify({
          name: 'Zajel Bootstrap Server',
          version: '4.0.0',
          description: 'VPS server discovery and attestation service',
          endpoints: {
            health: 'GET /health',
            listServers: 'GET /servers',
            registerServer: 'POST /servers',
            unregisterServer: 'DELETE /servers/:serverId',
            heartbeat: 'POST /servers/heartbeat',
            attestRegister: 'POST /attest/register',
            attestUploadReference: 'POST /attest/upload-reference',
            attestChallenge: 'POST /attest/challenge',
            attestVerify: 'POST /attest/verify',
            attestVersions: 'GET /attest/versions',
            attestSetVersions: 'POST /attest/versions',
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        }
      );
      return addRateLimitHeaders(response);
    }

    // GET /servers — aggregate from all regional shards, add timestamp, and sign
    if (url.pathname === '/servers' && request.method === 'GET') {
      // Fan-out to all regional shards and aggregate results
      const { servers, errors } = await aggregateServerList(env, request);

      const data = {
        servers,
        // Include shard errors for observability (non-blocking)
        ...(errors.length > 0 ? { shard_errors: errors } : {}),
      };

      // Add timestamp for replay protection
      data.timestamp = Date.now();

      const body = JSON.stringify(data);
      const headers = {
        'Content-Type': 'application/json',
        ...corsHeaders,
      };

      // Sign the response if the signing key is configured
      if (env.BOOTSTRAP_SIGNING_KEY) {
        try {
          const key = await importSigningKey(env.BOOTSTRAP_SIGNING_KEY);
          headers['X-Bootstrap-Signature'] = await signPayload(key, body);
        } catch (e) {
          // Log but don't fail — unsigned response is still useful
          console.error('Failed to sign bootstrap response:', e);
        }
      }

      // Add TUF timestamp version header if TUF metadata is available
      if (env.TUF_METADATA) {
        try {
          const tufStub = env.TUF_METADATA.get(env.TUF_METADATA.idFromName('global'));
          const tufReq = new Request('https://internal/tuf/timestamp.json');
          const tufResp = await tufStub.fetch(tufReq);
          if (tufResp.ok) {
            const tufData = await tufResp.json();
            if (tufData.signed?.version) {
              headers['X-TUF-Timestamp-Version'] = tufData.signed.version.toString();
            }
          }
        } catch {
          // TUF metadata not available yet — skip header
        }
      }

      const response = new Response(body, { headers });
      return addRateLimitHeaders(response);
    }

    // All other /servers/* routes go to the ServerRegistry Durable Object
    if (url.pathname.startsWith('/servers')) {
      // Route to appropriate shard based on operation type
      let stub;

      // Admin operations: dedicated admin shard
      if (url.pathname === '/servers/trusted-keys') {
        stub = getServerRegistryAdminShard(env);
      } else {
        // Server registration/heartbeat/delete: extract region from body or query
        let region = null;

        if (request.method === 'POST' || request.method === 'DELETE') {
          try {
            // Clone request to peek at body without consuming it
            const clonedRequest = request.clone();

            // Extract region from body for POST (registration)
            if (request.method === 'POST') {
              const body = await clonedRequest.json();
              region = body.region || null;

              // For heartbeat, fan-out to find the server's region
              if (url.pathname === '/servers/heartbeat' && body.serverId) {
                region = await findServerRegion(env, body.serverId);
              }
            }

            // Extract serverId from URL path for DELETE, then find its region
            if (request.method === 'DELETE') {
              const pathParts = url.pathname.split('/').filter(Boolean);
              if (pathParts.length === 2 && pathParts[0] === 'servers') {
                const serverId = decodeURIComponent(pathParts[1]);
                region = await findServerRegion(env, serverId);
              }
            }
          } catch (e) {
            // Body parsing failed - use default shard
          }
        }

        stub = getServerRegistryShard(env, region);
      }

      const doResponse = await stub.fetch(request);
      const response = new Response(doResponse.body, doResponse);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return addRateLimitHeaders(response);
    }

    // All /attest/* routes go to the AttestationRegistry Durable Object
    if (url.pathname.startsWith('/attest')) {
      let stub;

      // Version policy: serve from read-through cache
      if (url.pathname === '/attest/versions' && request.method === 'GET') {
        const policy = await getVersionPolicy(env, async () => {
          const adminStub = getAttestationAdminShard(env);
          const adminRequest = new Request(request.url, {
            method: request.method,
            headers: request.headers,
          });
          const adminResponse = await adminStub.fetch(adminRequest);
          return adminResponse.json();
        });

        const response = new Response(JSON.stringify(policy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
        for (const [key, value] of Object.entries(corsHeaders)) {
          response.headers.set(key, value);
        }
        return addRateLimitHeaders(response);
      }

      // Admin operations: dedicated admin shard (write path for versions, upload-reference)
      if (url.pathname === '/attest/versions' ||
          url.pathname === '/attest/upload-reference') {
        stub = getAttestationAdminShard(env);

        // Invalidate version policy cache on write operations
        if (request.method !== 'GET') {
          invalidateVersionPolicyCache();
        }
      } else {
        // Device operations: shard by device_id
        const deviceId = await extractDeviceIdFromRequest(request);
        stub = getAttestationShard(env, deviceId);
      }

      const doResponse = await stub.fetch(request);
      const response = new Response(doResponse.body, doResponse);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return addRateLimitHeaders(response);
    }

    // TUF metadata endpoints — forward to TufMetadataDO
    if (url.pathname.startsWith('/tuf/')) {
      if (!env.TUF_METADATA) {
        const response = new Response(
          JSON.stringify({ error: 'TUF metadata not configured' }),
          { status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
        return addRateLimitHeaders(response);
      }

      const tufStub = env.TUF_METADATA.get(env.TUF_METADATA.idFromName('global'));
      const doResponse = await tufStub.fetch(request);
      const response = new Response(doResponse.body, doResponse);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return addRateLimitHeaders(response);
    }

    // Default - not found
    const notFoundResponse = new Response(
      JSON.stringify({
        error: 'Not Found',
        hint: 'Use GET /servers to list VPS servers',
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
        },
      }
    );
    return addRateLimitHeaders(notFoundResponse);
  },
};
