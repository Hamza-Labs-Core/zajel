/**
 * Alert Rule Management route handlers
 * CRUD operations for alert rules stored in D1 (DIAGNOSTICS_DB)
 */

import type {
  Env,
  ApiResponse,
  AlertRule,
  AlertRuleData,
  AlertRuleCreateRequest,
  AlertRuleUpdateRequest,
  AlertRulesListData,
  AlertConditionType,
  AlertSeverity,
  AlertThresholdUnit,
  AlertChannel,
} from '../types.js';
import { requireAuth, requireSuperAdmin } from './auth.js';

/** Valid condition types */
const VALID_CONDITION_TYPES: AlertConditionType[] = [
  'error_rate',
  'server_offline',
  'attack_detected',
  'ai_issue',
  'error_spike',
  'error_rate_spike',
  'rate_limit_violations',
  'high_latency',
  'low_success_rate',
  'disk_usage_high',
  'memory_usage_high',
  'new_critical_crash',
];

/** Valid severity levels */
const VALID_SEVERITIES: AlertSeverity[] = ['info', 'warning', 'critical'];

/** Valid threshold units */
const VALID_THRESHOLD_UNITS: AlertThresholdUnit[] = ['per_hour', 'minutes', 'multiplier', 'percent', 'ms'];

/** Valid notification channels */
const VALID_CHANNELS: AlertChannel[] = ['dashboard', 'email', 'webhook'];

/**
 * Convert a D1 row to the API response format (camelCase)
 */
function toAlertRuleData(row: AlertRule): AlertRuleData {
  let channels: AlertChannel[] = [];
  try {
    channels = JSON.parse(row.channels);
  } catch {
    channels = [];
  }
  return {
    id: row.id,
    name: row.name,
    conditionType: row.condition_type,
    thresholdValue: row.threshold_value,
    thresholdUnit: row.threshold_unit,
    severity: row.severity,
    channels,
    enabled: row.enabled === 1,
    cooldownMinutes: row.cooldown_minutes,
    isDefault: row.is_default === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastTriggeredAt: row.last_triggered_at,
  };
}

/**
 * Validate channels array
 */
function validateChannels(channels: unknown): channels is AlertChannel[] {
  if (!Array.isArray(channels)) return false;
  if (channels.length === 0) return false;
  return channels.every((ch) => VALID_CHANNELS.includes(ch as AlertChannel));
}

/**
 * List all alert rules
 * GET /admin/api/alerts/rules
 */
export async function handleListAlertRules(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({
      success: true,
      data: { rules: [], total: 0 } as AlertRulesListData,
    });
  }

  try {
    const url = new URL(request.url);
    const enabledFilter = url.searchParams.get('enabled');

    let query: string;
    let params: unknown[];

    if (enabledFilter === '0' || enabledFilter === '1') {
      query = 'SELECT * FROM alert_rules WHERE enabled = ? ORDER BY created_at DESC LIMIT 200';
      params = [parseInt(enabledFilter, 10)];
    } else {
      query = 'SELECT * FROM alert_rules ORDER BY created_at DESC LIMIT 200';
      params = [];
    }

    let countQuery: string;
    let countParams: unknown[];
    if (enabledFilter === '0' || enabledFilter === '1') {
      countQuery = 'SELECT COUNT(*) as count FROM alert_rules WHERE enabled = ?';
      countParams = [parseInt(enabledFilter, 10)];
    } else {
      countQuery = 'SELECT COUNT(*) as count FROM alert_rules';
      countParams = [];
    }

    const [dataResult, countResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(query).bind(...params),
      env.DIAGNOSTICS_DB.prepare(countQuery).bind(...countParams),
    ]);
    const rules = ((dataResult as D1Result<AlertRule>).results || []).map(toAlertRuleData);
    const total = ((countResult as D1Result<{ count: number }>).results?.[0] as { count: number } | undefined)?.count ?? rules.length;

    return jsonResponse({
      success: true,
      data: { rules, total } as AlertRulesListData,
    });
  } catch (error) {
    console.error('Failed to list alert rules:', error);
    return jsonResponse(
      { success: false, error: 'Failed to list alert rules' },
      500
    );
  }
}

/**
 * Get a single alert rule by ID
 * GET /admin/api/alerts/rules/:id
 */
export async function handleGetAlertRule(
  request: Request,
  env: Env,
  ruleId: string
): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
  }

  const id = parseInt(ruleId, 10);
  if (isNaN(id)) {
    return jsonResponse({ success: false, error: 'Invalid rule ID' }, 400);
  }

  try {
    const row = await env.DIAGNOSTICS_DB.prepare(
      'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
    ).bind(id).first<AlertRule>();

    if (!row) {
      return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
    }

    return jsonResponse({
      success: true,
      data: toAlertRuleData(row),
    });
  } catch (error) {
    console.error('Failed to get alert rule:', error);
    return jsonResponse(
      { success: false, error: 'Failed to get alert rule' },
      500
    );
  }
}

/**
 * Create a new alert rule
 * POST /admin/api/alerts/rules
 */
