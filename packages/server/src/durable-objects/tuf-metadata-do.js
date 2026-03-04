/**
 * TUF Metadata Durable Object
 *
 * Stores signed TUF metadata files (root, targets, snapshot, timestamp).
 * Ensures atomic updates and version monotonicity.
 */

import { getCorsHeaders } from '../cors.js';
import { createLogger } from '../logger.js';
import { isExpired } from '../crypto/tuf/metadata.js';

export class TufMetadataDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // GET /tuf/root.json
      if (request.method === 'GET' && url.pathname === '/tuf/root.json') {
        return await this.getMetadata('root', corsHeaders);
      }

      // GET /tuf/targets.json
      if (request.method === 'GET' && url.pathname === '/tuf/targets.json') {
        return await this.getMetadata('targets', corsHeaders);
      }

      // GET /tuf/snapshot.json
      if (request.method === 'GET' && url.pathname === '/tuf/snapshot.json') {
        return await this.getMetadata('snapshot', corsHeaders);
      }

      // GET /tuf/timestamp.json
      if (request.method === 'GET' && url.pathname === '/tuf/timestamp.json') {
        return await this.getMetadata('timestamp', corsHeaders);
      }

      // PUT /tuf/:role - Update metadata (internal use only, requires auth)
      if (request.method === 'PUT' && url.pathname.startsWith('/tuf/')) {
        const role = url.pathname.split('/')[2].replace('.json', '');
        return await this.updateMetadata(role, request, corsHeaders);
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });
    } catch (error) {
      this.logger.error('[tuf-metadata] Unhandled error', error);
      return new Response(
        JSON.stringify({ error: 'Internal server error' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
  }

  async getMetadata(role, corsHeaders) {
    const metadata = await this.state.storage.get(`tuf:${role}`);

    if (!metadata) {
      return new Response(
        JSON.stringify({ error: `${role} metadata not found` }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Warn if metadata is expired (but still serve it for debugging)
    if (isExpired(metadata.signed.expires)) {
      this.logger.warn(`[tuf-metadata] Serving expired ${role} metadata`, {
        role,
        expires: metadata.signed.expires,
        version: metadata.signed.version,
      });
    }

    return new Response(JSON.stringify(metadata), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': role === 'timestamp' ? 'max-age=300' : 'max-age=3600',
      },
    });
  }

  async updateMetadata(role, request, corsHeaders) {
    // Authenticate: require TUF_UPDATE_SECRET (or fall back to SERVER_REGISTRY_SECRET)
    const expectedSecret = this.env.TUF_UPDATE_SECRET || this.env.SERVER_REGISTRY_SECRET;
    if (!expectedSecret) {
      this.logger.error('[tuf-metadata] No TUF_UPDATE_SECRET or SERVER_REGISTRY_SECRET configured');
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration: no update secret' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
      this.logger.warn('[tuf-metadata] Unauthorized metadata update attempt', { role });
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    const newMetadata = await request.json();

    // Validate metadata structure
    if (!newMetadata.signed || !newMetadata.signatures) {
      return new Response(
        JSON.stringify({ error: 'Invalid metadata: missing signed or signatures' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    if (newMetadata.signed._type !== role) {
      return new Response(
        JSON.stringify({ error: `Metadata type mismatch: expected ${role}, got ${newMetadata.signed._type}` }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Enforce version monotonicity
    const current = await this.state.storage.get(`tuf:${role}`);
    if (current && newMetadata.signed.version <= current.signed.version) {
      return new Response(
        JSON.stringify({
          error: `Version rollback detected: current=${current.signed.version}, new=${newMetadata.signed.version}`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    await this.state.storage.put(`tuf:${role}`, newMetadata);

    // Store version history for audit trail (keep last 10 versions)
    const historyKey = `tuf:${role}:history`;
    const history = (await this.state.storage.get(historyKey)) || [];
    history.push({
      version: newMetadata.signed.version,
      expires: newMetadata.signed.expires,
      updatedAt: Date.now(),
    });
    if (history.length > 10) history.shift();
    await this.state.storage.put(historyKey, history);

    this.logger.info(`[tuf-metadata] Updated ${role} metadata`, {
      role,
      version: newMetadata.signed.version,
      expires: newMetadata.signed.expires,
    });

    return new Response(
      JSON.stringify({ success: true, version: newMetadata.signed.version }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }
}
