/**
 * AuditLog Durable Object - Append-only audit trail.
 *
 * Stores all registry mutations (registration, deregistration, heartbeat,
 * revocation) with timestamps and source identifiers.
 *
 * Security features:
 * - Internal auth token on POST to prevent arbitrary event injection
 * - Automatic log rotation (events older than 90 days are purged)
 * - Admin-authenticated read access
 */

import { getCorsHeaders } from '../cors.js';
import { createLogger } from '../logger.js';
import { timingSafeEqual } from '../crypto/timing-safe.js';

/**
 * Maximum age of audit log events before automatic rotation (90 days).
 */
const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How often to run log rotation (every 1000 events).
 */
const ROTATION_INTERVAL = 1000;

export class AuditLogDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.logger = createLogger(env);
  }

  /**
   * Verify admin authentication for read access.
   */
  async verifyAdminAuth(request) {
    const authHeader = request.headers.get('Authorization');
    if (!this.env.AUDIT_LOG_SECRET) return false;
    if (!authHeader) return false;
    return await timingSafeEqual(authHeader, `Bearer ${this.env.AUDIT_LOG_SECRET}`);
  }

  /**
   * Verify internal auth token for write access.
   * Prevents arbitrary event injection from within the Worker.
   */
  async verifyInternalAuth(request) {
    if (!this.env.AUDIT_LOG_INTERNAL_TOKEN) return true; // Allow if not configured (backward compat)
    const token = request.headers.get('X-Internal-Token');
    if (!token) return false;
    return await timingSafeEqual(token, this.env.AUDIT_LOG_INTERNAL_TOKEN);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, this.env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /log - Append audit event (internal only, with auth token)
    if (request.method === 'POST' && url.pathname === '/log') {
      if (!(await this.verifyInternalAuth(request))) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized - invalid internal token' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      return await this.appendEvent(request, corsHeaders);
    }

    // GET /log - Read audit log (admin only)
    if (request.method === 'GET' && url.pathname === '/log') {
      if (!(await this.verifyAdminAuth(request))) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      return await this.readLog(request, corsHeaders);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  }

  async appendEvent(request, corsHeaders) {
    const body = await request.json();
    const { action, serverId, timestamp, metadata } = body;

    if (!action || !timestamp) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: action, timestamp' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }

    // Generate sequential event ID
    const counter = (await this.state.storage.get('event_counter')) || 0;
    const eventId = counter + 1;
    await this.state.storage.put('event_counter', eventId);

    // Store event with sequential key for ordered retrieval
    const eventKey = `event:${String(eventId).padStart(12, '0')}`;
    const event = {
      eventId,
      action,
      serverId,
      timestamp,
      metadata: metadata || {},
    };

    await this.state.storage.put(eventKey, event);

    this.logger.info('[audit] Event logged', { eventId, action, serverId });

    // Run log rotation periodically
    if (eventId % ROTATION_INTERVAL === 0) {
      await this.rotateOldEvents();
    }

    return new Response(
      JSON.stringify({ success: true, eventId }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  async readLog(request, corsHeaders) {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const action = url.searchParams.get('action');
    const serverId = url.searchParams.get('serverId');

    // List all events
    const allEvents = await this.state.storage.list({ prefix: 'event:' });
    let events = Array.from(allEvents.values());

    // Filter by action or serverId if provided
    if (action) {
      events = events.filter(e => e.action === action);
    }
    if (serverId) {
      events = events.filter(e => e.serverId === serverId);
    }

    // Sort by eventId descending (most recent first)
    events.sort((a, b) => b.eventId - a.eventId);

    // Pagination
    const total = events.length;
    const paginatedEvents = events.slice(offset, offset + limit);

    return new Response(
      JSON.stringify({
        events: paginatedEvents,
        total,
        limit,
        offset,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
    );
  }

  /**
   * Rotate (delete) audit log events older than LOG_RETENTION_MS (90 days).
   * Called periodically during appendEvent.
   */
  async rotateOldEvents() {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const allEvents = await this.state.storage.list({ prefix: 'event:' });
    const keysToDelete = [];

    for (const [key, event] of allEvents) {
      if (event.timestamp < cutoff) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      // Durable Objects support batch delete up to 128 keys at a time
      const batchSize = 128;
      for (let i = 0; i < keysToDelete.length; i += batchSize) {
        const batch = keysToDelete.slice(i, i + batchSize);
        await this.state.storage.delete(batch);
      }
      this.logger.info('[audit] Rotated old events', { deletedCount: keysToDelete.length });
    }
  }
}
