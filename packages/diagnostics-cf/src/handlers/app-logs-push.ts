/**
 * POST /diagnostics/app-logs — App logs push handler.
 *
 * Accepts batched log entries from Flutter clients and stores
 * them in the D1 app_logs table. Uses session-based rate limiting
 * (shared with diagnostic reports) and per-session entry rate limiting.
 *
 * Features:
 * - Schema validation (max 500 entries, max 64KB body)
 * - Ingestion dedup: increments count for identical (category, message_hash, session_hash) in same time bucket
 * - Per-session rate limit: max 1000 entries per session per minute (429 if exceeded)
 * - Session rate limit: counts toward existing 10/hour session limit
 */

import type { Env, ApiResponse } from '../types.js';
import { MAX_BODY_SIZE, VALID_PLATFORMS } from '../types.js';
import { checkSessionRateLimit } from '../rate-limit.js';
import { getTimeBucket } from '../aggregation.js';

/** Maximum number of log entries per push. */
const MAX_ENTRIES_PER_PUSH = 500;

/** Maximum entries per session per minute. */
const MAX_ENTRIES_PER_SESSION_PER_MINUTE = 1000;

/** Entry rate limit window in seconds (1 minute). */
const ENTRY_RATE_LIMIT_WINDOW = 60;

/** Hex pattern for SHA-256 hash (64 hex characters). */
const SESSION_HASH_PATTERN = /^[0-9a-f]{64}$/i;

/** Valid severity levels for app log entries. */
const VALID_SEVERITIES = ['debug', 'info', 'warn', 'error', 'critical'] as const;

/** Valid environment values. */
const VALID_ENVIRONMENTS = ['production', 'qa'] as const;

/**
 * A single app log entry from a Flutter client.
 */
export interface AppLogEntry {
  timestamp: number;
  severity: string;
  category: string;
  message: string;
  count: number;
}

/**
 * The payload for the app logs push.
 */
export interface AppLogsPushPayload {
  sessionHash: string;
  appVersion: string;
  platform: string;
  environment: string;
  entries: AppLogEntry[];
}

/**
 * Validate the app logs push payload.
 */
