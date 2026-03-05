/**
 * Notification configuration route handlers (US-8.2, US-8.3)
 *
 * Manages notification channel configuration (email, webhook, dashboard)
 * in the shared DIAGNOSTICS_DB (D1).
 */

import type {
  Env,
  ApiResponse,
  NotificationConfigEntry,
  NotificationConfigData,
  WebhookConfig,
  EmailConfig,
  DashboardConfig,
} from '../types.js';
import { requireAuth, requireSuperAdmin } from './auth.js';
import { dispatchWebhook, dispatchEmail } from './notification-dispatch.js';
import { encryptWebhookConfig, decryptWebhookConfig } from '../crypto.js';

// ─── Helpers ────────────────────────────────────

function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

const VALID_CHANNEL_TYPES = new Set(['email', 'webhook', 'dashboard']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

/**
 * Map a D1 row to a NotificationConfigEntry.
 * If the config is encrypted (prefixed with "enc:"), decrypts it using the provided secret.
 */
async function rowToConfigEntry(
  row: Record<string, unknown>,
  jwtSecret?: string
): Promise<NotificationConfigEntry> {
  let config: WebhookConfig | EmailConfig | DashboardConfig = { soundEnabled: false, severityFilter: [] };
  let rawConfig = row['config'] as string | undefined;

  if (rawConfig && typeof rawConfig === 'string') {
    // Decrypt encrypted webhook configs
    if (rawConfig.startsWith('enc:') && jwtSecret) {
      try {
        rawConfig = await decryptWebhookConfig(rawConfig.slice(4), jwtSecret);
      } catch {
        // Decryption failed — treat as opaque
        rawConfig = undefined;
      }
    }

    if (rawConfig) {
      try {
        config = JSON.parse(rawConfig) as WebhookConfig | EmailConfig | DashboardConfig;
      } catch {
        // Malformed JSON -- use default
      }
    }
  }

  return {
    id: row['id'] as number,
    channelType: row['channel_type'] as 'email' | 'webhook' | 'dashboard',
    enabled: (row['enabled'] as number) === 1,
    config,
    updatedAt: row['updated_at'] as number,
    updatedBy: row['updated_by'] as string,
  };
}

/**
 * Validate email config shape.
 */
function validateEmailConfig(config: unknown): config is EmailConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;

  if (!Array.isArray(c.addresses) || c.addresses.length === 0) return false;
  if (!c.addresses.every((a: unknown) => typeof a === 'string' && a.length > 0)) return false;

  if (!Array.isArray(c.severityFilter)) return false;
  if (!c.severityFilter.every((s: unknown) => typeof s === 'string' && VALID_SEVERITIES.has(s as string))) return false;

  if (typeof c.cooldownMinutes !== 'number' || c.cooldownMinutes < 0) return false;

  return true;
}

/**
 * Validate webhook config shape.
 */
function validateWebhookConfig(config: unknown): config is WebhookConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;

  if (typeof c.url !== 'string' || c.url.length === 0) return false;

  // Validate URL format and enforce HTTPS
  try {
    const parsed = new URL(c.url);
    if (parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  if (c.authHeader !== undefined && typeof c.authHeader !== 'string') return false;

  if (!Array.isArray(c.severityFilter)) return false;
  if (!c.severityFilter.every((s: unknown) => typeof s === 'string' && VALID_SEVERITIES.has(s as string))) return false;

  return true;
}

/**
 * Validate dashboard config shape.
 */
function validateDashboardConfig(config: unknown): config is DashboardConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;

  if (typeof c.soundEnabled !== 'boolean') return false;

  if (!Array.isArray(c.severityFilter)) return false;
  if (!c.severityFilter.every((s: unknown) => typeof s === 'string' && VALID_SEVERITIES.has(s as string))) return false;

  return true;
}

// ─── Handlers ───────────────────────────────────

/**
 * GET /admin/api/notifications/config
 *
 * Returns all notification channel configurations.
 */
