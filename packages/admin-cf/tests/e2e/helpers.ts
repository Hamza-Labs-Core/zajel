/**
 * E2E Test Helpers for Admin CF
 *
 * Provides an AdminApiClient that wraps fetch() with token management,
 * plus cleanup utilities for idempotent test runs.
 */

// --- Configuration ---

export const BASE_URL =
  process.env['ADMIN_CF_URL'] || 'https://admin.zajel.qa.hamzalabs.dev';

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value) return value;
  if (fallback) return fallback;
  throw new Error(`Required env var ${name} is not set`);
}

export const SUPER_ADMIN_CREDS = {
  username: requireEnv('ADMIN_CF_USERNAME', 'admin'),
  password: requireEnv('ADMIN_CF_PASSWORD'),
};

export const TEST_USER_PREFIX = 'e2e_test_user_';

// --- Response Interfaces ---

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AdminUserPublic {
  id: string;
  username: string;
  role: 'admin' | 'super-admin';
  createdAt: number;
  lastLogin: number | null;
}

export interface LoginData {
  token: string;
  user: AdminUserPublic;
}

export interface VerifyData {
  userId: string;
  username: string;
  role: string;
}

export interface ServerStats {
  connections: number;
  relayConnections: number;
  signalingConnections: number;
  activeCodes: number;
  collisionRisk: string;
}

export interface VpsServer {
  id: string;
  endpoint: string;
  region: string;
  lastHeartbeat: number;
  status: 'healthy' | 'degraded' | 'offline';
  stats?: ServerStats;
}

export interface AggregateStats {
  totalServers: number;
  healthyServers: number;
  degradedServers: number;
  offlineServers: number;
  totalConnections: number;
  byRegion: Record<string, number>;
}

export interface ServersData {
  servers: VpsServer[];
  aggregate: AggregateStats;
}

export interface HealthData {
  status: string;
  service: string;
  version: string;
  timestamp: string;
}

export interface GenerateCodeData {
  code: string;
}

export interface ExchangeCodeData {
  token: string;
}

export interface ErrorAggregate {
  errorSignature: string;
  category: string;
  totalCount: number;
  versions: string[];
  platforms: string[];
  firstSeen: number;
  lastSeen: number;
  sampleMessage: string;
}

export interface ErrorSummary {
  totalErrors: number;
  rateChangePercent: number;
  regressionAlerts: number;
  highestSeverity: string;
}

export interface ErrorsData {
  summary: ErrorSummary;
  errors: ErrorAggregate[];
  range: string;
}

export interface Regression {
  errorSignature: string;
  category: string;
  currentVersion: string;
  previousVersion: string;
  currentRate: number;
  previousRate: number;
  multiplier: number;
  currentTotal: number;
  previousTotal: number;
  firstDetected: number;
  sampleMessage: string;
}

export interface DeploymentMarker {
  version: string;
  timestamp: number;
}

export interface ErrorTrendsData {
  timestamps: number[];
  series: Record<string, number[]>;
  deployments: DeploymentMarker[];
  range: string;
  bucketSize: string;
}

export interface RegressionsData {
  regressions: Regression[];
  currentVersion: string;
  previousVersion: string;
  window: string;
  threshold: number;
  computedAt: number;
}

// --- Admin API Client ---

export class AdminApiClient {
  private token: string | null = null;
  private baseUrl: string;

  constructor(baseUrl: string = BASE_URL) {
    this.baseUrl = baseUrl;
  }

  getToken(): string | null {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  clearToken(): void {
    this.token = null;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.token) {
      h['Authorization'] = `Bearer ${this.token}`;
    }
    return h;
  }

  // --- Health ---

  async health(): Promise<Response> {
    return fetch(`${this.baseUrl}/health`);
  }

  // --- Auth ---

  async init(username: string, password: string): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  async login(username: string, password: string): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  async loginAndStore(username: string, password: string): Promise<ApiResponse<LoginData>> {
    const res = await this.login(username, password);
    const body = (await res.json()) as ApiResponse<LoginData>;
    if (body.success && body.data?.token) {
      this.token = body.data.token;
    }
    return body;
  }

