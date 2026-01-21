/**
 * Auth route handlers for CF Admin Dashboard
 */

import type { Env, ApiResponse, JwtPayload } from '../types.js';
import { verifyJwt } from '../crypto.js';

/**
 * Handle login - proxies to Durable Object
 */
export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  return stub.fetch(new Request('http://do/login', {
    method: 'POST',
    body: request.body,
    headers: request.headers,
  }));
}

/**
 * Handle logout - clears the cookie
 */
export function handleLogout(): Response {
  return new Response(
    JSON.stringify({ success: true }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'zajel_admin_token=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict',
      },
    }
  );
}

/**
 * Handle token verification - proxies to Durable Object
 */
export async function handleVerify(
  request: Request,
  env: Env
): Promise<Response> {
  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  return stub.fetch(new Request('http://do/verify', {
    method: 'GET',
    headers: request.headers,
  }));
}

/**
 * Initialize admin system with first super-admin
 */
export async function handleInit(
  request: Request,
  env: Env
): Promise<Response> {
  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);
  return stub.fetch(new Request('http://do/init', {
    method: 'POST',
    body: request.body,
    headers: request.headers,
  }));
}

/**
 * Extract and verify JWT from request
 */
export async function extractAuthPayload(
  request: Request,
  env: Env
): Promise<JwtPayload | null> {
  // Check Authorization header first
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    return verifyJwt<JwtPayload>(token, env.ZAJEL_ADMIN_JWT_SECRET);
  }

  // Then check cookie
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/zajel_admin_token=([^;]+)/);
    if (match?.[1]) {
      return verifyJwt<JwtPayload>(match[1], env.ZAJEL_ADMIN_JWT_SECRET);
    }
  }

  return null;
}

/**
 * Middleware: Require authentication
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<JwtPayload | Response> {
  const payload = await extractAuthPayload(request, env);
  if (!payload) {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }
  return payload;
}

/**
 * Middleware: Require super-admin role
 */
export async function requireSuperAdmin(
  request: Request,
  env: Env
): Promise<JwtPayload | Response> {
  const result = await requireAuth(request, env);
  if (result instanceof Response) {
    return result;
  }

  if (result.role !== 'super-admin') {
    return jsonResponse({ success: false, error: 'Super-admin access required' }, 403);
  }

  return result;
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

export type { JwtPayload };
