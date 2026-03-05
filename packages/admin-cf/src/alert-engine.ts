/**
 * Alert Engine — Evaluates alert rules against current D1 data
 *
 * Called by the cron handler every 5 minutes. For each enabled rule,
 * the engine checks whether the condition is currently met, respects
 * cooldown periods, and records fired alerts in alert_history + notifications.
 */

import type {
  Env,
  AlertRule,
  AlertChannel,
  AlertConditionType,
  AlertEvalResult,
  ConditionResult,
} from './types.js';

/** KV cache key for alert rules */
const RULES_CACHE_KEY = 'alert_rules_cache';
/** KV cache TTL in seconds */
const RULES_CACHE_TTL = 300;

/** Condition types that are evaluated by the cron (poll-based) */
const POLL_CONDITION_TYPES: AlertConditionType[] = [
  'error_rate',
  'error_rate_spike',
  'error_spike',
  'server_offline',
  'rate_limit_violations',
  'high_latency',
  'low_success_rate',
  'disk_usage_high',
  'memory_usage_high',
  'new_critical_crash',
  'ai_issue',
];

// ─── Main entry point ───────────────────────────────────────

/**
 * Evaluate all enabled alert rules and return the ones that fired.
 * This is the main function called by the cron handler.
 */
export async function evaluateAlertRules(env: Env): Promise<AlertEvalResult[]> {
  if (!env.DIAGNOSTICS_DB) {
    return [];
  }

  // Seed default rules if needed
  await seedDefaultRules(env.DIAGNOSTICS_DB);

  // Load rules (from KV cache or D1)
  const rules = await loadEnabledRules(env);
  const now = Date.now();
  const fired: AlertEvalResult[] = [];

  for (const rule of rules) {
    // Only evaluate poll-based condition types in cron
    if (!POLL_CONDITION_TYPES.includes(rule.condition_type)) {
      continue;
    }

    // Check cooldown
    if (rule.last_triggered_at !== null) {
      const cooldownMs = rule.cooldown_minutes * 60 * 1000;
      if (now - rule.last_triggered_at < cooldownMs) {
        continue;
      }
    }

    const result = await evaluateCondition(env, rule);
    if (result.triggered) {
      let channels: AlertChannel[] = [];
      try {
        channels = JSON.parse(rule.channels);
      } catch {
        channels = ['dashboard'];
      }

      fired.push({
        ruleId: rule.id,
        ruleName: rule.name,
        conditionType: rule.condition_type,
        severity: rule.severity,
        channels,
        message: result.message,
        metricValue: result.metricValue,
      });

      // Record the alert: update last_triggered_at, insert alert_history, insert notification
      await recordFiredAlert(env, rule, result, channels, now);
    }
  }

  return fired;
}

// ─── Rule loading with KV cache ─────────────────────────────

async function loadEnabledRules(env: Env): Promise<AlertRule[]> {
  // Try KV cache first
  if (env.ADMIN_KV) {
    try {
      const cached = await env.ADMIN_KV.get(RULES_CACHE_KEY, 'text');
      if (cached) {
        return JSON.parse(cached) as AlertRule[];
      }
    } catch {
      // Fall through to D1
    }
  }

  // Read from D1
  const result = await env.DIAGNOSTICS_DB!.prepare(
    'SELECT * FROM alert_rules WHERE enabled = 1 ORDER BY id ASC'
  ).all<AlertRule>();

  const rules = result.results || [];

  // Cache in KV
  if (env.ADMIN_KV && rules.length > 0) {
    try {
      await env.ADMIN_KV.put(RULES_CACHE_KEY, JSON.stringify(rules), {
        expirationTtl: RULES_CACHE_TTL,
      });
    } catch {
      // Non-critical, continue
    }
  }

  return rules;
}

// ─── Condition evaluators ───────────────────────────────────

async function evaluateCondition(env: Env, rule: AlertRule): Promise<ConditionResult> {
  const db = env.DIAGNOSTICS_DB!;

  switch (rule.condition_type) {
    case 'error_rate':
    case 'error_rate_spike':
    case 'error_spike':
      return evaluateErrorRate(db, rule);

    case 'server_offline':
      return evaluateServerOffline(env, rule);

    case 'high_latency':
      return evaluateHighLatency(db, rule);

    case 'low_success_rate':
      return evaluateLowSuccessRate(db, rule);

    case 'disk_usage_high':
      return evaluateDiskUsage(db, rule);

    case 'memory_usage_high':
      return evaluateMemoryUsage(db, rule);

    case 'rate_limit_violations':
      return evaluateRateLimitViolations(db, rule);

    case 'new_critical_crash':
      return evaluateNewCriticalCrash(db, rule);

    case 'ai_issue':
      return evaluateAiIssue(db, rule);

    default:
      return { triggered: false, message: `Unknown condition type: ${rule.condition_type}` };
  }
}

