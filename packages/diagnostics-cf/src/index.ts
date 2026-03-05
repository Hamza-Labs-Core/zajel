/**
 * Zajel Diagnostics Collection Worker - Entry Point
 *
 * Central ingestion point for anonymous diagnostic reports from
 * Flutter client apps. Receives reports over HTTPS, validates and
 * scrubs them, stores raw reports in R2 for later analysis, and
 * writes aggregated metrics to D1 for dashboard queries.
 *
 * Endpoints:
 * - POST /diagnostics/report    - Submit a diagnostic report
 * - POST /diagnostics/heartbeat - Client heartbeat for active counting
 * - GET  /diagnostics/health    - Health check
 */

import type { Env } from './types.js';
import { getCorsHeaders, handlePreflight } from './cors.js';
import { checkGlobalRateLimit } from './rate-limit.js';
import { handleHealth } from './handlers/health.js';
import { handleReport } from './handlers/report.js';
import { handleHeartbeat } from './handlers/heartbeat.js';
import { handleServerMetricsPush } from './handlers/server-push.js';
import { handleSecurityEventsPush } from './handlers/security-events-push.js';
import { handleServerLogsPush } from './handlers/server-logs-push.js';
import { aggregateVersionHistory } from './aggregation-scheduled.js';
import { aggregateConnectionTypes } from './aggregation.js';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return handlePreflight();
    }

    try {
      // Global rate limit check (before body parsing)
      const globalLimit = await checkGlobalRateLimit(env);
      if (!globalLimit.allowed) {
        return jsonResponse(
          { success: false, error: globalLimit.error ?? 'Rate limit exceeded' },
          429,
        );
      }

      // Route requests
      let response: Response;

      if (path === '/diagnostics/health' && method === 'GET') {
        response = handleHealth();
      } else if (path === '/diagnostics/report' && method === 'POST') {
        response = await handleReport(request, env, ctx);
      } else if (path === '/diagnostics/heartbeat' && method === 'POST') {
        response = await handleHeartbeat(request, env, ctx);
      } else if (path === '/diagnostics/server-metrics' && method === 'POST') {
        response = await handleServerMetricsPush(request, env, ctx);
      } else if (path === '/diagnostics/security-events' && method === 'POST') {
        response = await handleSecurityEventsPush(request, env, ctx);
      } else if (path === '/diagnostics/server-logs' && method === 'POST') {
        response = await handleServerLogsPush(request, env, ctx);
      } else {
        return jsonResponse(
          { success: false, error: 'Not found' },
          404,
        );
      }

      // Ensure CORS headers on all handler responses
      return withCors(response);
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse(
        { success: false, error: 'Internal server error' },
        500,
      );
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      const versionResult = await aggregateVersionHistory(env.DB);
      console.log(
        `Version history aggregation: inserted=${versionResult.inserted}, cleaned=${versionResult.cleaned}`,
      );
    } catch (error) {
      console.error('Version history aggregation failed:', error);
    }

    try {
      await aggregateConnectionTypes(env.DB);
      console.log('Connection type aggregation completed');
    } catch (error) {
      console.error('Connection type aggregation failed:', error);
    }
  },
};

/**
 * JSON response helper with CORS headers.
 */
function jsonResponse(
  body: Record<string, unknown>,
  status: number,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(),
    },
  });
}

/**
 * Attach CORS headers to an existing response.
 */
function withCors(response: Response): Response {
  const corsHeaders = getCorsHeaders();
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
