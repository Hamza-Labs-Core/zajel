/**
 * Admin Dashboard Types for VPS Server
 */

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
 * Metrics snapshot for dashboard
 */
export interface MetricsSnapshot {
  timestamp: number;
  connections: {
    total: number;
    relay: number;
    signaling: number;
  };
  entropy: {
    activeCodes: number;
    peakActiveCodes: number;
    collisionRisk: 'low' | 'medium' | 'high';
    collisionAttempts: number;
  };
  federation: {
    aliveMembers: number;
    suspectMembers: number;
    totalMembers: number;
    regions: Record<string, number>;
  };
  messageRate: {
    perSecond: number;
    perMinute: number;
  };
}

/**
 * Historical metrics entry
 */
export interface HistoricalMetrics {
  snapshots: MetricsSnapshot[];
  startTime: number;
  endTime: number;
}

/**
 * Federation topology for visualization
 */
export interface FederationTopology {
  nodes: FederationNode[];
  edges: FederationEdge[];
}

export interface FederationNode {
  id: string;
  region: string;
  status: 'alive' | 'suspect' | 'failed' | 'left' | 'unknown';
  isLocal: boolean;
}

export interface FederationEdge {
  source: string;
  target: string;
  latency?: number;
}

/**
 * Scaling recommendation
 */
export interface ScalingRecommendation {
  level: 'normal' | 'warning' | 'critical';
  message: string;
  metrics: {
    connectionLoad: number;
    entropyPressure: number;
    federationHealth: number;
  };
  recommendations: string[];
}

/**
 * Real-time metrics message (WebSocket)
 */
export type AdminWsMessage =
  | { type: 'metrics'; data: MetricsSnapshot }
  | { type: 'federation'; data: FederationTopology }
  | { type: 'alert'; data: { level: 'info' | 'warning' | 'error'; message: string } };

/**
 * API response types
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Admin module configuration
 */
export interface AdminConfig {
  jwtSecret: string;
  cfAdminUrl?: string;
  metricsHistorySeconds?: number;
}