export async function handleCreateAlertRule(
  request: Request,
  env: Env
): Promise<Response> {
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse(
      { success: false, error: 'Diagnostics database not configured' },
      503
    );
  }

  let body: AlertRuleCreateRequest;
  try {
    body = await request.json() as AlertRuleCreateRequest;
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return jsonResponse({ success: false, error: 'Name is required' }, 400);
  }

  if (!body.conditionType || !VALID_CONDITION_TYPES.includes(body.conditionType)) {
    return jsonResponse(
      { success: false, error: `Invalid condition type. Must be one of: ${VALID_CONDITION_TYPES.join(', ')}` },
      400
    );
  }

  if (!body.severity || !VALID_SEVERITIES.includes(body.severity)) {
    return jsonResponse(
      { success: false, error: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}` },
      400
    );
  }

  if (!validateChannels(body.channels)) {
    return jsonResponse(
      { success: false, error: `Invalid channels. Must be a non-empty array of: ${VALID_CHANNELS.join(', ')}` },
      400
    );
  }

  // Validate optional fields
  if (body.thresholdUnit !== undefined && body.thresholdUnit !== null &&
      !VALID_THRESHOLD_UNITS.includes(body.thresholdUnit)) {
    return jsonResponse(
      { success: false, error: `Invalid threshold unit. Must be one of: ${VALID_THRESHOLD_UNITS.join(', ')}` },
      400
    );
  }

  if (body.cooldownMinutes !== undefined) {
    if (typeof body.cooldownMinutes !== 'number' || body.cooldownMinutes < 1) {
      return jsonResponse(
        { success: false, error: 'Cooldown minutes must be a positive number' },
        400
      );
    }
  }

  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1;
  const cooldownMinutes = body.cooldownMinutes ?? 60;
  const now = Date.now();

  try {
    const result = await env.DIAGNOSTICS_DB.prepare(
      `INSERT INTO alert_rules (name, condition_type, threshold_value, threshold_unit, severity, channels, enabled, cooldown_minutes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.name.trim(),
      body.conditionType,
      body.thresholdValue ?? null,
      body.thresholdUnit ?? null,
      body.severity,
      JSON.stringify(body.channels),
      enabled,
      cooldownMinutes,
      authResult.username,
      now,
    ).run();

    // Fetch the created row
    const row = await env.DIAGNOSTICS_DB.prepare(
      'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
    ).bind(result.meta.last_row_id).first<AlertRule>();

    if (!row) {
      return jsonResponse(
        { success: false, error: 'Failed to create alert rule' },
        500
      );
    }

    // Invalidate KV cache
    if (env.ADMIN_KV) {
      await env.ADMIN_KV.delete('alert_rules_cache').catch(() => {});
    }

    return jsonResponse({
      success: true,
      data: toAlertRuleData(row),
    }, 201);
  } catch (error) {
    console.error('Failed to create alert rule:', error);
    return jsonResponse(
      { success: false, error: 'Failed to create alert rule' },
      500
    );
  }
}

/**
 * Update an existing alert rule
 * PUT /admin/api/alerts/rules/:id
 */
