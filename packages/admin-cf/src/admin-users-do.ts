/**
 * AdminUsersDO - Durable Object for admin user management
 *
 * Stores admin users with password hashes and handles CRUD operations.
 * This is the source of truth for authentication across all dashboards.
 */

import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateId,
  generateJwt,
  verifyJwt,
} from './crypto.js';
import type {
  AdminUser,
  AdminUserPublic,
  JwtPayload,
  LoginRequest,
  CreateUserRequest,
  ApiResponse,
  AuthCode,
} from './types.js';

export class AdminUsersDO implements DurableObject {
  private state: DurableObjectState;
  private env: { ZAJEL_ADMIN_JWT_SECRET: string };

  constructor(state: DurableObjectState, env: { ZAJEL_ADMIN_JWT_SECRET: string }) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Route requests
      if (path === '/login' && method === 'POST') {
        return this.handleLogin(request);
      }

      if (path === '/verify' && method === 'GET') {
        return this.handleVerify(request);
      }

      if (path === '/users' && method === 'GET') {
        return this.handleListUsers(request);
      }

      if (path === '/users' && method === 'POST') {
        return this.handleCreateUser(request);
      }

      if (path.startsWith('/users/') && method === 'DELETE') {
        const userId = path.substring('/users/'.length);
        return this.handleDeleteUser(request, userId);
      }

      if (path === '/init' && method === 'POST') {
        return this.handleInit(request);
      }

      if (path === '/auth-codes' && method === 'POST') {
        return this.handleStoreAuthCode(request);
      }

      if (path === '/auth-codes/exchange' && method === 'POST') {
        return this.handleExchangeAuthCode(request);
      }

