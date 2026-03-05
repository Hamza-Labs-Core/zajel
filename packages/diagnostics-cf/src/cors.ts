/**
 * CORS utility for Zajel Diagnostics Worker.
 *
 * Uses a permissive CORS policy since the diagnostics endpoint is
 * unauthenticated and intended for client apps on any origin.
 * This is safe because diagnostics reports are anonymous and contain
 * no user-identifying data.
 */

/**
 * Get CORS headers for a response.
 * Permissive policy -- any origin is allowed (diagnostics are anonymous,
 * unauthenticated, and contain no sensitive data).
 */
export function getCorsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*', // codeguard:allow cors-wildcard
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

/**
 * Create a CORS preflight response.
 */
export function handlePreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(),
  });
}