/**
 * error_rate / error_rate_spike / error_spike
 *
 * For error_rate: checks if total errors in the last hour exceed threshold.
 * For error_rate_spike / error_spike: checks if current hour rate is N times
 * the 24-hour rolling average.
 */
async function evaluateErrorRate(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const threshold = rule.threshold_value ?? 100;
  const now = new Date();

  // time_bucket format is ISO string like "2026-03-04T12:00:00.000Z"
  // We need to compare against time_bucket strings from the last hour
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const oneHourAgoStr = oneHourAgo.toISOString();

  const hourResult = await db.prepare(
    `SELECT COALESCE(SUM(count), 0) as total
     FROM error_aggregates
     WHERE time_bucket >= ?`
  ).bind(oneHourAgoStr).first<{ total: number }>();

  const currentTotal = hourResult?.total ?? 0;

  if (rule.condition_type === 'error_rate_spike' || rule.condition_type === 'error_spike') {
    // Compare against 24h average, excluding the current hour to avoid double-counting
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twentyFourHoursAgoStr = twentyFourHoursAgo.toISOString();

    const dayResult = await db.prepare(
      `SELECT COALESCE(SUM(count), 0) as total
       FROM error_aggregates
       WHERE time_bucket >= ? AND time_bucket < ?`
    ).bind(twentyFourHoursAgoStr, oneHourAgoStr).first<{ total: number }>();

    const dayTotal = dayResult?.total ?? 0;
    const avgHourly = dayTotal / 23; // 23 hours (excluding current hour)
    const ratio = avgHourly > 0 ? currentTotal / avgHourly : 0;

    if (ratio >= threshold) {
      return {
        triggered: true,
        message: `Error rate spike detected: ${currentTotal} errors in the last hour (${ratio.toFixed(1)}x the 24h average of ${avgHourly.toFixed(0)}/hour)`,
        metricValue: ratio,
      };
    }

    return { triggered: false, message: `Error rate ratio ${ratio.toFixed(1)}x is below ${threshold}x threshold` };
  }

  // Simple error_rate check
  if (currentTotal >= threshold) {
    return {
      triggered: true,
      message: `Error rate exceeded ${threshold}/hour: ${currentTotal} errors in the last hour`,
      metricValue: currentTotal,
    };
  }

  return { triggered: false, message: `Error count ${currentTotal} is below threshold ${threshold}` };
}

/**
 * server_offline: Check if any server hasn't sent a heartbeat in threshold minutes.
 * Uses the bootstrap registry via service binding or fallback URL.
 */
async function evaluateServerOffline(env: Env, rule: AlertRule): Promise<ConditionResult> {
  const thresholdMinutes = rule.threshold_value ?? 10;
  const thresholdMs = thresholdMinutes * 60 * 1000;
  const now = Date.now();

  try {
    let response: Response;
    if (env.BOOTSTRAP_SERVICE) {
      response = await env.BOOTSTRAP_SERVICE.fetch(
        new Request('https://bootstrap-internal/servers', {
          headers: { 'Accept': 'application/json' },
        })
      );
    } else {
      const bootstrapUrl = env.ZAJEL_BOOTSTRAP_URL || 'https://signal.zajel.hamzalabs.dev';
      response = await fetch(`${bootstrapUrl}/servers`, {
        headers: { 'Accept': 'application/json' },
      });
    }

    if (!response.ok) {
      return { triggered: false, message: 'Could not fetch server list from bootstrap registry' };
    }

    interface RegistryServer {
      serverId?: string;
      endpoint?: string;
      lastSeen?: number;
      lastHeartbeat?: number;
    }

    const data = await response.json() as { servers?: RegistryServer[] };
    const servers = data.servers || [];

    const offlineServers: string[] = [];
    for (const server of servers) {
      const lastSeen = server.lastSeen ?? server.lastHeartbeat ?? 0;
      if (now - lastSeen > thresholdMs) {
        offlineServers.push(server.serverId ?? server.endpoint ?? 'unknown');
      }
    }

    if (offlineServers.length > 0) {
      return {
        triggered: true,
        message: `${offlineServers.length} server(s) offline for >${thresholdMinutes} minutes: ${offlineServers.join(', ')}`,
        metricValue: offlineServers.length,
      };
    }

    return { triggered: false, message: `All ${servers.length} servers are online` };
  } catch (error) {
    console.error('server_offline evaluation failed:', error);
    return { triggered: false, message: 'Failed to evaluate server status' };
  }
}

