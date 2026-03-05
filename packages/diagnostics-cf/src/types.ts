/**
 * Zajel Diagnostics Worker - Type Definitions
 */

/**
 * Cloudflare Rate Limit binding interface.
 * GA since September 2025.
 */
export interface RateLimit {
  limit(config: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Environment bindings for the Diagnostics Worker.
 */
export interface Env {
  /** D1 database for aggregated metrics */
  DB: D1Database;
  /** R2 bucket for raw diagnostic report storage */
  REPORTS_BUCKET: R2Bucket;
  /** KV namespace for per-session rate limiting */
  RATE_LIMIT_KV: KVNamespace;
  /** Native rate limiting binding for global DDoS protection */
  GLOBAL_RATE_LIMITER: RateLimit;
  /** Environment name (production, qa) */
  ENVIRONMENT?: string;
  /** Shared secret for VPS server metrics push authentication */
  SERVER_METRICS_SECRET?: string;
}

/**
 * Server metrics push payload from VPS servers.
 */
export interface ServerMetricsPush {
  serverId: string;
  region: string;
  timestamp: number;
  metrics: {
    connections: { total: number; relay: number; signaling: number };
    entropy: { activeCodes: number; collisionRisk: string };
    federation: { aliveMembers: number; totalMembers: number };
    messageRate: { perSecond: number; perMinute: number };
    system: {
      cpuPercent: number;
      memoryMb: number;
      uptimeSeconds: number;
    };
    /** Optional gossip latency stats from SWIM failure detector */
    gossipLatency?: {
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      pingCount: number;
    };
  };
}

/**
 * Valid platform values for diagnostic reports.
 */
export const VALID_PLATFORMS = ['android', 'ios', 'windows', 'macos', 'linux', 'web'] as const;
export type Platform = (typeof VALID_PLATFORMS)[number];

/**
 * Valid error categories.
 */
export const VALID_ERROR_CATEGORIES = ['crash', 'network', 'crypto', 'storage', 'ui', 'protocol', 'other'] as const;
export type ErrorCategory = (typeof VALID_ERROR_CATEGORIES)[number];

/**
 * Valid connection types.
 */
export const VALID_CONNECTION_TYPES = ['direct_p2p', 'relay', 'none'] as const;
export type ConnectionType = (typeof VALID_CONNECTION_TYPES)[number];

/**
 * Individual error entry within a diagnostic report.
 */
export interface DiagnosticError {
  category: ErrorCategory;
  message: string;
  stackTrace?: string;
  signature: string;
  count: number;
  firstOccurrence: number;
  lastOccurrence: number;
}

/**
 * Performance metrics from the app.
 */
export interface PerformanceMetrics {
  startupTimeMs?: number;
  frameRateAvg?: number;
  frameRateP95?: number;
  memoryUsageMb?: number;
  memoryPeakMb?: number;
}

/**
 * Network metrics from the app.
 */
export interface NetworkMetrics {
  signalingConnectSuccessRate?: number;
  signalingConnectAttempts?: number;
  webrtcEstablishSuccessRate?: number;
  webrtcEstablishAttempts?: number;
  relayUsageRate?: number;
  avgLatencyMs?: number;
}

/**
 * Full diagnostic report payload (request body).
 */
export interface DiagnosticReport {
  sessionHash: string;
  appVersion: string;
  buildNumber: string;
  platform: Platform;
  platformVersion: string;
  locale: string;
  timestamp: number;
  errors?: DiagnosticError[];
  performance?: PerformanceMetrics;
  network?: NetworkMetrics;
  connectionType?: ConnectionType;
}

/**
 * API success response.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Report submission success data.
 */
export interface ReportSuccessData {
  reportId: string;
}

/** Maximum request body size in bytes (64 KB). */
export const MAX_BODY_SIZE = 64 * 1024;

/** Maximum reports per session per hour. */
export const SESSION_RATE_LIMIT = 10;

/** Session rate limit window in seconds (1 hour). */
export const SESSION_RATE_LIMIT_WINDOW = 3600;

/**
 * Heartbeat request body.
 */
export interface HeartbeatRequest {
  sessionHash: string;
  platform: Platform;
  appVersion: string;
  connectionType?: ConnectionType;
}

/**
 * Heartbeat success response data.
 */
export interface HeartbeatResponseData {
  nextHeartbeatMs: number;
}
