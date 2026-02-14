/**
 * CORS utility module for Zajel Bootstrap Server.
 *
 * Provides origin-based CORS header generation instead of wildcard (*).
 * The allowlist is read from the ALLOWED_ORIGINS environment variable
 * (comma-separated) with a sensible default.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  'https://zajel.hamzalabs.dev',
  'https://signal.zajel.hamzalabs.dev',
];

/**
 * Get CORS headers for a given request. Checks the request's Origin header
 * against the allowlist and returns matching CORS headers.
 *
 * @param {Request} request - The incoming request
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {object} CORS headers object
 */
export function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = parseAllowedOrigins(env);

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Expose-Headers': 'X-Bootstrap-Signature, X-Attestation-Token',
  };

  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

/**
 * Parse the ALLOWED_ORIGINS from environment.
 * Falls back to DEFAULT_ALLOWED_ORIGINS if not set.
 *
 * @param {object} env - Cloudflare Worker environment bindings
 * @returns {string[]} Array of allowed origin strings
 */
function parseAllowedOrigins(env) {
  if (!env || !env.ALLOWED_ORIGINS) {
    return DEFAULT_ALLOWED_ORIGINS;
  }

  return env.ALLOWED_ORIGINS
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Check if an origin is in the allowlist.
 * Supports exact matches and localhost pattern matching for development.
 *
 * @param {string} origin - The request Origin header value
 * @param {string[]} allowedOrigins - Array of allowed origins
 * @returns {boolean} Whether the origin is allowed
 */
function isOriginAllowed(origin, allowedOrigins) {
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