/**
 * high_latency: Check if p95 latency exceeds threshold ms.
 * Queries performance_aggregates for recent latency data.
 */
async function evaluateHighLatency(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const thresholdMs = rule.threshold_value ?? 5000;
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const result = await db.prepare(
    `SELECT MAX(p95) as p95_max
     FROM performance_aggregates
     WHERE metric_name = 'startup_time'
       AND time_bucket >= ?`
  ).bind(fifteenMinutesAgo).first<{ p95_max: number | null }>();

  // Also check network latency
  const netResult = await db.prepare(
    `SELECT MAX(avg_latency_ms) as max_latency
     FROM network_aggregates
     WHERE time_bucket >= ?`
  ).bind(fifteenMinutesAgo).first<{ max_latency: number | null }>();

  const p95 = result?.p95_max ?? null;
  const netLatency = netResult?.max_latency ?? null;
  const maxLatency = Math.max(p95 ?? 0, netLatency ?? 0);

  if (maxLatency >= thresholdMs) {
    return {
      triggered: true,
      message: `High latency detected: ${maxLatency.toFixed(0)}ms (threshold: ${thresholdMs}ms)`,
      metricValue: maxLatency,
    };
  }

  return { triggered: false, message: `Latency ${maxLatency.toFixed(0)}ms is below threshold ${thresholdMs}ms` };
}

/**
 * low_success_rate: Check if signaling/WebRTC success rate below threshold %.
 * Queries network_aggregates for recent success rate data.
 */
async function evaluateLowSuccessRate(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const thresholdPercent = rule.threshold_value ?? 90;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await db.prepare(
    `SELECT
       COALESCE(SUM(signaling_success_count), 0) as sig_success,
       COALESCE(SUM(signaling_failure_count), 0) as sig_failure,
       COALESCE(SUM(webrtc_success_count), 0) as webrtc_success,
       COALESCE(SUM(webrtc_failure_count), 0) as webrtc_failure
     FROM network_aggregates
     WHERE time_bucket >= ?`
  ).bind(oneHourAgo).first<{
    sig_success: number;
    sig_failure: number;
    webrtc_success: number;
    webrtc_failure: number;
  }>();

  if (!result) {
    return { triggered: false, message: 'No network data available' };
  }

  const sigTotal = result.sig_success + result.sig_failure;
  const webrtcTotal = result.webrtc_success + result.webrtc_failure;

  // Check signaling success rate
  if (sigTotal > 0) {
    const sigRate = (result.sig_success / sigTotal) * 100;
    if (sigRate < thresholdPercent) {
      return {
        triggered: true,
        message: `Low signaling success rate: ${sigRate.toFixed(1)}% (threshold: ${thresholdPercent}%)`,
        metricValue: sigRate,
      };
    }
  }

  // Check WebRTC success rate
  if (webrtcTotal > 0) {
    const webrtcRate = (result.webrtc_success / webrtcTotal) * 100;
    if (webrtcRate < thresholdPercent) {
      return {
        triggered: true,
        message: `Low WebRTC success rate: ${webrtcRate.toFixed(1)}% (threshold: ${thresholdPercent}%)`,
        metricValue: webrtcRate,
      };
    }
  }

  const sigRate = sigTotal > 0 ? (result.sig_success / sigTotal) * 100 : 100;
  const webrtcRate = webrtcTotal > 0 ? (result.webrtc_success / webrtcTotal) * 100 : 100;
  return {
    triggered: false,
    message: `Success rates OK: signaling ${sigRate.toFixed(1)}%, WebRTC ${webrtcRate.toFixed(1)}%`,
  };
}

/**
 * disk_usage_high: Check if any server's disk usage exceeds threshold %.
 * Note: server_metrics doesn't have a disk column; we check cpu_percent as proxy
 * or use server_logs for disk warnings. This uses the latest server_metrics rows.
 */
