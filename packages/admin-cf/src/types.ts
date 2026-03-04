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
