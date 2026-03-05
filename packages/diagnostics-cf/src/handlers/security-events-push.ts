/**
 * POST /diagnostics/security-events — Security events push handler.
 *
 * Accepts batched security events from VPS servers and stores
 * them in the D1 security_events table. Authenticated via a shared
 * secret (server-to-server, not JWT).
 *
 * Also performs cleanup of rows older than 30 days on each push
 * to keep the table size bounded.
 */

import type { Env, ApiResponse } from '../types.js';

/** Maximum age for security event rows (30 days in milliseconds). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum request body size for security events push (64 KB). */
const MAX_PUSH_BODY_SIZE = 64 * 1024;

/** Maximum number of events per push (prevent abuse). */
const MAX_EVENTS_PER_PUSH = 100;

/**
 * A single security event from a VPS server.
 */
export interface SecurityEventPush {
  eventType: string;
  timestamp: number;
  serverId: string;
  region?: string;
  sourceIp?: string;
  endpoint?: string;
  details?: string;
  severity?: string;
  count?: number;
}

/**
 * The payload for the security events push.
 */
export interface SecurityEventsPushPayload {
  serverId: string;
  events: SecurityEventPush[];
}

/**
 * Validate the security events push payload.
 */
export function validateSecurityEventsPush(
  body: unknown,
): { valid: true; data: SecurityEventsPushPayload } | { valid: false; error: string } {
  if (body === null || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  if (!obj['serverId'] || typeof obj['serverId'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: serverId' };
  }

  if (!Array.isArray(obj['events'])) {
    return { valid: false, error: 'Missing or invalid field: events (must be an array)' };
  }

  const events = obj['events'] as unknown[];

  if (events.length === 0) {
    return { valid: false, error: 'events array must not be empty' };
  }

  if (events.length > MAX_EVENTS_PER_PUSH) {
    return { valid: false, error: `Too many events: max ${MAX_EVENTS_PER_PUSH} per push` };
  }

  const validEventTypes = [
    'rate_limit_violation',
    'connection_spike',
    'bad_client',
    'brute_force_attempt',
  ];

  const validSeverities = ['low', 'medium', 'high', 'critical'];

  const validatedEvents: SecurityEventPush[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event === null || typeof event !== 'object') {
      return { valid: false, error: `events[${i}] must be an object` };
    }

    const e = event as Record<string, unknown>;

    if (!e['eventType'] || typeof e['eventType'] !== 'string') {
      return { valid: false, error: `events[${i}].eventType is required and must be a string` };
    }

    if (!validEventTypes.includes(e['eventType'] as string)) {
      return { valid: false, error: `events[${i}].eventType must be one of: ${validEventTypes.join(', ')}` };
    }

    if (typeof e['timestamp'] !== 'number' || e['timestamp'] <= 0) {
      return { valid: false, error: `events[${i}].timestamp is required and must be a positive number` };
    }

    const severity = e['severity'] as string | undefined;
    if (severity !== undefined && !validSeverities.includes(severity)) {
      return { valid: false, error: `events[${i}].severity must be one of: ${validSeverities.join(', ')}` };
    }

    const count = e['count'] as number | undefined;
    if (count !== undefined && (typeof count !== 'number' || count < 1)) {
      return { valid: false, error: `events[${i}].count must be a positive number` };
    }

    validatedEvents.push({
      eventType: e['eventType'] as string,
      timestamp: e['timestamp'] as number,
      serverId: (e['serverId'] as string) || (obj['serverId'] as string),
      region: (e['region'] as string) || undefined,
      sourceIp: (e['sourceIp'] as string) || undefined,
      endpoint: (e['endpoint'] as string) || undefined,
      details: typeof e['details'] === 'string'
        ? e['details']
        : typeof e['details'] === 'object' && e['details'] !== null
          ? JSON.stringify(e['details'])
          : undefined,
      severity: severity || 'medium',
      count: count || 1,
    });
  }

  return {
    valid: true,
    data: {
      serverId: obj['serverId'] as string,
      events: validatedEvents,
    },
  };
}

/**
 * Handle POST /diagnostics/security-events request.
 */
export async function handleSecurityEventsPush(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Authenticate via shared secret
  if (!env.SERVER_METRICS_SECRET) {
    return jsonResponse(
      { success: false, error: 'Security events ingestion not configured' },
      503,
    );
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.SERVER_METRICS_SECRET}`) {
    return jsonResponse(
      { success: false, error: 'Unauthorized' },
      401,
    );
  }

  // Check content length
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_PUSH_BODY_SIZE) {
    return jsonResponse(
      { success: false, error: 'Request body too large' },
      413,
    );
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid JSON body' },
      400,
    );
  }

  // Validate
  const validation = validateSecurityEventsPush(body);
  if (!validation.valid) {
    return jsonResponse(
      { success: false, error: validation.error },
      400,
    );
  }

  const data = validation.data;

  // Insert all events into D1 using a batch
  try {
    const stmts = data.events.map((event) =>
      env.DB.prepare(
        `INSERT INTO security_events (
          event_type, timestamp, server_id, region,
          source_ip, endpoint, details, severity, count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.eventType,
        event.timestamp,
        event.serverId,
        event.region ?? null,
        event.sourceIp ?? null,
        event.endpoint ?? null,
        event.details ?? null,
        event.severity ?? 'medium',
        event.count ?? 1,
      ),
    );

    await env.DB.batch(stmts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Failed to insert security events:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to store security events' },
      500,
    );
  }

  // Cleanup old rows (fire-and-forget via waitUntil)
  const cutoffMs = Date.now() - RETENTION_MS;
  ctx.waitUntil(
    env.DB.prepare(
      'DELETE FROM security_events WHERE timestamp < ?',
    )
      .bind(cutoffMs)
      .run()
      .catch((err) => {
        console.error('Security events cleanup error:', err);
      }),
  );

  return jsonResponse(
    { success: true, data: { received: data.events.length } },
    200,
  );
}

/**
 * JSON response helper.
 */
function jsonResponse<T>(
  body: ApiResponse<T>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
