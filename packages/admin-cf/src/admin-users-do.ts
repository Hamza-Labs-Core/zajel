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
} from './types.js';

export class AdminUsersDO implements DurableObject {
  private state: DurableObjectState;
  private env: { JWT_SECRET: string };

  constructor(state: DurableObjectState, env: { JWT_SECRET: string }) {
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

    // Generate JWT
    const token = await generateJwt(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
      },
      this.env.JWT_SECRET,
      15 // 15 minutes
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
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return this.jsonResponse(
        { success: false, error: 'Missing authorization header' },
        401
      );
    }

    const token = authHeader.substring(7);
    const payload = await verifyJwt<JwtPayload>(token, this.env.JWT_SECRET);
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
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return this.jsonResponse(
        { success: false, error: 'Missing authorization header' },
        401
      );
    }

    const token = authHeader.substring(7);
    const payload = await verifyJwt<JwtPayload>(token, this.env.JWT_SECRET);
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
