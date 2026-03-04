/**
 * Authorization code generation and exchange routes
 * Implements OAuth2-style code exchange for cross-origin auth
 */

import type { Env, GenerateCodeData, ExchangeCodeRequest, ExchangeCodeData, JwtPayload } from '../types.js';
import { verifyJwt } from '../crypto.js';

/**
 * Generate a short-lived authorization code for VPS redirect
 * Requires authentication
 */
export async function handleGenerateCode(request: Request, env: Env): Promise<Response> {
  // Verify the user is authenticated
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(
      { success: false, error: 'Missing authorization header' },
      401
    );
  }

  const token = authHeader.substring(7);
  const payload = await verifyJwt<JwtPayload>(token, env.ZAJEL_ADMIN_JWT_SECRET);
  if (!payload) {
    return jsonResponse(
      { success: false, error: 'Invalid or expired token' },
      401
    );
  }

  // Generate a cryptographically secure random code
  const codeBytes = new Uint8Array(32);
  crypto.getRandomValues(codeBytes);
  const code = Array.from(codeBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Store the code in AdminUsersDO with 30-second TTL
  const expiresAt = Date.now() + 30_000; // 30 seconds

  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);

  const storeRes = await stub.fetch(new Request('http://do/auth-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      payload: {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
      },
      expiresAt,
    }),
  }));

  if (!storeRes.ok) {
    return jsonResponse(
      { success: false, error: 'Failed to store authorization code' },
      500
    );
  }

  return jsonResponse({
    success: true,
    data: { code } as GenerateCodeData,
  });
}

/**
 * Exchange an authorization code for a JWT token
 * Called by VPS servers (server-to-server)
 *
 * This endpoint is intentionally unauthenticated. Protection is provided by:
 * - 256-bit random code (computationally infeasible to brute force)
 * - 30-second TTL
 * - Single-use enforcement
 * Rate limiting on this endpoint is recommended as defense-in-depth.
 */
export async function handleExchangeCode(request: Request, env: Env): Promise<Response> {
  let body: ExchangeCodeRequest;
  try {
    body = await request.json() as ExchangeCodeRequest;
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid JSON body' },
      400
    );
  }

  if (!body.code) {
    return jsonResponse(
      { success: false, error: 'Code required' },
      400
    );
  }

  // Exchange code for token via AdminUsersDO
  const id = env.ADMIN_USERS.idFromName('admin-users');
  const stub = env.ADMIN_USERS.get(id);

  const exchangeRes = await stub.fetch(new Request('http://do/auth-codes/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: body.code }),
  }));

  const exchangeData = await exchangeRes.json();

  // Return the DO's response directly (it handles validation and error messages)
  return new Response(JSON.stringify(exchangeData), {
    status: exchangeRes.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function jsonResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
