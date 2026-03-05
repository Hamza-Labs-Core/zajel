/**
 * POST /diagnostics/server-logs — Server logs push handler.
 *
 * Accepts batched log entries from VPS servers and stores
 * them in the D1 server_logs table. Authenticated via a shared
 * secret (server-to-server, not JWT).
 *
 * Also performs cleanup of rows older than 7 days on each push
 * to keep the table size bounded.
 */

import type { Env, ApiResponse } from '../types.js';

/** Maximum age for server log rows (7 days in milliseconds). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum request body size for log push (128 KB). */
const MAX_PUSH_BODY_SIZE = 128 * 1024;

/** Maximum number of log entries per push (prevent abuse). */
const MAX_ENTRIES_PER_PUSH = 200;

/**
 * A single server log entry from a VPS server.
 */
export interface ServerLogPushEntry {
  timestamp: number;
  severity: string;
  category: string;
  message: string;
  metadata?: string;
}

/**
 * The payload for the server logs push.
 */
export interface ServerLogsPushPayload {
  serverId: string;
  entries: ServerLogPushEntry[];
}

/**
 * Validate the server logs push payload.
 */
export function validateServerLogsPush(
  body: unknown,
): { valid: true; data: ServerLogsPushPayload } | { valid: false; error: string } {
  if (body === null || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  if (!obj['serverId'] || typeof obj['serverId'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: serverId' };
  }

  if (!Array.isArray(obj['entries'])) {
    return { valid: false, error: 'Missing or invalid field: entries (must be an array)' };
  }

  const entries = obj['entries'] as unknown[];

  if (entries.length === 0) {
    return { valid: false, error: 'entries array must not be empty' };
  }

  if (entries.length > MAX_ENTRIES_PER_PUSH) {
    return { valid: false, error: `Too many entries: max ${MAX_ENTRIES_PER_PUSH} per push` };
  }

  const validSeverities = ['debug', 'info', 'warn', 'error', 'critical'];

  const validatedEntries: ServerLogPushEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === null || typeof entry !== 'object') {
      return { valid: false, error: `entries[${i}] must be an object` };
    }

    const e = entry as Record<string, unknown>;

    if (typeof e['timestamp'] !== 'number' || e['timestamp'] <= 0) {
      return { valid: false, error: `entries[${i}].timestamp is required and must be a positive number` };
    }

    if (!e['severity'] || typeof e['severity'] !== 'string') {
      return { valid: false, error: `entries[${i}].severity is required` };
    }

    if (!validSeverities.includes(e['severity'] as string)) {
      return { valid: false, error: `entries[${i}].severity must be one of: ${validSeverities.join(', ')}` };
    }

    if (!e['category'] || typeof e['category'] !== 'string') {
      return { valid: false, error: `entries[${i}].category is required` };
    }

    if (!e['message'] || typeof e['message'] !== 'string') {
      return { valid: false, error: `entries[${i}].message is required` };
    }

    validatedEntries.push({
      timestamp: e['timestamp'] as number,
      severity: e['severity'] as string,
      category: e['category'] as string,
      message: e['message'] as string,
      metadata: typeof e['metadata'] === 'string'
        ? e['metadata']
        : typeof e['metadata'] === 'object' && e['metadata'] !== null
          ? JSON.stringify(e['metadata'])
          : undefined,
    });
  }

  return {
    valid: true,
    data: {
      serverId: obj['serverId'] as string,
      entries: validatedEntries,
    },
  };
}

/**
 * Handle POST /diagnostics/server-logs request.
 */
export async function handleServerLogsPush(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Authenticate via shared secret
  if (!env.SERVER_METRICS_SECRET) {
    return jsonResponse(
      { success: false, error: 'Server logs ingestion not configured' },
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
  const validation = validateServerLogsPush(body);
  if (!validation.valid) {
    return jsonResponse(
      { success: false, error: validation.error },
      400,
    );
  }

  const data = validation.data;

  // Insert all entries into D1 using a batch
  try {
    const stmts = data.entries.map((entry) =>
      env.DB.prepare(
        `INSERT INTO server_logs (
          server_id, timestamp, severity, category, message, metadata
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        data.serverId,
        entry.timestamp,
        entry.severity,
        entry.category,
        entry.message,
        entry.metadata ?? null,
      ),
    );

    await env.DB.batch(stmts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Failed to insert server logs:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to store server logs' },
      500,
    );
  }

  // Cleanup old rows (fire-and-forget via waitUntil)
  const cutoffMs = Date.now() - RETENTION_MS;
  ctx.waitUntil(
    env.DB.prepare(
      'DELETE FROM server_logs WHERE timestamp < ?',
    )
      .bind(cutoffMs)
      .run()
      .catch((err) => {
        console.error('Server logs cleanup error:', err);
      }),
  );

  return jsonResponse(
    { success: true, data: { received: data.entries.length } },
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
