/**
 * Admin User Schema
 */
export interface AdminUser {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  role: 'admin' | 'super-admin';
  createdAt: number;
  lastLogin: number | null;
}

/**
 * Admin user without sensitive fields (for API responses)
 */
export interface AdminUserPublic {
  id: string;
  username: string;
  role: 'admin' | 'super-admin';
  createdAt: number;
  lastLogin: number | null;
}

/**
 * VPS Server info from bootstrap registry
 */
export interface VpsServer {
  id: string;
  endpoint: string;
  region: string;
  lastHeartbeat: number;
  status: 'healthy' | 'degraded' | 'offline';
  stats?: {
    connections: number;
    relayConnections: number;
    signalingConnections: number;
    activeCodes: number;
    collisionRisk: 'low' | 'medium' | 'high';
  };
}

/**
 * JWT payload structure
 */
export interface JwtPayload {
  sub: string;  // user id
  username: string;
  role: 'admin' | 'super-admin';
  iat: number;
  exp: number;
}

/**
 * Service binding interface for worker-to-worker communication.
 * CF Workers calling other CF Workers via custom domains on the same zone
 * return 530 errors. Service bindings bypass this by routing internally.
 */
export interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * Environment bindings for CF Worker
 */
export interface Env {
  ADMIN_USERS: DurableObjectNamespace;
  ZAJEL_ADMIN_JWT_SECRET: string;
  ZAJEL_BOOTSTRAP_URL?: string;
  APP_VERSION?: string;
  /** Service binding to the bootstrap server (zajel-signaling worker) */
  BOOTSTRAP_SERVICE?: ServiceBinding;
  /**
   * Comma-separated list of allowed origins for CORS.
   * Example: "https://admin.zajel.hamzalabs.dev,http://localhost:*"
   * If not set, no cross-origin requests will be allowed.
   */
  ADMIN_ALLOWED_ORIGINS?: string;
  /** D1 binding for the diagnostics database (error_aggregates table) */
  DIAGNOSTICS_DB?: D1Database;
  /** Durable Object namespace for real-time notifications (US-8.1) */
  NOTIFICATION_DO?: DurableObjectNamespace;
  /** Cloudflare Email Workers binding for sending email (US-8.2) */
  SEND_EMAIL?: SendEmail;
  /** KV namespace for cooldown state (email/webhook) */
  ADMIN_KV?: KVNamespace;
  /** Sender email address for notifications (default: notifications@zajel.hamzalabs.dev) */
  NOTIFICATION_FROM_EMAIL?: string;
}

/**
 * Cloudflare Email Workers SendEmail binding interface
 */
export interface SendEmail {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Cloudflare EmailMessage interface for constructing email messages
 */
export interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream | string;
}

/**
 * Auth request bodies
 */
export interface LoginRequest {
  username: string;
  password: string;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role?: 'admin' | 'super-admin';
}

/**
 * API response types
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Authorization code for cross-origin auth (JWT token exchange)
 */
