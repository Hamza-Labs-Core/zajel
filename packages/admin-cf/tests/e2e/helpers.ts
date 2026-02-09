/**
 * E2E Test Helpers for Admin CF
 *
 * Provides an AdminApiClient that wraps fetch() with token management,
 * plus cleanup utilities for idempotent test runs.
 */

// --- Configuration ---

export const BASE_URL =
  process.env['ADMIN_CF_URL'] || 'https://admin.zajel.qa.hamzalabs.dev';

export const SUPER_ADMIN_CREDS = {
  username: process.env['ADMIN_CF_USERNAME'] || 'admin',
  password: process.env['ADMIN_CF_PASSWORD'] || 'admin1234567890',
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
