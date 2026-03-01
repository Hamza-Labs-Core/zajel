/**
 * JWT Authentication for VPS Admin Dashboard
 *
 * Verifies JWTs using the shared secret with CF Workers.
 * No network calls needed - verification is purely cryptographic.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { JwtPayload, ApiResponse } from './types.js';

/**
 * Verify and decode a JWT token
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return null;
  }

  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  // Compute expected signature
  const expectedSignature = createHmac('sha256', secret)
    .update(signatureInput)
    .digest();

  // Decode provided signature
  const providedSignature = Buffer.from(
    base64UrlDecode(encodedSignature),
    'binary'
  );

  // Timing-safe comparison
  if (
    expectedSignature.length !== providedSignature.length ||
    !timingSafeEqual(expectedSignature, providedSignature)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as JwtPayload;

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch (error) {
    console.warn('[Admin Auth] JWT verification failed:', error);
    return null;
  }
}

/**
 * Extract JWT from request (header or query param for initial auth)
 */
export function extractToken(req: IncomingMessage): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check query parameter (for initial redirect from CF dashboard)
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken;
  }

  // Check cookie
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/zajel_vps_token=([^;]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Require authentication middleware
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  jwtSecret: string
): JwtPayload | null {
  const token = extractToken(req);
  if (!token) {
    sendJson(res, { success: false, error: 'Unauthorized' }, 401);
    return null;
  }

  const payload = verifyJwt(token, jwtSecret);
  if (!payload) {
    sendJson(res, { success: false, error: 'Invalid or expired token' }, 401);
    return null;
  }

  return payload;
}

/**
 * Base64URL decode
 */
function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('binary');
}

/**
 * Send JSON response
 */
export function sendJson<T>(
  res: ServerResponse,
  data: ApiResponse<T>,
  status = 200,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

/**
 * Set authentication cookie (after verifying token from URL)
 */
export function setAuthCookie(res: ServerResponse, token: string, isSecure = false): void {
  // 4 hour expiry, matching JWT
  const maxAge = 4 * 60 * 60;
  const securePart = isSecure ? '; Secure' : '';
  const sameSite = isSecure ? 'Strict' : 'Lax';
  res.setHeader(
    'Set-Cookie',
    `zajel_vps_token=${token}; Path=/admin; Max-Age=${maxAge}; HttpOnly${securePart}; SameSite=${sameSite}`
  );
}