      return this.jsonResponse({ success: false, error: 'Not found' }, 404);
    } catch (error) {
      console.error('AdminUsersDO error:', error);
      return this.jsonResponse(
        { success: false, error: 'Internal server error' },
        500
      );
    }
  }

  /**
   * Store a short-lived authorization code
   * Called by CF Worker when generating a code for VPS redirect
   */
  private async handleStoreAuthCode(request: Request): Promise<Response> {
    const body = await request.json() as {
      code: string;
      payload: JwtPayload;
      expiresAt: number;
    };

    if (!body.code || !body.payload || !body.expiresAt) {
      return this.jsonResponse(
        { success: false, error: 'Invalid request' },
        400
      );
    }

    const authCode: AuthCode = {
      code: body.code,
      payload: body.payload,
      createdAt: Date.now(),
      expiresAt: body.expiresAt,
      used: false,
    };

    await this.state.storage.put(`authcode:${body.code}`, authCode);

    // Set alarm for cleanup (30 seconds + 5 second buffer)
    const cleanupDelay = body.expiresAt - Date.now() + 5000;
    if (cleanupDelay > 0) {
      await this.state.storage.setAlarm(Date.now() + cleanupDelay);
    }

    return this.jsonResponse({ success: true });
  }

  /**
   * Exchange an authorization code for a JWT token
   * Called by VPS server via server-to-server request
   */
  private async handleExchangeAuthCode(request: Request): Promise<Response> {
    const body = await request.json() as { code: string };

    if (!body.code) {
      return this.jsonResponse(
        { success: false, error: 'Code required' },
        400
      );
    }

    const authCode = await this.state.storage.get<AuthCode>(`authcode:${body.code}`);

    if (!authCode) {
      return this.jsonResponse(
        { success: false, error: 'Invalid or expired code' },
        401
      );
    }

    // Check expiration
    if (Date.now() > authCode.expiresAt) {
      await this.state.storage.delete(`authcode:${body.code}`);
      return this.jsonResponse(
        { success: false, error: 'Code expired' },
        401
      );
    }

    // Check single-use
    if (authCode.used) {
      return this.jsonResponse(
        { success: false, error: 'Code already used' },
        401
      );
    }

    // Mark as used and delete immediately (single-use)
    await this.state.storage.delete(`authcode:${body.code}`);

    // Generate a new JWT with the stored payload
    const token = await generateJwt(
      {
        sub: authCode.payload.sub,
        username: authCode.payload.username,
        role: authCode.payload.role,
      },
      this.env.ZAJEL_ADMIN_JWT_SECRET,
      240 // 4 hours
    );

    return this.jsonResponse({
      success: true,
      data: { token },
    });
  }

  /**
   * Alarm handler for cleaning up expired auth codes
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const allKeys = await this.state.storage.list<AuthCode>({ prefix: 'authcode:' });

    for (const [key, authCode] of allKeys.entries()) {
      if (authCode.expiresAt < now) {
        await this.state.storage.delete(key);
      }
    }
  }

  /**
   * Initialize with first super-admin user if no users exist
   */
  private async handleInit(request: Request): Promise<Response> {
    const users = await this.getAllUsers();
    if (users.length > 0) {
      return this.jsonResponse(
        { success: false, error: 'Already initialized' },
        400
      );
    }

    const body = await request.json() as CreateUserRequest;
    if (!body.username || !body.password) {
      return this.jsonResponse(
        { success: false, error: 'Username and password required' },
        400
      );
    }

    if (body.password.length < 12) {
      return this.jsonResponse(
        { success: false, error: 'Password must be at least 12 characters' },
        400
      );
    }

    const user = await this.createUser(body.username, body.password, 'super-admin');
    return this.jsonResponse({
      success: true,
      data: this.toPublicUser(user),
    });
  }

  /**
   * Handle login request
   */
  private async handleLogin(request: Request): Promise<Response> {
    const body = await request.json() as LoginRequest;
    if (!body.username || !body.password) {
      return this.jsonResponse(
        { success: false, error: 'Username and password required' },
        400
      );
    }

    const user = await this.getUserByUsername(body.username);
    if (!user) {
      // Timing-safe: still do hash comparison to prevent timing attacks
      await hashPassword(body.password, generateSalt());
      return this.jsonResponse(
        { success: false, error: 'Invalid credentials' },
        401
      );
    }

    const isValid = await verifyPassword(body.password, user.passwordHash, user.salt);
    if (!isValid) {
      return this.jsonResponse(
        { success: false, error: 'Invalid credentials' },
        401
      );
    }

    // Update last login
    user.lastLogin = Date.now();
    await this.state.storage.put(`user:${user.id}`, user);

    // Generate JWT (4 hours — long enough for a dashboard session)
    const token = await generateJwt(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
      },
      this.env.ZAJEL_ADMIN_JWT_SECRET,
      240 // 4 hours
    );

    return this.jsonResponse({
      success: true,
      data: {
        token,
        user: this.toPublicUser(user),
      },
    });
  }

  /**
   * Verify JWT token (used by VPS servers)
   */
  private async handleVerify(request: Request): Promise<Response> {
    const token = this.extractToken(request);
    if (!token) {
      return this.jsonResponse(
        { success: false, error: 'Missing authorization' },
        401
      );
    }

    const payload = await verifyJwt<JwtPayload>(token, this.env.ZAJEL_ADMIN_JWT_SECRET);
    if (!payload) {
      return this.jsonResponse(
        { success: false, error: 'Invalid or expired token' },
        401
      );
    }

    // Verify user still exists
    const user = await this.state.storage.get<AdminUser>(`user:${payload.sub}`);
    if (!user) {
      return this.jsonResponse(
        { success: false, error: 'User no longer exists' },
        401
      );
    }

    return this.jsonResponse({
      success: true,
      data: {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
      },
    });
  }

  /**
   * List all admin users (requires auth)
   */
  private async handleListUsers(request: Request): Promise<Response> {
    const authResult = await this.requireAuth(request);
    if (authResult instanceof Response) {
      return authResult;
    }

    const users = await this.getAllUsers();
    return this.jsonResponse({
      success: true,
      data: users.map((u) => this.toPublicUser(u)),
    });
  }

  /**
   * Create a new admin user (requires super-admin)
   */
  private async handleCreateUser(request: Request): Promise<Response> {
    const authResult = await this.requireAuth(request, 'super-admin');
    if (authResult instanceof Response) {
      return authResult;
    }

    const body = await request.json() as CreateUserRequest;
    if (!body.username || !body.password) {
      return this.jsonResponse(
        { success: false, error: 'Username and password required' },
        400
      );
    }

    if (body.password.length < 12) {
      return this.jsonResponse(
        { success: false, error: 'Password must be at least 12 characters' },
        400
      );
    }

    // Check for duplicate username
    const existing = await this.getUserByUsername(body.username);
    if (existing) {
      return this.jsonResponse(
        { success: false, error: 'Username already exists' },
        409
      );
    }

    const role = body.role || 'admin';
    const user = await this.createUser(body.username, body.password, role);

    return this.jsonResponse({
      success: true,
      data: this.toPublicUser(user),
    });
  }

  /**
   * Delete an admin user (requires super-admin)
   */
  private async handleDeleteUser(
    request: Request,
    userId: string
  ): Promise<Response> {
    const authResult = await this.requireAuth(request, 'super-admin');
    if (authResult instanceof Response) {
      return authResult;
    }

    // Prevent deleting yourself
    if (authResult.sub === userId) {
      return this.jsonResponse(
        { success: false, error: 'Cannot delete yourself' },
        400
      );
    }

    const user = await this.state.storage.get<AdminUser>(`user:${userId}`);
    if (!user) {
      return this.jsonResponse(
        { success: false, error: 'User not found' },
        404
      );
    }

    // Remove from username index
    await this.state.storage.delete(`username:${user.username}`);
    await this.state.storage.delete(`user:${userId}`);

    // Update user list
    const userIds = (await this.state.storage.get<string[]>('userIds')) || [];
    const updatedIds = userIds.filter((id) => id !== userId);
    await this.state.storage.put('userIds', updatedIds);

    return this.jsonResponse({ success: true });
  }

  /**
   * Require authentication for a request
   */
  private async requireAuth(
    request: Request,
    requiredRole?: 'admin' | 'super-admin'
  ): Promise<JwtPayload | Response> {
    const token = this.extractToken(request);
    if (!token) {
      return this.jsonResponse(
        { success: false, error: 'Missing authorization' },
        401
      );
    }

    const payload = await verifyJwt<JwtPayload>(token, this.env.ZAJEL_ADMIN_JWT_SECRET);
    if (!payload) {
      return this.jsonResponse(
        { success: false, error: 'Invalid or expired token' },
        401
      );
    }

    if (requiredRole === 'super-admin' && payload.role !== 'super-admin') {
      return this.jsonResponse(
        { success: false, error: 'Super-admin access required' },
        403
      );
    }

    return payload;
  }

  /**
   * Extract JWT token from Authorization header or cookie
   */
  private extractToken(request: Request): string | null {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    const cookie = request.headers.get('Cookie');
    if (cookie) {
      const match = cookie.match(/zajel_admin_token=([^;]+)/);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  /**
   * Create a new user
   */
  private async createUser(
    username: string,
    password: string,
    role: 'admin' | 'super-admin'
  ): Promise<AdminUser> {
    const id = generateId();
    const salt = generateSalt();
    const passwordHash = await hashPassword(password, salt);

    const user: AdminUser = {
      id,
      username,
      passwordHash,
      salt,
      role,
      createdAt: Date.now(),
      lastLogin: null,
    };

    await this.state.storage.put(`user:${id}`, user);
    await this.state.storage.put(`username:${username}`, id);

    // Track user IDs for listing
    const userIds = (await this.state.storage.get<string[]>('userIds')) || [];
    userIds.push(id);
    await this.state.storage.put('userIds', userIds);

    return user;
  }

  /**
   * Get user by username
   */
  private async getUserByUsername(username: string): Promise<AdminUser | null> {
    const userId = await this.state.storage.get<string>(`username:${username}`);
    if (!userId) {
      return null;
    }
    const user = await this.state.storage.get<AdminUser>(`user:${userId}`);
    return user ?? null;
  }

  /**
   * Get all users
   */
  private async getAllUsers(): Promise<AdminUser[]> {
    const userIds = (await this.state.storage.get<string[]>('userIds')) || [];
    const users: AdminUser[] = [];

    for (const id of userIds) {
      const user = await this.state.storage.get<AdminUser>(`user:${id}`);
      if (user) {
        users.push(user);
      }
    }

    return users;
  }

  /**
   * Convert to public user (strip sensitive fields)
   */
  private toPublicUser(user: AdminUser): AdminUserPublic {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  }

  /**
   * JSON response helper
   */
  private jsonResponse<T>(data: ApiResponse<T>, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }
}
