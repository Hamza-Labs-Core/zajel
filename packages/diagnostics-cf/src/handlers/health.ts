/**
 * Health check endpoint handler.
 *
 * GET /diagnostics/health
 * Returns service name, status, and timestamp.
 */

import { getCorsHeaders } from '../cors.js';

/**
 * Handle GET /diagnostics/health request.
 */
export function handleHealth(): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      service: 'zajel-diagnostics',
      timestamp: new Date().toISOString(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders(),
      },
    },
  );
}