async function evaluateDiskUsage(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const threshold = rule.threshold_value ?? 5;

  // Check server_logs for disk usage warnings in the last 15 minutes
  // Trigger when the count exceeds the threshold
  const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;

  const result = await db.prepare(
    `SELECT COUNT(*) as count
     FROM server_logs
     WHERE category = 'disk'
       AND severity IN ('error', 'warn')
       AND timestamp >= ?`
  ).bind(fifteenMinutesAgo).first<{ count: number }>();

  const diskWarnings = result?.count ?? 0;

  if (diskWarnings >= threshold) {
    return {
      triggered: true,
      message: `Disk usage warnings: ${diskWarnings} disk-related log entries in the last 15 minutes (threshold: ${threshold})`,
      metricValue: diskWarnings,
    };
  }

  return { triggered: false, message: `Disk warnings ${diskWarnings} below threshold ${threshold}` };
}

/**
 * memory_usage_high: Check if server memory usage exceeds threshold %.
 * Uses server_metrics table to check memory levels.
 */
async function evaluateMemoryUsage(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const thresholdMb = rule.threshold_value ?? 512;
  const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;

  // server_metrics has memory_mb — compare against threshold in MB
  const result = await db.prepare(
    `SELECT server_id, MAX(memory_mb) as max_memory_mb
     FROM server_metrics
     WHERE timestamp >= ?
     GROUP BY server_id
     HAVING max_memory_mb > ?`
  ).bind(fifteenMinutesAgo, thresholdMb).all<{ server_id: string; max_memory_mb: number }>();

  const highMemServers = result.results || [];

  if (highMemServers.length > 0) {
    const serverList = highMemServers
      .map(s => `${s.server_id}: ${s.max_memory_mb.toFixed(0)}MB`)
      .join(', ');
    return {
      triggered: true,
      message: `High memory usage on ${highMemServers.length} server(s): ${serverList} (threshold: ${thresholdMb}MB)`,
      metricValue: highMemServers[0]!.max_memory_mb,
    };
  }

  return { triggered: false, message: `Memory usage within limits (threshold: ${thresholdMb}MB)` };
}

/**
 * rate_limit_violations: Check if rate limit violation count exceeds threshold.
 * Uses security_events table.
 */
async function evaluateRateLimitViolations(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const threshold = rule.threshold_value ?? 1000;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const result = await db.prepare(
    `SELECT COALESCE(SUM(count), 0) as total
     FROM security_events
     WHERE event_type = 'rate_limit_violation'
       AND timestamp >= ?`
  ).bind(oneHourAgo).first<{ total: number }>();

  const totalViolations = result?.total ?? 0;

  if (totalViolations >= threshold) {
    return {
      triggered: true,
      message: `Rate limit violations exceeded ${threshold}/hour: ${totalViolations} violations in the last hour`,
      metricValue: totalViolations,
    };
  }

  return { triggered: false, message: `Rate limit violations ${totalViolations} below threshold ${threshold}` };
}

/**
 * new_critical_crash: Check if critical-severity log entries appeared recently.
 */
async function evaluateNewCriticalCrash(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const threshold = rule.threshold_value ?? 1;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const result = await db.prepare(
    `SELECT COUNT(*) as count
     FROM server_logs
     WHERE severity = 'critical'
       AND timestamp >= ?`
  ).bind(oneHourAgo).first<{ count: number }>();

  const criticalCount = result?.count ?? 0;

  if (criticalCount >= threshold) {
    return {
      triggered: true,
      message: `${criticalCount} critical crash(es) detected in the last hour (threshold: ${threshold})`,
      metricValue: criticalCount,
    };
  }

  return { triggered: false, message: `Critical crashes ${criticalCount} below threshold ${threshold}` };
}

/**
 * ai_issue: Check if AI-generated issues were created recently.
 * Looks for notifications or server_logs with AI-related sources.
 */
async function evaluateAiIssue(db: D1Database, rule: AlertRule): Promise<ConditionResult> {
  const threshold = rule.threshold_value ?? 1;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const result = await db.prepare(
    `SELECT COUNT(*) as count
     FROM notifications
     WHERE source = 'ai'
       AND created_at >= ?`
  ).bind(oneHourAgo).first<{ count: number }>();

  const aiIssueCount = result?.count ?? 0;

  if (aiIssueCount >= threshold) {
    return {
      triggered: true,
      message: `${aiIssueCount} AI-generated issue(s) created in the last hour (threshold: ${threshold})`,
      metricValue: aiIssueCount,
    };
  }

  return { triggered: false, message: `AI issues ${aiIssueCount} below threshold ${threshold}` };
}

// ─── Record fired alert ─────────────────────────────────────