export async function handleUpdateAlertRule(
  request: Request,
  env: Env,
  ruleId: string
): Promise<Response> {
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
  }

  const id = parseInt(ruleId, 10);
  if (isNaN(id)) {
    return jsonResponse({ success: false, error: 'Invalid rule ID' }, 400);
  }

  let body: AlertRuleUpdateRequest;
  try {
    body = await request.json() as AlertRuleUpdateRequest;
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  // Check if rule exists
  try {
    const existing = await env.DIAGNOSTICS_DB.prepare(
      'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
    ).bind(id).first<AlertRule>();

    if (!existing) {
      return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
    }

    // Validate provided fields
    if (body.conditionType !== undefined && !VALID_CONDITION_TYPES.includes(body.conditionType)) {
      return jsonResponse(
        { success: false, error: `Invalid condition type. Must be one of: ${VALID_CONDITION_TYPES.join(', ')}` },
        400
      );
    }

    if (body.severity !== undefined && !VALID_SEVERITIES.includes(body.severity)) {
      return jsonResponse(
        { success: false, error: `Invalid severity. Must be one of: ${VALID_SEVERITIES.join(', ')}` },
        400
      );
    }

    if (body.channels !== undefined && !validateChannels(body.channels)) {
      return jsonResponse(
        { success: false, error: `Invalid channels. Must be a non-empty array of: ${VALID_CHANNELS.join(', ')}` },
        400
      );
    }

    if (body.thresholdUnit !== undefined && body.thresholdUnit !== null &&
        !VALID_THRESHOLD_UNITS.includes(body.thresholdUnit)) {
      return jsonResponse(
        { success: false, error: `Invalid threshold unit. Must be one of: ${VALID_THRESHOLD_UNITS.join(', ')}` },
        400
      );
    }

    if (body.cooldownMinutes !== undefined) {
      if (typeof body.cooldownMinutes !== 'number' || body.cooldownMinutes < 1) {
        return jsonResponse(
          { success: false, error: 'Cooldown minutes must be a positive number' },
          400
        );
      }
    }

    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
      return jsonResponse({ success: false, error: 'Name cannot be empty' }, 400);
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name.trim());
    }
    if (body.conditionType !== undefined) {
      updates.push('condition_type = ?');
      values.push(body.conditionType);
    }
    if (body.thresholdValue !== undefined) {
      updates.push('threshold_value = ?');
      values.push(body.thresholdValue);
    }
    if (body.thresholdUnit !== undefined) {
      updates.push('threshold_unit = ?');
      values.push(body.thresholdUnit);
    }
    if (body.severity !== undefined) {
      updates.push('severity = ?');
      values.push(body.severity);
    }
    if (body.channels !== undefined) {
      updates.push('channels = ?');
      values.push(JSON.stringify(body.channels));
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (body.cooldownMinutes !== undefined) {
      updates.push('cooldown_minutes = ?');
      values.push(body.cooldownMinutes);
    }

    if (updates.length === 0) {
      return jsonResponse({ success: false, error: 'No fields to update' }, 400);
    }

    values.push(id);
    const [, selectResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(
        `UPDATE alert_rules SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values),
      env.DIAGNOSTICS_DB.prepare(
        'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
      ).bind(id),
    ]);

    const updated = (selectResult as D1Result<AlertRule>).results?.[0] ?? null;
    if (!updated) {
      return jsonResponse(
        { success: false, error: 'Failed to update alert rule' },
        500
      );
    }

    // Invalidate KV cache
    if (env.ADMIN_KV) {
      await env.ADMIN_KV.delete('alert_rules_cache').catch(() => {});
    }

    return jsonResponse({
      success: true,
      data: toAlertRuleData(updated),
    });
  } catch (error) {
    console.error('Failed to update alert rule:', error);
    return jsonResponse(
      { success: false, error: 'Failed to update alert rule' },
      500
    );
  }
}

/**
 * Delete an alert rule
 * DELETE /admin/api/alerts/rules/:id
 */
export async function handleDeleteAlertRule(
  request: Request,
  env: Env,
  ruleId: string
): Promise<Response> {
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
  }

  const id = parseInt(ruleId, 10);
  if (isNaN(id)) {
    return jsonResponse({ success: false, error: 'Invalid rule ID' }, 400);
  }

  try {
    // Check if rule exists and if it's a default rule
    const existing = await env.DIAGNOSTICS_DB.prepare(
      'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
    ).bind(id).first<AlertRule>();

    if (!existing) {
      return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
    }

    if (existing.is_default === 1) {
      return jsonResponse(
        { success: false, error: 'Cannot delete default alert rules. Disable instead.' },
        403
      );
    }

    const result = await env.DIAGNOSTICS_DB.prepare(
      'DELETE FROM alert_rules WHERE id = ?'
    ).bind(id).run();

    if ((result.meta?.changes ?? 0) === 0) {
      return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
    }

    // Invalidate KV cache
    if (env.ADMIN_KV) {
      await env.ADMIN_KV.delete('alert_rules_cache').catch(() => {});
    }

    return jsonResponse({
      success: true,
      data: { message: 'Alert rule deleted' },
    });
  } catch (error) {
    console.error('Failed to delete alert rule:', error);
    return jsonResponse(
      { success: false, error: 'Failed to delete alert rule' },
      500
    );
  }
}

/**
 * Toggle an alert rule's enabled state
 * PATCH /admin/api/alerts/rules/:id/toggle
 */
export async function handleToggleAlertRule(
  request: Request,
  env: Env,
  ruleId: string
): Promise<Response> {
  const authResult = await requireSuperAdmin(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  if (!env.DIAGNOSTICS_DB) {
    return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
  }

  const id = parseInt(ruleId, 10);
  if (isNaN(id)) {
    return jsonResponse({ success: false, error: 'Invalid rule ID' }, 400);
  }

  try {
    const existing = await env.DIAGNOSTICS_DB.prepare(
      'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
    ).bind(id).first<AlertRule>();

    if (!existing) {
      return jsonResponse({ success: false, error: 'Alert rule not found' }, 404);
    }

    const newEnabled = existing.enabled === 1 ? 0 : 1;

    const [, selectResult] = await env.DIAGNOSTICS_DB.batch([
      env.DIAGNOSTICS_DB.prepare(
        'UPDATE alert_rules SET enabled = ? WHERE id = ?'
      ).bind(newEnabled, id),
      env.DIAGNOSTICS_DB.prepare(
        'SELECT * FROM alert_rules WHERE id = ? LIMIT 1'
      ).bind(id),
    ]);

    const updated = (selectResult as D1Result<AlertRule>).results?.[0] ?? null;
    if (!updated) {
      return jsonResponse(
        { success: false, error: 'Failed to toggle alert rule' },
        500
      );
    }

    // Invalidate KV cache
    if (env.ADMIN_KV) {
      await env.ADMIN_KV.delete('alert_rules_cache').catch(() => {});
    }

    return jsonResponse({
      success: true,
      data: toAlertRuleData(updated),
    });
  } catch (error) {
    console.error('Failed to toggle alert rule:', error);
    return jsonResponse(
      { success: false, error: 'Failed to toggle alert rule' },
      500
    );
  }
}

/**
 * JSON response helper
 */
function jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
