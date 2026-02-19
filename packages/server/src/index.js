/**
 * Zajel Bootstrap Server - Cloudflare Worker
 *
 * A server registry and attestation authority for the Zajel infrastructure.
 *
 * Endpoints:
 * - POST /servers - Register a VPS server
 * - GET /servers - List all active VPS servers
 * - DELETE /servers/:id - Unregister a server
 * - POST /servers/heartbeat - Keep-alive for registered servers
 * - POST /attest/register - Register a device with a build token
 * - POST /attest/upload-reference - CI uploads reference binary metadata
 * - POST /attest/challenge - Request an attestation challenge
 * - POST /attest/verify - Verify attestation challenge responses
 * - GET /attest/versions - Get version policy
 * - POST /attest/versions - Update version policy (admin)
 */

import { importSigningKey, signPayload } from './crypto/signing.js';
import { getCorsHeaders } from './cors.js';
import { rateLimiter } from './rate-limiter.js';

export { ServerRegistryDO } from './durable-objects/server-registry-do.js';
export { AttestationRegistryDO } from './durable-objects/attestation-registry-do.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request, env);

    // Rate limiting: 100 requests per minute per IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { allowed } = rateLimiter.check(ip, 100, 60000);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: 'Too Many Requests' }),
        { status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Periodically prune stale rate limit entries (every ~100 requests)
    if (Math.random() < 0.01) {
      rateLimiter.prune();
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(
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
    }

    // API info
    if (url.pathname === '/' || url.pathname === '/api/info') {
      return new Response(
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
    }

    // GET /servers — fetch from DO, add timestamp, and sign the response
    if (url.pathname === '/servers' && request.method === 'GET') {
      // TODO: Single global instance - acceptable for current scale.
      // Consider sharding by region when request volume grows.
      const id = env.SERVER_REGISTRY.idFromName('global');
      const stub = env.SERVER_REGISTRY.get(id);
      const doResponse = await stub.fetch(request);
      const data = await doResponse.json();

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

      return new Response(body, { headers });
    }

    // All other /servers/* routes go to the ServerRegistry Durable Object
    if (url.pathname.startsWith('/servers')) {
      // TODO: Single global instance - acceptable for current scale.
      // Consider sharding by region when request volume grows.
      const id = env.SERVER_REGISTRY.idFromName('global');
      const stub = env.SERVER_REGISTRY.get(id);
      const doResponse = await stub.fetch(request);
      const response = new Response(doResponse.body, doResponse);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    }

    // All /attest/* routes go to the AttestationRegistry Durable Object
    if (url.pathname.startsWith('/attest')) {
      // TODO: Single global instance - acceptable for current scale.
      // Consider sharding by device_id prefix when request volume grows.
      const id = env.ATTESTATION_REGISTRY.idFromName('global');
      const stub = env.ATTESTATION_REGISTRY.get(id);
      const doResponse = await stub.fetch(request);
      const response = new Response(doResponse.body, doResponse);
      for (const [key, value] of Object.entries(corsHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    }

    // Default - not found
    return new Response(
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
  },
};
