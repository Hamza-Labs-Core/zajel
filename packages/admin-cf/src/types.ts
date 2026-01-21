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
 * Environment bindings for CF Worker
 */
export interface Env {
  ADMIN_USERS: DurableObjectNamespace;
  JWT_SECRET: string;
  ZAJEL_BOOTSTRAP_URL?: string;
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
