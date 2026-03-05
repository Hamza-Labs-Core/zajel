/**
 * Security client detection route handlers
 *
 * US-7.2: Bad Client Detection — table of anomalous behaviors, violation counts
 * US-7.4: Pairing Code Brute Force Detection — failed pair attempt chart, threshold alerts
 *
 * Queries the security_events table in the DIAGNOSTICS_DB (D1) binding.
 */

import type {
  Env,
  ApiResponse,
  BadClientsData,
  BadClientEntry,
  BadClientViolations,
  PairingBruteForceData,
  PairingBruteForceTimelineEntry,
  PairingBruteForceOffender,
} from '../types.js';
import { requireAuth } from './auth.js';

/** Default brute-force alert threshold: 20 failed attempts per session */
const BRUTE_FORCE_THRESHOLD = 20;

/** Supported range parameters */
const VALID_RANGES = ['24h', '7d', '30d'] as const;
type Range = (typeof VALID_RANGES)[number];

/** Map range string to milliseconds */
const RANGE_MS: Record<Range, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Map numeric severity rank back to string */
const SEVERITY_FROM_RANK: Record<number, string> = {
  4: 'critical',
  3: 'high',
  2: 'medium',
  1: 'low',
};

/**
 * GET /admin/api/security/bad-clients
 *
 * Returns aggregated bad-client events grouped by source_ip.
 */
export async function handleBadClients(
  request: Request,
  env: Env
): Promise<Response> {
  // Auth gate
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const url = new URL(request.url);
    const range = url.searchParams.get('range') || '7d';
    const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
    const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10);

    // Validate range
    if (!VALID_RANGES.includes(range as Range)) {
      return jsonResponse(
        { success: false, error: 'Invalid range. Use 24h, 7d, or 30d.' },
        400
      );
    }

    // Validate limit and offset
    const limit = Math.max(1, Math.min(200, isNaN(limitParam) ? 50 : limitParam));
    const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);

    // If no DIAGNOSTICS_DB, return empty data
    if (!env.DIAGNOSTICS_DB) {
      return jsonResponse({
        success: true,
        data: emptyBadClientsData(range, limit, offset),
      });
    }

    const sinceMs = Date.now() - RANGE_MS[range as Range];
    const sinceTimestamp = Math.floor(sinceMs);

    // Run all queries in a single batch (one roundtrip, snapshot isolation)
    const [countResult, totalViolationsResult, quarantinedResult, clientRows] =
      await env.DIAGNOSTICS_DB.batch([
        // Total distinct source_ips for pagination
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT COUNT(DISTINCT source_ip) as total
             FROM security_events
             WHERE event_type = ? AND timestamp >= ?
             LIMIT 1`
          )
          .bind('bad_client', sinceTimestamp),

        // Global total violations (not page-scoped)
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT COALESCE(SUM(count), 0) as total_violations
             FROM security_events
             WHERE event_type = ? AND timestamp >= ?
             LIMIT 1`
          )
          .bind('bad_client', sinceTimestamp),

        // Global quarantined count: IPs where highest severity is critical
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT COUNT(*) as quarantined_count FROM (
               SELECT source_ip,
                 MAX(CASE severity
                   WHEN 'critical' THEN 4 WHEN 'high' THEN 3
                   WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
                 END) as max_rank
               FROM security_events
               WHERE event_type = ? AND timestamp >= ?
               GROUP BY source_ip
               HAVING max_rank >= 4
             )
             LIMIT 1`
          )
          .bind('bad_client', sinceTimestamp),

        // Paginated client list with numeric severity ranking
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT
               source_ip,
               SUM(count) as violation_count,
               MAX(timestamp) as last_seen,
               MIN(timestamp) as first_seen,
               GROUP_CONCAT(details, '||') as all_details,
               MAX(CASE severity
                 WHEN 'critical' THEN 4 WHEN 'high' THEN 3
                 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0
               END) as severity_rank
             FROM security_events
             WHERE event_type = ? AND timestamp >= ?
             GROUP BY source_ip
             ORDER BY violation_count DESC
             LIMIT ? OFFSET ?`
          )
          .bind('bad_client', sinceTimestamp, limit, offset),
      ]);

    const total =
      (countResult.results?.[0] as { total: number } | undefined)?.total ?? 0;
    const totalViolations =
      (totalViolationsResult.results?.[0] as { total_violations: number } | undefined)
        ?.total_violations ?? 0;
    const quarantinedCount =
      (quarantinedResult.results?.[0] as { quarantined_count: number } | undefined)
        ?.quarantined_count ?? 0;

    const clients: BadClientEntry[] = (
      (clientRows.results ?? []) as Array<{
        source_ip: string;
        violation_count: number;
        last_seen: number;
        first_seen: number;
        all_details: string | null;
        severity_rank: number;
      }>
    ).map((row) => {
      const violations = parseViolations(row.all_details);
      return {
        sourceIp: row.source_ip,
        violationCount: row.violation_count,
        lastSeen: row.last_seen,
        firstSeen: row.first_seen,
        violations,
        severity: SEVERITY_FROM_RANK[row.severity_rank] || 'medium',
      };
    });

    const data: BadClientsData = {
      range,
      summary: {
        totalBadClients: total,
        totalViolations,
        quarantinedCount,
      },
      clients,
      total,
      limit,
      offset,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to fetch bad clients:', error);
    return jsonResponse(
      { success: false, error: 'Failed to fetch bad client data' },
      500
    );
  }
}

