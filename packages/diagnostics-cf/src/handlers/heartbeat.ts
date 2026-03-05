/**
 * POST /diagnostics/heartbeat — Client heartbeat handler.
 *
 * Accepts an anonymous heartbeat from Flutter clients, validates the body,
 * checks the rate limit (1 per session per 5 minutes via D1 last_seen),
 * then UPSERTs the D1 row and updates KV counters.
 */

import type { Env, HeartbeatRequest, ApiResponse, HeartbeatResponseData } from '../types.js';
import { VALID_PLATFORMS, VALID_CONNECTION_TYPES } from '../types.js';
import { updateHeartbeatCounters } from '../counters.js';

/** Minimum interval between heartbeats for a given session (5 minutes). */
const HEARTBEAT_INTERVAL_MS = 300_000;

/** Regular expression for a 64-character lowercase hex string (SHA-256). */
const SESSION_HASH_REGEX = /^[0-9a-f]{64}$/;

/** Semver-ish regex: digits.digits.digits with optional pre-release. */
const SEMVER_REGEX = /^\d+\.\d+\.\d+/;

/**
 * Validate the heartbeat request body. Returns null on success or
 * an error message string on validation failure.
 */
export function validateHeartbeatRequest(
  body: unknown,
): { valid: true; data: HeartbeatRequest } | { valid: false; error: string } {
  if (body === null || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  // sessionHash
  if (!obj['sessionHash'] || typeof obj['sessionHash'] !== 'string') {
    return { valid: false, error: 'Missing required field: sessionHash' };
  }
  if (!SESSION_HASH_REGEX.test(obj['sessionHash'])) {
    return {
      valid: false,
      error: 'sessionHash must be a 64-character lowercase hex string',
    };
  }

  // platform
  if (!obj['platform'] || typeof obj['platform'] !== 'string') {
    return { valid: false, error: 'Missing required field: platform' };
  }
  if (!(VALID_PLATFORMS as readonly string[]).includes(obj['platform'])) {
    return {
      valid: false,
      error: `Invalid platform value: ${obj['platform']}. Must be one of: ${VALID_PLATFORMS.join(', ')}`,
    };
  }

  // appVersion
  if (!obj['appVersion'] || typeof obj['appVersion'] !== 'string') {
    return { valid: false, error: 'Missing required field: appVersion' };
  }
  if (!SEMVER_REGEX.test(obj['appVersion'])) {
    return {
      valid: false,
      error: 'appVersion must be a valid semver string (e.g., "1.2.3")',
    };
  }

  // connectionType (optional)
  if (obj['connectionType'] !== undefined && obj['connectionType'] !== null) {
    if (typeof obj['connectionType'] !== 'string') {
      return { valid: false, error: 'connectionType must be a string' };
    }
    if (
      !(VALID_CONNECTION_TYPES as readonly string[]).includes(
        obj['connectionType'],
      )
    ) {
      return {
        valid: false,
        error: `Invalid connectionType value: ${obj['connectionType']}. Must be one of: ${VALID_CONNECTION_TYPES.join(', ')}`,
      };
    }
  }

  return {
    valid: true,
    data: {
      sessionHash: obj['sessionHash'] as string,
      platform: obj['platform'] as HeartbeatRequest['platform'],
      appVersion: obj['appVersion'] as string,
      connectionType: obj['connectionType'] as
        | HeartbeatRequest['connectionType']
        | undefined,
    },
  };
}

/**
 * Handle a POST /diagnostics/heartbeat request.
 */
export async function handleHeartbeat(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Parse the JSON body
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
  const validation = validateHeartbeatRequest(body);
  if (!validation.valid) {
    return jsonResponse(
      { success: false, error: validation.error },
      400,
    );
  }

  const { sessionHash, platform, appVersion, connectionType } = validation.data;
  const now = Date.now();

  // Rate limiting: check D1 last_seen timestamp
  const existing = await env.DB.prepare(
    'SELECT last_seen FROM client_heartbeats WHERE session_hash = ?',
  )
    .bind(sessionHash)
    .first<{ last_seen: number }>();

  if (existing) {
    const elapsed = now - existing.last_seen;
    if (elapsed < HEARTBEAT_INTERVAL_MS) {
      const retryAfterSeconds = Math.ceil(
        (HEARTBEAT_INTERVAL_MS - elapsed) / 1000,
      );
      return jsonResponse(
        {
          success: false,
          error: `Heartbeat too frequent. Next allowed in ${retryAfterSeconds} seconds.`,
        },
        429,
      );
    }
  }

  // Derive region from CF request metadata
  const region =
    (request.cf as { colo?: string } | undefined)?.colo ??
    request.headers.get('CF-IPCountry') ??
    'unknown';

  // D1 UPSERT: preserve session_start on conflict, update other fields
  const upsertPromise = env.DB.prepare(
    `INSERT INTO client_heartbeats (session_hash, platform, app_version, connection_type, region, last_seen, session_start)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_hash) DO UPDATE SET
       last_seen = excluded.last_seen,
       connection_type = excluded.connection_type,
       app_version = excluded.app_version,
       region = excluded.region`,
  )
    .bind(
      sessionHash,
      platform,
      appVersion,
      connectionType ?? null,
      region,
      now,
      now,
    )
    .run();

  // KV counter updates
  const counterPromise = updateHeartbeatCounters(
    env.RATE_LIMIT_KV,
    platform,
    appVersion,
    connectionType,
  );

  // Fire both writes via waitUntil so the response is sent immediately
  ctx.waitUntil(
    Promise.all([upsertPromise, counterPromise]).catch((err) => {
      console.error('Heartbeat background write error:', err);
    }),
  );

  return jsonResponse<HeartbeatResponseData>(
    {
      success: true,
      data: { nextHeartbeatMs: HEARTBEAT_INTERVAL_MS },
    },
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