export interface AuthCode {
  code: string;
  payload: JwtPayload;  // JWT claims from authenticated user
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/**
 * Request/response types for auth code endpoints
 */
export interface GenerateCodeData {
  code: string;
}

export interface ExchangeCodeRequest {
  code: string;
}

export interface ExchangeCodeData {
  token: string;
}

/** Single error signature aggregate row */
export interface ErrorAggregate {
  errorSignature: string;
  category: 'crash' | 'network' | 'crypto' | 'storage' | 'ui' | 'protocol' | 'other';
  totalCount: number;
  versions: string[];
  platforms: string[];
  firstSeen: number;
  lastSeen: number;
  sampleMessage: string;
}

/** Summary cards data */
export interface ErrorSummary {
  totalErrors: number;
  rateChangePercent: number;
  regressionAlerts: number;
  highestSeverity: 'critical' | 'high' | 'medium' | 'low' | 'none';
}

/** GET /admin/api/errors response */
export interface ErrorsResponse {
  summary: ErrorSummary;
  errors: ErrorAggregate[];
  range: '1h' | '24h' | '7d';
}

/**
 * A deployment marker for the error trends chart.
 * Derived from first-seen `app_version` in error_aggregates.
 */
export interface DeploymentMarker {
  version: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

/**
 * GET /admin/api/errors/trends response
 */
export interface ErrorTrendsResponse {
  /** Array of Unix timestamps (seconds) for the x-axis */
  timestamps: number[];
  /** Map of category name to array of counts, aligned with timestamps */
  series: Record<string, number[]>;
  /** Deployment markers to overlay on the chart */
  deployments: DeploymentMarker[];
  /** The time range that was queried */
  range: '1h' | '24h' | '7d';
  /** Bucket granularity in human-readable form */
  bucketSize: '1min' | '1h' | '6h';
}

/** A detected regression for an error signature */
export interface Regression {
  errorSignature: string;
  category: string;
  currentVersion: string;
  previousVersion: string;
  currentRate: number;       // errors per hour in current version
  previousRate: number;      // errors per hour in previous version
  multiplier: number;        // currentRate / previousRate (>= 3.0 threshold)
  currentTotal: number;      // total count in current version within window
  previousTotal: number;     // total count in previous version within window
  firstDetected: number;     // Unix ms -- earliest time_bucket for this signature in current version
  sampleMessage: string;
}

/** GET /admin/api/errors/regressions response */
export interface RegressionResponse {
  regressions: Regression[];
  currentVersion: string;
  previousVersion: string;
  window: '6h' | '24h' | '48h';
  threshold: number;
  computedAt: number;        // Unix ms -- when this computation was performed
}

/** Distribution entry for version/platform breakdowns */
export interface DistributionEntry {
  name: string;
  count: number;
  percentage: number;
}

/** Timeline data point */
export interface TimelinePoint {
  timestamp: number;
  count: number;
}

// ─────────────────────────────────────────────
// Server Metrics (US-3.3)
// ─────────────────────────────────────────────

/** Server metrics entry for a single server */
export interface ServerMetricEntry {
  serverId: string;
  region: string;
  endpoint: string;
  status: 'healthy' | 'degraded' | 'offline';
  lastSeen: number;
  metrics: {
    cpuPercent: number;
    memoryMb: number;
    connectionsTotal: number;
    connectionsRelay: number;
    connectionsSignaling: number;
    messageRatePerSecond: number;
    messageRatePerMinute: number;
    entropyActiveCodes: number;
    federationAliveMembers: number;
    federationTotalMembers: number;
    uptimeSeconds: number;
  } | null;
}

/** Aggregate stats across all servers */
export interface ServerMetricsAggregate {
  totalServers: number;
  healthyServers: number;
  degradedServers: number;
  offlineServers: number;
  totalConnections: number;
  totalThroughput: number;
}

/** GET /admin/api/metrics/server response */
export interface ServerMetricsResponse {
  servers: ServerMetricEntry[];
  aggregate: ServerMetricsAggregate;
}

/** Historical data point for server metrics detail */
export interface ServerMetricsHistoryPoint {
  timestamp: number;
  cpuPercent: number;
  memoryMb: number;
  connectionsTotal: number;
  messageRatePerMinute: number;
  federationAliveMembers: number;
}

/** GET /admin/api/metrics/server/:serverId response */
export interface ServerMetricsDetailResponse {
  serverId: string;
  region: string;
  history: ServerMetricsHistoryPoint[];
}

/** GET /admin/api/errors/:signature response */
export interface ErrorDetailResponse {
  errorSignature: string;
  category: string;
  totalCount: number;
  firstSeen: number;
  lastSeen: number;
  sampleMessage: string;
  sampleStackTrace: string | null;
  versionDistribution: DistributionEntry[];
  platformDistribution: DistributionEntry[];
  occurrenceTimeline: TimelinePoint[];
}

// ─────────────────────────────────────────────
// Network Metrics Types (US-3.2)
// ─────────────────────────────────────────────

/** Current network success rate snapshot */
export interface NetworkMetricsCurrent {
  signalingSuccessRate: number | null;
  signalingAttempts: number;
  webrtcSuccessRate: number | null;
  webrtcAttempts: number;
  relayUsageRate: number | null;
  avgLatencyMs: number | null;
}

/** Time-bucketed success rate data point */
export interface SuccessRatePoint {
  timeBucket: string;
  successRate: number | null;
  attempts: number;
}

/** Time-bucketed latency data point */
export interface LatencyPoint {
  timeBucket: string;
  avgLatencyMs: number | null;
}

/** Historical trends for network metrics */
export interface NetworkMetricsTrends {
  signalingRate: SuccessRatePoint[];
  webrtcRate: SuccessRatePoint[];
  latency: LatencyPoint[];
}

/** Relay vs. direct P2P distribution */
export interface NetworkDistribution {
  relayCount: number;
  directP2pCount: number;
  totalConnections: number;
}

/** Per-platform breakdown entry */
export interface PlatformBreakdownEntry {
  platform: string;
  signalingSuccessRate: number | null;
  webrtcSuccessRate: number | null;
  avgLatencyMs: number | null;
  sampleCount: number;
}

/** Available filter values */
export interface NetworkFilters {
  platforms: string[];
  versions: string[];
}

/** GET /admin/api/metrics/network response */
export interface NetworkMetricsResponse {
  current: NetworkMetricsCurrent;
  trends: NetworkMetricsTrends;
  distribution: NetworkDistribution;
  platformBreakdown: PlatformBreakdownEntry[];
  filters: NetworkFilters;
}

// ─────────────────────────────────────────────
// App Performance Metrics (US-3.1)
// ─────────────────────────────────────────────

/** Valid metric names in performance_aggregates */
export type MetricName = 'startup_time' | 'frame_rate' | 'memory';

/** A single data point from performance_aggregates */
export interface MetricDataPoint {
  timeBucket: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  sampleCount: number;
}

/** Current (latest bucket) summary */
export interface MetricCurrent {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** A single metric series with data points and current summary */
export interface MetricSeries {
  metricName: string;
  unit: string;
  dataPoints: MetricDataPoint[];
  current: MetricCurrent;
}

/** GET /admin/api/metrics/app response data */
export interface AppMetricsResponse {
  metrics: MetricSeries[];
  filters: {
    platforms: string[];
    versions: string[];
  };
}

// ─── Federation Health Metrics (US-3.4) ─────────────────────

/** Federation health status */
export type FederationHealthStatus = 'healthy' | 'degraded' | 'critical';

/** Availability status for a node in the timeline */
export type NodeAvailabilityStatus = 'alive' | 'suspect' | 'failed' | 'offline';

/** Gossip latency aggregation */
export interface GossipLatencySummary {
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  pingCount: number;
}

/** Summary of federation node counts and regions */
export interface FederationSummary {
  totalNodes: number;
  aliveNodes: number;
  suspectNodes: number;
  failedNodes: number;
  regions: Record<string, number>;
}

/** Per-server federation view */
export interface FederationPerServer {
  serverId: string;
  region: string;
  aliveMembers: number;
  totalMembers: number;
  gossipRttP50Ms: number | null;
  gossipRttP95Ms: number | null;
  lastSeen: number;
}

/** Timeline event for availability history */
export interface TimelineEvent {
  timestamp: number;
  status: NodeAvailabilityStatus;
}

/** Availability history per server */
export interface AvailabilityHistoryEntry {
  serverId: string;
  region: string;
  timeline: TimelineEvent[];
}

/** Full federation metrics response data */
export interface FederationMetricsData {
  health: FederationHealthStatus;
  summary: FederationSummary;
  gossipLatency: GossipLatencySummary;
  syncCompleteness: number;
  perServer: FederationPerServer[];
  availabilityHistory: AvailabilityHistoryEntry[];
}

/** Federation metrics API response */
export type FederationMetricsResponse = ApiResponse<FederationMetricsData>;

// ─── Active Clients (US-4.1) ────────────────────

export interface SparklineEntry {
  timestamp: number;
  count: number;
}

export interface ActiveClientsData {
  activeCount: number;
  sparkline: SparklineEntry[];
  lastUpdated: number;
}

export type ActiveClientsResponse = ApiResponse<ActiveClientsData>;

// ─── Platform Breakdown (US-4.2) ────────────────

export interface PlatformCount {
  platform: string;
  count: number;
  percentage: number;
}

export interface PlatformBreakdownData {
  platforms: PlatformCount[];
  totalActive: number;
  lastUpdated: number;
}

export type PlatformBreakdownResponse = ApiResponse<PlatformBreakdownData>;

// ─── Version Adoption (US-4.3) ──────────────────

/** A single time bucket with version counts */
export interface VersionTimeBucket {
  timestamp: number;
  counts: Record<string, number>;
}

/** Version adoption curve data */
export interface VersionAdoptionData {
  range: string;
  buckets: VersionTimeBucket[];
  versions: string[];
  lastUpdated: number;
}

/** Version adoption API response */
export type VersionAdoptionResponse = ApiResponse<VersionAdoptionData>;

// ─── Connection Types (US-4.4) ──────────────────

/** Connection type distribution (current snapshot) */
export interface ConnectionTypeCount {
  connectionType: string;
  count: number;
  percentage: number;
}

/** Connection type trend data point (historical) */
export interface ConnectionTypeTrend {
  timestamp: number;
  direct_p2p: number;
  relay: number;
  none: number;
}

/** Combined connection type response data */
export interface ConnectionTypeData {
  current: ConnectionTypeCount[];
  trend: ConnectionTypeTrend[];
  totalActive: number;
  lastUpdated: number;
}

export type ConnectionTypeResponse = ApiResponse<ConnectionTypeData>;

// ─── Server Health Cards (US-5.1) ───────────────

export interface ServerHealthCard {
  serverId: string;
  region: string;
  endpoint: string;
  status: 'healthy' | 'degraded' | 'offline';
  lastSeen: number;
  cpuPercent: number;
  memoryMb: number;
  connectionsTotal: number;
  uptimeSeconds: number;
  healthScore: number;
}

export interface ServersHealthData {
  servers: ServerHealthCard[];
  lastUpdated: number;
}

// ─── Server Logs (US-5.2) ───────────────────────

export interface ServerLogEntry {
  id: number;
  serverId: string;
  timestamp: number;
  severity: 'error' | 'warn' | 'info' | 'debug';
  category: string;
  message: string;
  metadata: Record<string, unknown> | null;
}

export interface ServerLogsData {
  logs: ServerLogEntry[];
  total: number;
  limit: number;
  offset: number;
  lastUpdated: number;
}

// ─── Log-Diagnostic Correlation (US-9.2) ────────

/** Client error aggregate entry from the error_aggregates D1 table */
export interface ClientErrorEntry {
  timeBucket: string;
  errorSignature: string;
  category: string;
  count: number;
  appVersion: string;
  platform: string;
  sampleMessage: string | null;
}

/** Correlation data combining server logs and client error aggregates */
export interface LogCorrelationData {
  timeRange: { startTime: number; endTime: number };
  serverLogs: Array<Omit<ServerLogEntry, 'metadata'>>;
  clientErrors: ClientErrorEntry[];
  summary: {
    serverLogCount: number;
    clientErrorCount: number;
    overlappingCategories: string[];
  };
  lastUpdated: number;
}

// ─── Federation Topology Graph (US-5.3) ─────────

export interface TopologyNode {
  serverId: string;
  region: string;
  endpoint: string;
  status: 'alive' | 'suspect' | 'failed' | 'offline';
  aliveMembers: number;
  totalMembers: number;
  cpuPercent: number;
  connectionsTotal: number;
  lastSeen: number;
}

export interface TopologyEdge {
  source: string;
  target: string;
  latencyMs: number;
  lastSeen: number;
}

export interface TopologySummary {
  totalNodes: number;
  aliveNodes: number;
  edgeCount: number;
  avgLatencyMs: number | null;
}

export interface FederationTopologyData {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  summary: TopologySummary;
  lastUpdated: number;
}

export type FederationTopologyResponse = ApiResponse<FederationTopologyData>;

// ─── Heartbeat Timeline (US-5.4) ────────────────

export interface HeartbeatSegment {
  startTime: number;
  endTime: number;
  status: 'ok' | 'gap' | 'offline';
}

export interface ServerHeartbeatTimeline {
  serverId: string;
  region: string;
  segments: HeartbeatSegment[];
  uptimePercent: number;
  gapCount: number;
  longestGapMs: number;
}

export interface HeartbeatTimelineData {
  servers: ServerHeartbeatTimeline[];
  range: string;
  lastUpdated: number;
}

// ─── AI Issues (US-6.3) ────────────────────────

export interface IssueListEntry {
  id: number;
  errorSignature: string;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  severity: string;
  component: string;
  status: string;
  firstDetected: number;
  lastDetected: number;
  totalOccurrences: number;
  createdAt: number;
  updatedAt: number;
}

export interface AiAnalysisResult {
  title: string;
  severity: string;
  component: string;
  description: string;
  reproductionHints: string;
  suggestedFix: string;
  isRegression: boolean;
  affectedUsersEstimate: string;
}

export interface IssueDetail extends IssueListEntry {
  aiAnalysis: AiAnalysisResult | null;
}

export interface IssueMetrics {
  avgTimeToDetectionMs: number | null;
  avgTimeToFixMs: number | null;
  openCount: number;
  closedCount: number;
}

export interface IssuesListData {
  issues: IssueListEntry[];
  total: number;
  limit: number;
  offset: number;
  metrics: IssueMetrics;
  lastUpdated: number;
}

export interface IssueDetailData {
  issue: IssueDetail | null;
  lastUpdated: number;
}

// ─── AI Cost Monitoring (US-6.5) ───────────────

export interface AiCostSummary {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  totalErrorsProcessed: number;
  totalIssuesCreated: number;
  totalIssuesUpdated: number;
  totalAiCalls: number;
  totalTokensUsed: number;
  estimatedCostUsd: number;
}

export interface AiCostDailyBreakdown {
  date: string;
  runs: number;
  errorsProcessed: number;
  issuesCreated: number;
  aiCalls: number;
  tokensUsed: number;
  estimatedCostUsd: number;
}

export interface AiCostRecentRun {
  id: number;
  runStart: number;
  runEnd: number;
  durationMs: number;
  errorsProcessed: number;
  issuesCreated: number;
  issuesUpdated: number;
  aiCalls: number;
  tokensUsed: number;
  status: string;
}

export interface AiCostsData {
  range: string;
  summary: AiCostSummary;
  dailyBreakdown: AiCostDailyBreakdown[];
  recentRuns: AiCostRecentRun[];
  lastUpdated: number;
}

// ─── Security Monitoring (Epic 7) ──────────────

export interface RateLimitViolationsData {
  range: string;
  summary: {
    totalViolations: number;
    uniqueEndpoints: number;
    uniqueRegions: number;
    peakHourlyRate: number;
  };
  timeline: Array<{
    timestamp: number;
    count: number;
  }>;
  topEndpoints: Array<{
    endpoint: string;
    count: number;
    percentage: number;
  }>;
  regionalBreakdown: Array<{
    region: string;
    count: number;
    percentage: number;
  }>;
  lastUpdated: number;
}

export interface DdosIndicatorsData {
  range: string;
  summary: {
    totalSpikes: number;
    activeAlerts: number;
    highestMultiplier: number;
    currentConnectionRate: number;
  };
  connectionRateTimeline: Array<{
    timestamp: number;
    rate: number;
    isAnomaly: boolean;
    normalRate: number;
  }>;
  activeAlerts: Array<{
    id: number;
    timestamp: number;
    serverId: string;
    region: string;
    currentRate: number;
    normalRate: number;
    multiplier: number;
    severity: string;
  }>;
  lastUpdated: number;
}

// ─── Bad Client Detection (US-7.2) ─────────────

export interface BadClientViolations {
  malformedMessages: number;
  signatureFailures: number;
  protocolViolations: number;
  other: number;
}

export interface BadClientEntry {
  sourceIp: string;
  violationCount: number;
  lastSeen: number;
  firstSeen: number;
  violations: BadClientViolations;
  severity: string;
}

export interface BadClientSummary {
  totalBadClients: number;
  totalViolations: number;
  quarantinedCount: number;
}

export interface BadClientsData {
  range: string;
  summary: BadClientSummary;
  clients: BadClientEntry[];
  total: number;
  limit: number;
  offset: number;
  lastUpdated: number;
}

// ─── Pairing Code Brute Force Detection (US-7.4) ─

export interface PairingBruteForceSummary {
  totalFailedAttempts: number;
  uniqueSessions: number;
  alertCount: number;
  threshold: number;
}

export interface PairingBruteForceTimelineEntry {
  timestamp: number;
  failedAttempts: number;
  uniqueSessions: number;
}

export interface PairingBruteForceOffender {
  sourceIp: string;
  failedAttempts: number;
  firstSeen: number;
  lastSeen: number;
}

export interface PairingBruteForceData {
  range: string;
  summary: PairingBruteForceSummary;
  timeline: PairingBruteForceTimelineEntry[];
  topOffenders: PairingBruteForceOffender[];
  lastUpdated: number;
}

// ─── Alert Rules (US-8.4) ──────────────────────

export type AlertConditionType =
  | 'error_rate'
  | 'server_offline'
  | 'attack_detected'
  | 'ai_issue'
  | 'error_spike'
  | 'error_rate_spike'
  | 'rate_limit_violations'
  | 'high_latency'
  | 'low_success_rate'
  | 'disk_usage_high'
  | 'memory_usage_high'
  | 'new_critical_crash';

export type AlertThresholdUnit = 'per_hour' | 'minutes' | 'multiplier' | 'percent' | 'ms';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertChannel = 'dashboard' | 'email' | 'webhook';

/** Alert rule as stored in D1 (snake_case columns) */
export interface AlertRule {
  id: number;
  name: string;
  condition_type: AlertConditionType;
  threshold_value: number | null;
  threshold_unit: AlertThresholdUnit | null;
  severity: AlertSeverity;
  channels: string;
  enabled: number;
  cooldown_minutes: number;
  is_default: number;
  created_by: string;
  created_at: number;
  last_triggered_at: number | null;
}

/** Alert rule data for API responses (camelCase) */
export interface AlertRuleData {
  id: number;
  name: string;
  conditionType: AlertConditionType;
  thresholdValue: number | null;
  thresholdUnit: AlertThresholdUnit | null;
  severity: AlertSeverity;
  channels: AlertChannel[];
  enabled: boolean;
  cooldownMinutes: number;
  isDefault: boolean;
  createdBy: string;
  createdAt: number;
  lastTriggeredAt: number | null;
}

export interface AlertRuleCreateRequest {
  name: string;
  conditionType: AlertConditionType;
  thresholdValue?: number | null;
  thresholdUnit?: AlertThresholdUnit | null;
  severity: AlertSeverity;
  channels: AlertChannel[];
  enabled?: boolean;
  cooldownMinutes?: number;
}

export interface AlertRuleUpdateRequest {
  name?: string;
  conditionType?: AlertConditionType;
  thresholdValue?: number | null;
  thresholdUnit?: AlertThresholdUnit | null;
  severity?: AlertSeverity;
  channels?: AlertChannel[];
  enabled?: boolean;
  cooldownMinutes?: number;
}

export interface AlertRulesListData {
  rules: AlertRuleData[];
  total: number;
}

/** Alert history row from D1 (snake_case) */
export interface AlertHistoryRow {
  id: number;
  rule_id: number;
  triggered_at: number;
  message: string;
  channels_notified: string;
  delivery_status: string | null;
  delivery_error: string | null;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
}

/** Alert history entry for API responses (camelCase) */
export interface AlertHistoryEntry {
  id: number;
  ruleId: number;
  triggeredAt: number;
  message: string;
  channelsNotified: AlertChannel[];
  deliveryStatus: string | null;
  deliveryError: string | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

export interface AlertHistoryListData {
  entries: AlertHistoryEntry[];
  total: number;
}

/** Result from evaluating a single alert condition */
export interface ConditionResult {
  triggered: boolean;
  message: string;
  metricValue?: number;
}

/** Result from the alert engine evaluating a rule that fired */
export interface AlertEvalResult {
  ruleId: number;
  ruleName: string;
  conditionType: AlertConditionType;
  severity: AlertSeverity;
  channels: AlertChannel[];
  message: string;
  metricValue?: number;
}

// ─── Notifications (US-8.1, US-8.2, US-8.3) ──

export interface NotificationEntry {
  id: number;
  ruleId: number | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  source: string;
  channelsNotified: string[] | null;
  createdAt: number;
  readAt: number | null;
  readBy: string | null;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

export interface NotificationsListData {
  notifications: NotificationEntry[];
  total: number;
  limit: number;
  offset: number;
  lastUpdated: number;
}

export interface WebhookConfig {
  url: string;
  authHeader?: string;
  severityFilter: string[];
}

export interface EmailConfig {
  addresses: string[];
  severityFilter: string[];
  cooldownMinutes: number;
}

export interface DashboardConfig {
  soundEnabled: boolean;
  severityFilter: string[];
}

export interface NotificationConfigEntry {
  id: number;
  channelType: 'email' | 'webhook' | 'dashboard';
  enabled: boolean;
  config: WebhookConfig | EmailConfig | DashboardConfig;
  updatedAt: number;
  updatedBy: string;
}

export interface NotificationConfigData {
  channels: NotificationConfigEntry[];
  lastUpdated: number;
}

// ─── Real-Time Notifications (US-8.1, US-8.2, US-8.3) ──

/** Notification payload sent by internal services to NotificationDO */
export interface NotificationPayload {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  category: 'error_rate' | 'server_offline' | 'ai_issue' | 'security' | 'system';
  link?: string;
  ruleId?: number;
  source?: string;
}

/** Notification as stored in DO storage */
export interface StoredNotification {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  message: string;
  category: string;
  link?: string;
  timestamp: number;
  readBy: string[];
}

/** WebSocket messages sent to dashboard clients */
export type NotificationWsMessage =
  | { type: 'notification'; data: StoredNotification }
  | { type: 'notification_list'; data: StoredNotification[]; unreadCount: number }
  | { type: 'read_ack'; id: string };

/** WebSocket messages received from dashboard clients */
export type NotificationClientMessage =
  | { type: 'mark_read'; id: string }
  | { type: 'mark_all_read' };

/** WebSocket attachment persisted across hibernation */
export interface WsSessionAttachment {
  userId: string;
  username: string;
  role: 'admin' | 'super-admin';
  connectedAt: number;
}

/** Webhook payload format */
export type WebhookFormat = 'generic' | 'slack' | 'discord';

/** Extended webhook channel config with format and label */
export interface WebhookChannelConfig {
  url: string;
  authHeader?: string;
  label?: string;
  format: WebhookFormat;
  severityFilter: string[];
  cooldownMinutes: number;
}

/** Extended email channel config */
export interface EmailChannelConfig {
  address: string;
  severityFilter: string[];
  cooldownMinutes: number;
}

/** Webhook retry entry stored in DO storage */
export interface WebhookRetry {
  webhookConfigId: number;
  url: string;
  authHeader?: string;
  format: WebhookFormat;
  payload: NotificationPayload;
  firstAttemptAt: number;
  httpStatus?: number;
  errorMessage?: string;
}