export function validateAppLogsPush(
  body: unknown,
): { valid: true; data: AppLogsPushPayload } | { valid: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  // sessionHash
  if (!obj['sessionHash'] || typeof obj['sessionHash'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: sessionHash' };
  }
  if (!SESSION_HASH_PATTERN.test(obj['sessionHash'] as string)) {
    return { valid: false, error: 'sessionHash must be a 64-character hex string (SHA-256)' };
  }

  // appVersion
  if (!obj['appVersion'] || typeof obj['appVersion'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: appVersion' };
  }

  // platform
  if (!obj['platform'] || typeof obj['platform'] !== 'string') {
    return { valid: false, error: 'Missing or invalid field: platform' };
  }
  if (!VALID_PLATFORMS.includes(obj['platform'] as typeof VALID_PLATFORMS[number])) {
    return { valid: false, error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}` };
  }

  // environment (optional, defaults to 'production')
  let environment = 'production';
  if (obj['environment'] !== undefined && obj['environment'] !== null) {
    if (typeof obj['environment'] !== 'string') {
      return { valid: false, error: 'environment must be a string' };
    }
    if (!VALID_ENVIRONMENTS.includes(obj['environment'] as typeof VALID_ENVIRONMENTS[number])) {
      return { valid: false, error: `environment must be one of: ${VALID_ENVIRONMENTS.join(', ')}` };
    }
    environment = obj['environment'] as string;
  }

  // entries
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

  const validatedEntries: AppLogEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, error: `entries[${i}] must be an object` };
    }

    const e = entry as Record<string, unknown>;

    if (typeof e['timestamp'] !== 'number' || e['timestamp'] <= 0) {
      return { valid: false, error: `entries[${i}].timestamp is required and must be a positive number` };
    }

    if (!e['severity'] || typeof e['severity'] !== 'string') {
      return { valid: false, error: `entries[${i}].severity is required` };
    }
    if (!VALID_SEVERITIES.includes(e['severity'] as typeof VALID_SEVERITIES[number])) {
      return { valid: false, error: `entries[${i}].severity must be one of: ${VALID_SEVERITIES.join(', ')}` };
    }

    if (!e['category'] || typeof e['category'] !== 'string') {
      return { valid: false, error: `entries[${i}].category is required` };
    }

    if (!e['message'] || typeof e['message'] !== 'string') {
      return { valid: false, error: `entries[${i}].message is required` };
    }

    // count defaults to 1
    let count = 1;
    if (e['count'] !== undefined && e['count'] !== null) {
      if (typeof e['count'] !== 'number' || !Number.isFinite(e['count']) || e['count'] < 1) {
        return { valid: false, error: `entries[${i}].count must be a positive number` };
      }
      count = Math.floor(e['count'] as number);
    }

    validatedEntries.push({
      timestamp: e['timestamp'] as number,
      severity: e['severity'] as string,
      category: e['category'] as string,
      message: e['message'] as string,
      count,
    });
  }

  return {
    valid: true,
    data: {
      sessionHash: obj['sessionHash'] as string,
      appVersion: obj['appVersion'] as string,
      platform: obj['platform'] as string,
      environment,
      entries: validatedEntries,
    },
  };
}

/**
 * Compute a simple hash of a message for dedup purposes.
 * Uses a fast string hash (FNV-1a 32-bit) to avoid crypto overhead.
 */
function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Check per-session entry rate limit (max entries per minute).
 * Uses KV with TTL.
 */
async function checkEntryRateLimit(
  env: Env,
  sessionHash: string,
  entryCount: number,
): Promise<{ allowed: boolean; error?: string }> {
  const key = `erl:${sessionHash}`;

  try {
    const existing = await env.RATE_LIMIT_KV.get(key, 'json') as {
      count: number;
      windowStart: number;
    } | null;

    const now = Date.now();

    if (!existing || now - existing.windowStart > ENTRY_RATE_LIMIT_WINDOW * 1000) {
      // New window
      await env.RATE_LIMIT_KV.put(
        key,
        JSON.stringify({ count: entryCount, windowStart: now }),
        { expirationTtl: ENTRY_RATE_LIMIT_WINDOW },
      );
      return { allowed: entryCount <= MAX_ENTRIES_PER_SESSION_PER_MINUTE };
    }

    const newCount = existing.count + entryCount;

    if (newCount > MAX_ENTRIES_PER_SESSION_PER_MINUTE) {
      return {
        allowed: false,
        error: `Entry rate limit exceeded. Maximum ${MAX_ENTRIES_PER_SESSION_PER_MINUTE} entries per session per minute.`,
      };
    }

    await env.RATE_LIMIT_KV.put(
      key,
      JSON.stringify({ count: newCount, windowStart: existing.windowStart }),
      { expirationTtl: ENTRY_RATE_LIMIT_WINDOW },
    );
    return { allowed: true };
  } catch {
    // Fail open
    console.error('Entry rate limiter error');
    return { allowed: true };
  }
}

/**
 * Handle POST /diagnostics/app-logs request.
 */
export async function handleAppLogsPush(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Check Content-Type
  const contentType = request.headers.get('Content-Type');
  if (!contentType || !contentType.includes('application/json')) {
    return jsonResponse(
      { success: false, error: 'Content-Type must be application/json' },
      400,
    );
  }

  // Check body size via Content-Length header
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return jsonResponse(
      { success: false, error: `Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes` },
      413,
    );
  }

  // Read and parse body with size limit
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse(
      { success: false, error: 'Failed to read request body' },
      400,
    );
  }

  // Double-check actual body size
  if (new TextEncoder().encode(bodyText).length > MAX_BODY_SIZE) {
    return jsonResponse(
      { success: false, error: `Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes` },
      413,
    );
  }

  // Parse JSON
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid JSON body' },
      400,
    );
  }

  // Validate
  const validation = validateAppLogsPush(body);
  if (!validation.valid) {
    return jsonResponse(
      { success: false, error: validation.error },
      400,
    );
  }

  const data = validation.data;

  // Per-session rate limit (shared with diagnostic reports, counts toward 10/hour)
  const sessionLimit = await checkSessionRateLimit(env, data.sessionHash);
  if (!sessionLimit.allowed) {
    return jsonResponse(
      { success: false, error: sessionLimit.error ?? 'Rate limit exceeded' },
      429,
    );
  }

  // Per-session entry rate limit (max 1000 entries per minute)
  const entryLimit = await checkEntryRateLimit(env, data.sessionHash, data.entries.length);
  if (!entryLimit.allowed) {
    return jsonResponse(
      { success: false, error: entryLimit.error ?? 'Entry rate limit exceeded' },
      429,
    );
  }

  // Insert entries into D1 with dedup
  try {
    await insertWithDedup(env.DB, data);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Failed to insert app logs:', errMsg);
    return jsonResponse(
      { success: false, error: 'Failed to store app logs' },
      500,
    );
  }

  return jsonResponse(
    { success: true, data: { received: data.entries.length } },
    200,
  );
}

/**
 * Insert app log entries with dedup.
 *
 * For each entry, compute a message_hash and check if an identical
 * (category, message_hash, session_hash) tuple exists in the current
 * time bucket. If so, increment its count; otherwise insert a new row.
 */
async function insertWithDedup(
  db: D1Database,
  data: AppLogsPushPayload,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];

  for (const entry of data.entries) {
    const messageHash = simpleHash(entry.message);
    const timeBucket = getTimeBucket(entry.timestamp);

    // Use INSERT ... ON CONFLICT for atomic dedup.
    // We use a combination approach: try to UPDATE first, then INSERT if no match.
    // Since D1/SQLite doesn't have a convenient upsert on non-unique columns,
    // we do a conditional INSERT with a subquery check.
    statements.push(
      db
        .prepare(
          `INSERT INTO app_logs (
            session_hash, app_version, platform, environment,
            timestamp, severity, category, message, message_hash, count
          )
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
          WHERE NOT EXISTS (
            SELECT 1 FROM app_logs
            WHERE session_hash = ?1
              AND category = ?7
              AND message_hash = ?9
              AND timestamp >= ?11
              AND timestamp < ?12
          )`,
        )
        .bind(
          data.sessionHash,
          data.appVersion,
          data.platform,
          data.environment,
          entry.timestamp,
          entry.severity,
          entry.category,
          entry.message,
          messageHash,
          entry.count,
          // Time bucket boundaries (1 hour)
          new Date(timeBucket).getTime(),
          new Date(timeBucket).getTime() + 3600000,
        ),
    );

    // Also try to update existing row count if it exists
    statements.push(
      db
        .prepare(
          `UPDATE app_logs
           SET count = count + ?1
           WHERE session_hash = ?2
             AND category = ?3
             AND message_hash = ?4
             AND timestamp >= ?5
             AND timestamp < ?6`,
        )
        .bind(
          entry.count,
          data.sessionHash,
          entry.category,
          messageHash,
          new Date(timeBucket).getTime(),
          new Date(timeBucket).getTime() + 3600000,
        ),
    );
  }

  await db.batch(statements);
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