  async verify(token?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    const t = token ?? this.token;
    if (t) {
      headers['Authorization'] = `Bearer ${t}`;
    }
    return fetch(`${this.baseUrl}/admin/api/auth/verify`, {
      method: 'GET',
      headers,
    });
  }

  async logout(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/auth/logout`, {
      method: 'POST',
      headers: this.headers(),
    });
  }

  // --- Users ---

  async listUsers(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/users`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  async listUsersNoAuth(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/users`, {
      method: 'GET',
    });
  }

  async createUser(
    username: string,
    password: string,
    role: 'admin' | 'super-admin' = 'admin'
  ): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/users`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ username, password, role }),
    });
  }

  async createUserNoAuth(
    username: string,
    password: string,
    role: 'admin' | 'super-admin' = 'admin'
  ): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
  }

  async deleteUser(userId: string): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/users/${userId}`, {
      method: 'DELETE',
      headers: this.headers(),
    });
  }

  async deleteUserNoAuth(userId: string): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/users/${userId}`, {
      method: 'DELETE',
    });
  }

  // --- Servers ---

  async listServers(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/servers`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  async listServersNoAuth(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/servers`, {
      method: 'GET',
    });
  }

  // --- Generic fetch (for custom requests like auth code endpoints) ---

  async fetchPath(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    // If no Authorization header is set in options but we have a token, add it
    const headers = new Headers(options.headers);
    if (this.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    return fetch(url, { ...options, headers });
  }

  // --- Errors ---

  async listErrors(range?: string): Promise<Response> {
    const query = range ? `?range=${encodeURIComponent(range)}` : '';
    return fetch(`${this.baseUrl}/admin/api/errors${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  async listErrorsNoAuth(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/errors`, {
      method: 'GET',
    });
  }

  // --- Error Trends ---

  async getErrorTrends(range?: string, category?: string): Promise<Response> {
    const params = new URLSearchParams();
    if (range) params.set('range', range);
    if (category) params.set('category', category);
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetch(`${this.baseUrl}/admin/api/errors/trends${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  async getErrorTrendsNoAuth(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/errors/trends`, {
      method: 'GET',
    });
  }

  // --- Regressions ---

  async getErrorRegressions(window?: string, threshold?: number): Promise<Response> {
    const params = new URLSearchParams();
    if (window) params.set('window', window);
    if (threshold !== undefined) params.set('threshold', String(threshold));
    const query = params.toString() ? `?${params.toString()}` : '';
    return fetch(`${this.baseUrl}/admin/api/errors/regressions${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  async getErrorRegressionsNoAuth(): Promise<Response> {
    return fetch(`${this.baseUrl}/admin/api/errors/regressions`, {
      method: 'GET',
    });
  }

  // --- Raw requests ---

  async rawGet(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { redirect: 'manual' });
  }

  async rawRequest(path: string, method: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
    });
  }

  async options(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { method: 'OPTIONS' });
  }
}

// --- Convenience Functions ---

export async function loginAsSuperAdmin(
  client: AdminApiClient
): Promise<ApiResponse<LoginData>> {
  return client.loginAndStore(SUPER_ADMIN_CREDS.username, SUPER_ADMIN_CREDS.password);
}

/**
 * Remove all users whose username starts with TEST_USER_PREFIX.
 * Requires a super-admin token already set on the client.
 */
export async function cleanupTestUsers(client: AdminApiClient): Promise<void> {
  const res = await client.listUsers();
  if (!res.ok) return;

  const body = (await res.json()) as ApiResponse<AdminUserPublic[]>;
  if (!body.success || !body.data) return;

  for (const user of body.data) {
    if (user.username.startsWith(TEST_USER_PREFIX)) {
      await client.deleteUser(user.id);
    }
  }
}

/**
 * Generate a unique test username with timestamp.
 */
export function testUsername(): string {
  return `${TEST_USER_PREFIX}${Date.now()}`;
}