/**
 * GET /admin/api/security/pairing-abuse
 *
 * Returns brute-force pairing attempt data with timeline and top offenders.
 */
export async function handlePairingBruteForce(
  request: Request,
  env: Env
): Promise<Response> {
  // Auth gate
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  try {
    const url = new URL(request.url);
    const range = url.searchParams.get('range') || '24h';

    // Validate range
    if (!VALID_RANGES.includes(range as Range)) {
      return jsonResponse(
        { success: false, error: 'Invalid range. Use 24h, 7d, or 30d.' },
        400
      );
    }

    // If no DIAGNOSTICS_DB, return empty data
    if (!env.DIAGNOSTICS_DB) {
      return jsonResponse({
        success: true,
        data: emptyPairingBruteForceData(range),
      });
    }

    const sinceMs = Date.now() - RANGE_MS[range as Range];
    const sinceTimestamp = Math.floor(sinceMs);
    const HOUR_MS = 3600000;

    // Run all queries in a single batch (one roundtrip, snapshot isolation)
    const [summaryResult, alertResult, timelineResult, offenderResult] =
      await env.DIAGNOSTICS_DB.batch([
        // Summary: total failed attempts and unique sessions
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT
               COALESCE(SUM(count), 0) as total_failed,
               COUNT(DISTINCT source_ip) as unique_sessions
             FROM security_events
             WHERE event_type = ? AND timestamp >= ?
             LIMIT 1`
          )
          .bind('brute_force_attempt', sinceTimestamp),

        // Sessions exceeding threshold (alert count)
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT COUNT(*) as alert_count FROM (
               SELECT source_ip, SUM(count) as total
               FROM security_events
               WHERE event_type = ? AND timestamp >= ?
               GROUP BY source_ip
               HAVING total >= ?
             )
             LIMIT 1`
          )
          .bind('brute_force_attempt', sinceTimestamp, BRUTE_FORCE_THRESHOLD),

        // Timeline: hourly aggregation
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT
               (timestamp / ?) * ? as hour_bucket,
               SUM(count) as failed_attempts,
               COUNT(DISTINCT source_ip) as unique_sessions
             FROM security_events
             WHERE event_type = ? AND timestamp >= ?
             GROUP BY hour_bucket
             ORDER BY hour_bucket ASC
             LIMIT 720`
          )
          .bind(HOUR_MS, HOUR_MS, 'brute_force_attempt', sinceTimestamp),

        // Top offenders: source_ips with most failed attempts
        env.DIAGNOSTICS_DB
          .prepare(
            `SELECT
               source_ip,
               SUM(count) as failed_attempts,
               MIN(timestamp) as first_seen,
               MAX(timestamp) as last_seen
             FROM security_events
             WHERE event_type = ? AND timestamp >= ?
             GROUP BY source_ip
             ORDER BY failed_attempts DESC
             LIMIT 50`
          )
          .bind('brute_force_attempt', sinceTimestamp),
      ]);

    const summaryRow = summaryResult.results?.[0] as {
      total_failed: number;
      unique_sessions: number;
    } | undefined;
    const totalFailedAttempts = summaryRow?.total_failed ?? 0;
    const uniqueSessions = summaryRow?.unique_sessions ?? 0;

    const alertRow = alertResult.results?.[0] as {
      alert_count: number;
    } | undefined;
    const alertCount = alertRow?.alert_count ?? 0;

    const timeline: PairingBruteForceTimelineEntry[] = (
      (timelineResult.results ?? []) as Array<{
        hour_bucket: number;
        failed_attempts: number;
        unique_sessions: number;
      }>
    ).map((row) => ({
      timestamp: row.hour_bucket,
      failedAttempts: row.failed_attempts,
      uniqueSessions: row.unique_sessions,
    }));

    const topOffenders: PairingBruteForceOffender[] = (
      (offenderResult.results ?? []) as Array<{
        source_ip: string;
        failed_attempts: number;
        first_seen: number;
        last_seen: number;
      }>
    ).map((row) => ({
      sourceIp: row.source_ip,
      failedAttempts: row.failed_attempts,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));

    const data: PairingBruteForceData = {
      range,
      summary: {
        totalFailedAttempts,
        uniqueSessions,
        alertCount,
        threshold: BRUTE_FORCE_THRESHOLD,
      },
      timeline,
      topOffenders,
      lastUpdated: Date.now(),
    };

    return jsonResponse({ success: true, data });
  } catch (error) {
    console.error('Failed to fetch pairing brute force data:', error);
    return jsonResponse(
      { success: false, error: 'Failed to fetch pairing abuse data' },
      500
    );
  }
}

// ── Helpers ──────────────────────────────────────────────

/**
 * Parse violation categories from concatenated details JSON blobs.
 * Each detail blob is expected to have a "violation_type" field.
 */
function parseViolations(allDetails: string | null): BadClientViolations {
  const violations: BadClientViolations = {
    malformedMessages: 0,
    signatureFailures: 0,
    protocolViolations: 0,
    other: 0,
  };

  if (!allDetails) return violations;

  const parts = allDetails.split('||');
  for (const part of parts) {
    try {
      const detail = JSON.parse(part) as { violation_type?: string; count?: number };
      const count = detail.count ?? 1;
      switch (detail.violation_type) {
        case 'malformed_message':
          violations.malformedMessages += count;
          break;
        case 'signature_failure':
          violations.signatureFailures += count;
          break;
        case 'protocol_violation':
          violations.protocolViolations += count;
          break;
        default:
          violations.other += count;
          break;
      }
    } catch {
      // Non-JSON detail blob — count as 'other'
      violations.other += 1;
    }
  }

  return violations;
}

/**
 * Return empty bad-clients response when DIAGNOSTICS_DB is not bound.
 */
function emptyBadClientsData(range: string, limit: number, offset: number): BadClientsData {
  return {
    range,
    summary: {
      totalBadClients: 0,
      totalViolations: 0,
      quarantinedCount: 0,
    },
    clients: [],
    total: 0,
    limit,
    offset,
    lastUpdated: Date.now(),
  };
}

/**
 * Return empty pairing brute-force response when DIAGNOSTICS_DB is not bound.
 */
function emptyPairingBruteForceData(range: string): PairingBruteForceData {
  return {
    range,
    summary: {
      totalFailedAttempts: 0,
      uniqueSessions: 0,
      alertCount: 0,
      threshold: BRUTE_FORCE_THRESHOLD,
    },
    timeline: [],
    topOffenders: [],
    lastUpdated: Date.now(),
  };
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
