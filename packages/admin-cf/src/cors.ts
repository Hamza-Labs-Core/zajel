/**
 * CORS utility module for Zajel Admin Dashboard.
 *
 * Provides origin-based CORS header generation instead of wildcard (*).
 * The allowlist is read from the ADMIN_ALLOWED_ORIGINS environment variable.
 */

import type { Env } from './types.js';

/**
 * Security headers that should be applied to ALL responses,
 * including dashboard HTML, API responses, and error responses.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/**
 * Get CORS headers for a given request. Checks the request's Origin header
 * against the allowlist and returns matching CORS headers.
 *
 * Always includes Vary: Origin to prevent cache poisoning even when no
 * Access-Control-Allow-Origin is set (defense-in-depth).
 *
 * @param request - The incoming request
 * @param env - Cloudflare Worker environment bindings
 * @returns CORS headers object
 */
export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    ...SECURITY_HEADERS,
  };

  if (origin && isOriginAllowed(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

/**
 * Check if an origin is in the allowlist.
 * Supports exact matches and localhost pattern matching for development.
 *
 * @param origin - The request Origin header value
 * @param env - Cloudflare Worker environment bindings
 * @returns Whether the origin is allowed
 */
function isOriginAllowed(origin: string, env: Env): boolean {
  const allowedOrigins = parseAllowedOrigins(env);

  // Exact match
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Check for wildcard localhost patterns (e.g., http://localhost:*)
  for (const allowed of allowedOrigins) {
    if (allowed === 'http://localhost:*') {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' && url.protocol === 'http:') {
          return true;
        }
      } catch {
        // Invalid origin URL, skip
      }
    }
  }

  return false;
}

/**
 * Parse the ADMIN_ALLOWED_ORIGINS from environment.
 * Returns an empty array if not set (no origins allowed).
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns Array of allowed origin strings
 */
function parseAllowedOrigins(env: Env): string[] {
  if (!env || !env.ADMIN_ALLOWED_ORIGINS) {
    return [];
  }

  return env.ADMIN_ALLOWED_ORIGINS
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}