async function recordFiredAlert(
  env: Env,
  rule: AlertRule,
  result: ConditionResult,
  channels: AlertChannel[],
  now: number
): Promise<void> {
  const db = env.DIAGNOSTICS_DB!;

  try {
    await db.batch([
      // Update last_triggered_at
      db.prepare(
        'UPDATE alert_rules SET last_triggered_at = ? WHERE id = ?'
      ).bind(now, rule.id),

      // Insert alert history
      db.prepare(
        `INSERT INTO alert_history (rule_id, triggered_at, message, channels_notified, delivery_status)
         VALUES (?, ?, ?, ?, 'sent')`
      ).bind(rule.id, now, result.message, JSON.stringify(channels)),

      // Insert notification
      db.prepare(
        `INSERT INTO notifications (rule_id, severity, title, message, source, channels_notified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        rule.id,
        rule.severity,
        `Alert: ${rule.name}`,
        result.message,
        rule.condition_type,
        JSON.stringify(channels),
        now
      ),
    ]);
  } catch (error) {
    console.error(`Failed to record fired alert for rule ${rule.id}:`, error);
  }

  // Invalidate KV cache so next evaluation uses fresh data
  if (env.ADMIN_KV) {
    try {
      await env.ADMIN_KV.delete(RULES_CACHE_KEY);
    } catch {
      // Non-critical
    }
  }
}

// ─── Default rule seeding ───────────────────────────────────

interface DefaultRuleDef {
  name: string;
  condition_type: AlertConditionType;
  threshold_value: number | null;
  threshold_unit: string | null;
  severity: 'info' | 'warning' | 'critical';
  channels: string;
  cooldown_minutes: number;
}

const DEFAULT_RULES: DefaultRuleDef[] = [
  {
    name: 'High error rate',
    condition_type: 'error_rate',
    threshold_value: 100,
    threshold_unit: 'per_hour',
    severity: 'warning',
    channels: JSON.stringify(['dashboard']),
    cooldown_minutes: 60,
  },
  {
    name: 'Error rate spike',
    condition_type: 'error_rate_spike',
    threshold_value: 3,
    threshold_unit: 'multiplier',
    severity: 'warning',
    channels: JSON.stringify(['dashboard']),
    cooldown_minutes: 60,
  },
  {
    name: 'Server offline',
    condition_type: 'server_offline',
    threshold_value: 5,
    threshold_unit: 'minutes',
    severity: 'critical',
    channels: JSON.stringify(['dashboard', 'email']),
    cooldown_minutes: 30,
  },
  {
    name: 'New critical crash',
    condition_type: 'new_critical_crash',
    threshold_value: 1,
    threshold_unit: 'per_hour',
    severity: 'critical',
    channels: JSON.stringify(['dashboard', 'email']),
    cooldown_minutes: 30,
  },
  {
    name: 'Rate limit violations',
    condition_type: 'rate_limit_violations',
    threshold_value: 1000,
    threshold_unit: 'per_hour',
    severity: 'warning',
    channels: JSON.stringify(['dashboard']),
    cooldown_minutes: 60,
  },
  {
    name: 'AI issue created',
    condition_type: 'ai_issue',
    threshold_value: 1,
    threshold_unit: 'per_hour',
    severity: 'info',
    channels: JSON.stringify(['dashboard']),
    cooldown_minutes: 60,
  },
];

/**
 * Seed the 6 default alert rules if they don't already exist.
 * Idempotent: only inserts rules whose condition_type + is_default
 * combination is not already present.
 */
export async function seedDefaultRules(db: D1Database): Promise<void> {
  try {
    const existing = await db.prepare(
      'SELECT condition_type FROM alert_rules WHERE is_default = 1'
    ).all<{ condition_type: string }>();

    const existingTypes = new Set(
      (existing.results || []).map(r => r.condition_type)
    );

    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];

    for (const rule of DEFAULT_RULES) {
      if (!existingTypes.has(rule.condition_type)) {
        stmts.push(
          db.prepare(
            `INSERT INTO alert_rules (name, condition_type, threshold_value, threshold_unit, severity, channels, enabled, cooldown_minutes, is_default, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, 'system', ?)`
          ).bind(
            rule.name,
            rule.condition_type,
            rule.threshold_value,
            rule.threshold_unit,
            rule.severity,
            rule.channels,
            rule.cooldown_minutes,
            now
          )
        );
      }
    }

    if (stmts.length > 0) {
      await db.batch(stmts);
    }
  } catch (error) {
    console.error('Failed to seed default rules:', error);
  }
}