export async function handleGetNotificationConfig(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    const emptyData: NotificationConfigData = {
      channels: [],
      lastUpdated: Date.now(),
    };
    return jsonResponse({ success: true, data: emptyData });
  }

  try {
    const result = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, channel_type, enabled, config, updated_at, updated_by
       FROM notification_config
       ORDER BY channel_type ASC
       LIMIT 100`
    ).all();

    const channels: NotificationConfigEntry[] = await Promise.all(
      (result.results || []).map(
        (row) => rowToConfigEntry(row as Record<string, unknown>, env.ZAJEL_ADMIN_JWT_SECRET)
      )
    );

    const data: NotificationConfigData = {
      channels,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to get notification config:', error);
    return jsonResponse(
      { success: false, error: 'Failed to retrieve notification configuration' },
      500
    );
  }
}

/**
 * POST /admin/api/notifications/config
 *
 * Create or update a notification channel configuration.
 * Requires super-admin role.
 */
export async function handleUpdateNotificationConfig(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse(
      { success: true, data: { channel: null, lastUpdated: Date.now() } }
    );
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse(
        { success: false, error: 'Invalid JSON body' },
        400
      );
    }

    const { channelType, enabled, config } = body;

    // Validate channelType
    if (!channelType || typeof channelType !== 'string' || !VALID_CHANNEL_TYPES.has(channelType)) {
      return jsonResponse(
        { success: false, error: 'Invalid channelType. Must be one of: email, webhook, dashboard' },
        400
      );
    }

    // Validate enabled
    if (typeof enabled !== 'boolean') {
      return jsonResponse(
        { success: false, error: 'enabled must be a boolean' },
        400
      );
    }

    // Validate config shape based on channelType
    if (channelType === 'email') {
      if (!validateEmailConfig(config)) {
        return jsonResponse(
          { success: false, error: 'Invalid email config. Required: addresses (non-empty string[]), severityFilter (string[]), cooldownMinutes (number >= 0)' },
          400
        );
      }
    } else if (channelType === 'webhook') {
      if (!validateWebhookConfig(config)) {
        return jsonResponse(
          { success: false, error: 'Invalid webhook config. Required: url (valid URL), severityFilter (string[]). Optional: authHeader (string)' },
          400
        );
      }
    } else if (channelType === 'dashboard') {
      if (!validateDashboardConfig(config)) {
        return jsonResponse(
          { success: false, error: 'Invalid dashboard config. Required: soundEnabled (boolean), severityFilter (string[])' },
          400
        );
      }
    }

    const now = Date.now();
    const username = authResult.username;
    let configJson = JSON.stringify(config);

    // Encrypt webhook config at rest if secret is available
    if (channelType === 'webhook' && env.ZAJEL_ADMIN_JWT_SECRET) {
      const encrypted = await encryptWebhookConfig(configJson, env.ZAJEL_ADMIN_JWT_SECRET);
      configJson = `enc:${encrypted}`;
    }

    // Batch upsert + re-fetch in single roundtrip
    const [, selectResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(
        `INSERT INTO notification_config (channel_type, enabled, config, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_type) DO UPDATE SET
           enabled = excluded.enabled,
           config = excluded.config,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`
      ).bind(channelType, enabled ? 1 : 0, configJson, now, username),
      env.DIAGNOSTICS_DB.prepare(
        `SELECT id, channel_type, enabled, config, updated_at, updated_by
         FROM notification_config WHERE channel_type = ?`
      ).bind(channelType),
    ]);

    const updatedRow = (selectResult as D1Result).results?.[0] ?? null;
    const channel = updatedRow
      ? await rowToConfigEntry(updatedRow as Record<string, unknown>, env.ZAJEL_ADMIN_JWT_SECRET)
      : null;

    return jsonResponse({
      success: true,
      data: { channel, lastUpdated: now },
    });
  } catch (error) {
    console.error('Failed to update notification config:', error);
    return jsonResponse(
      { success: false, error: 'Failed to update notification configuration' },
      500
    );
  }
}

/**
 * POST /admin/api/notifications/test
 *
 * Send a test notification to the specified channel.
 * Requires super-admin role.
 */
export async function handleTestNotification(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse(
      { success: true, data: { sent: false, reason: 'No database configured', lastUpdated: Date.now() } }
    );
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse(
        { success: false, error: 'Invalid JSON body' },
        400
      );
    }

    const { channelType } = body;

    if (!channelType || typeof channelType !== 'string' || !['email', 'webhook'].includes(channelType)) {
      return jsonResponse(
        { success: false, error: 'Invalid channelType. Must be one of: email, webhook' },
        400
      );
    }

    // Fetch the channel config
    const configRow = await env.DIAGNOSTICS_DB.prepare(
      `SELECT id, channel_type, enabled, config, updated_at, updated_by
       FROM notification_config WHERE channel_type = ?`
    ).bind(channelType).first();

    if (!configRow) {
      return jsonResponse(
        { success: false, error: `No configuration found for channel: ${channelType}` },
        404
      );
    }

    const entry = await rowToConfigEntry(configRow as Record<string, unknown>, env.ZAJEL_ADMIN_JWT_SECRET);

    if (!entry.enabled) {
      return jsonResponse(
        { success: false, error: `Channel ${channelType} is disabled` },
        400
      );
    }

    const testPayload = {
      severity: 'info' as const,
      title: 'Test notification',
      message: 'This is a test notification from the Zajel admin dashboard.',
      timestamp: Date.now(),
      dashboardUrl: 'https://admin.zajel.hamzalabs.dev/admin/',
    };

    if (channelType === 'webhook') {
      const webhookConfig = entry.config as WebhookConfig;
      const result = await dispatchWebhook(webhookConfig, testPayload);
      return jsonResponse({
        success: true,
        data: { sent: result.sent, statusCode: result.statusCode, lastUpdated: Date.now() },
      });
    } else if (channelType === 'email') {
      const emailConfig = entry.config as EmailConfig;
      const result = await dispatchEmail(emailConfig, testPayload);
      return jsonResponse({
        success: true,
        data: { sent: result.sent, lastUpdated: Date.now() },
      });
    }

    return jsonResponse(
      { success: false, error: 'Unsupported channel type' },
      400
    );
  } catch (error) {
    console.error('Failed to send test notification:', error);
    return jsonResponse(
      { success: false, error: 'Failed to send test notification' },
      500
    );
  }
}
