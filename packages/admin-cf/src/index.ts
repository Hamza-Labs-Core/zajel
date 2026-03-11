/**
 * Zajel Admin Dashboard - Cloudflare Worker Entry Point
 *
 * Serves the admin dashboard and provides API endpoints for:
 * - Authentication (login, logout, verify)
 * - User management (list, create, delete)
 * - Server monitoring (list servers with health status)
 */

import type { Env } from './types.js';
import { handleLogin, handleLogout, handleVerify, handleInit } from './routes/auth.js';
import { handleListUsers, handleCreateUser, handleDeleteUser } from './routes/users.js';
import { handleListServers } from './routes/servers.js';
import { handleGenerateCode, handleExchangeCode } from './routes/auth-code.js';
import { getCorsHeaders, SECURITY_HEADERS } from './cors.js';
import { handleListErrors, handleErrorTrends, handleErrorRegressions, handleErrorDetail } from './routes/errors.js';
import { handleServerMetrics, handleServerMetricsDetail, handleAppMetrics, handleNetworkMetrics, handleFederationMetrics } from './routes/metrics.js';
import { handleActiveClients, handlePlatformBreakdown, handleVersionAdoption, handleConnectionTypes } from './routes/clients.js';
import { handleServersHealth } from './routes/servers-health.js';
import { handleServerLogs } from './routes/logs.js';
import { handleFederationTopology } from './routes/federation-topology.js';
import { handleHeartbeatTimeline } from './routes/heartbeat-timeline.js';
import { handleListIssues, handleIssueDetail, handleAcknowledgeIssue } from './routes/issues.js';
import { handleAiCosts } from './routes/ai-costs.js';
import { handleRateLimitViolations } from './routes/security-rate-limits.js';
import { handleDdosIndicators } from './routes/security-attacks.js';
import { handleBadClients, handlePairingBruteForce } from './routes/security-clients.js';
import {
  handleListAlertRules,
  handleGetAlertRule,
  handleCreateAlertRule,
  handleUpdateAlertRule,
  handleDeleteAlertRule,
  handleToggleAlertRule,
} from './routes/alert-rules.js';
import {
  handleListAlertHistory,
  handleAcknowledgeAlert,
} from './routes/alert-history.js';
import {
  handleListNotifications,
  handleUnreadCount,
  handleMarkRead,
  handleMarkAllRead,
} from './routes/notifications.js';
import {
  handleGetNotificationConfig,
  handleUpdateNotificationConfig,
  handleTestNotification,
} from './routes/notification-config.js';
import { handleLogDiagnosticCorrelation } from './routes/log-correlation.js';
import { handleUnsubscribe } from './routes/unsubscribe.js';
import { evaluateAlertRules } from './alert-engine.js';
import { DASHBOARD_HTML } from './dashboard-html.js';

// Re-export Durable Objects
export { AdminUsersDO } from './admin-users-do.js';
export { NotificationDO } from './notification-do.js';

// Rate limiting state (per worker instance)
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 login attempts per minute

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers for dashboard (origin-validated, no wildcard)
    const corsHeaders = getCorsHeaders(request, env);

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      let response: Response;

      // Health check endpoint (no auth required)
      if (path === '/health') {
        return jsonResponse({
          success: true,
          data: {
            status: 'healthy',
            service: 'zajel-admin-cf',
            version: env.APP_VERSION || 'unknown',
            timestamp: new Date().toISOString(),
          }
        }, 200, corsHeaders);
      }

      // ─── Internal notify endpoint (no auth, worker-to-worker) ──
      if (path === '/admin/internal/notify' && method === 'POST') {
        if (!env.NOTIFICATION_DO) {
          return jsonResponse(
            { success: false, error: 'NOTIFICATION_DO binding not configured' },
            500,
            corsHeaders
          );
        }
        const doId = env.NOTIFICATION_DO.idFromName('notifications');
        const stub = env.NOTIFICATION_DO.get(doId);
        const doResponse = await stub.fetch(new Request('http://do/notify', {
          method: 'POST',
          body: request.body,
          headers: { 'Content-Type': 'application/json' },
        }));
        const newHeaders = new Headers(doResponse.headers);
        for (const [key, value] of Object.entries(corsHeaders)) {
          newHeaders.set(key, value);
        }
        return new Response(doResponse.body, {
          status: doResponse.status,
          headers: newHeaders,
        });
      }

      // ─── WebSocket upgrade for real-time notifications ──
      if (path === '/admin/api/notifications/ws' && method === 'GET') {
        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
          return jsonResponse(
            { success: false, error: 'Expected WebSocket upgrade' },
            426,
            corsHeaders
          );
        }
        if (!env.NOTIFICATION_DO) {
          return jsonResponse(
            { success: false, error: 'NOTIFICATION_DO binding not configured' },
            500,
            corsHeaders
          );
        }
        // Forward the full request to the DO (token is in query params)
        const doId = env.NOTIFICATION_DO.idFromName('notifications');
        const stub = env.NOTIFICATION_DO.get(doId);
        return stub.fetch(new Request(new URL('/ws' + new URL(request.url).search, 'http://do'), {
          method: 'GET',
          headers: request.headers,
        }));
      }

      // ─── Unsubscribe endpoint (no auth required, JWT in query) ──
      if (path === '/admin/api/notifications/unsubscribe' && method === 'GET') {
        return handleUnsubscribe(request, env);
      }

      // Check if ZAJEL_ADMIN_JWT_SECRET is configured
      if (!env.ZAJEL_ADMIN_JWT_SECRET && path.startsWith('/admin/api/')) {
        return jsonResponse(
          { success: false, error: 'Server not configured: ZAJEL_ADMIN_JWT_SECRET missing' },
          500,
          corsHeaders
        );
      }

      // Route API requests
      if (path === '/admin/api/auth/init' && method === 'POST') {
        response = await handleInit(request, env);
      } else if (path === '/admin/api/auth/login' && method === 'POST') {
        // Rate limit login attempts
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (isRateLimited(ip)) {
          return jsonResponse(
            { success: false, error: 'Too many login attempts. Try again later.' },
            429,
            corsHeaders
          );
        }
        response = await handleLogin(request, env);
      } else if (path === '/admin/api/auth/logout' && method === 'POST') {
        response = handleLogout();
      } else if (path === '/admin/api/auth/verify' && method === 'GET') {
        response = await handleVerify(request, env);
      } else if (path === '/admin/api/users' && method === 'GET') {
        response = await handleListUsers(request, env);
      } else if (path === '/admin/api/users' && method === 'POST') {
        response = await handleCreateUser(request, env);
      } else if (path.startsWith('/admin/api/users/') && method === 'DELETE') {
        const userId = path.substring('/admin/api/users/'.length);
        response = await handleDeleteUser(request, env, userId);
      } else if (path === '/admin/api/servers' && method === 'GET') {
        response = await handleListServers(request, env);
      } else if (path === '/admin/api/auth/code' && method === 'POST') {
        response = await handleGenerateCode(request, env);
      } else if (path === '/admin/api/auth/exchange' && method === 'POST') {
        response = await handleExchangeCode(request, env);
      } else if (path === '/admin/api/metrics/server' && method === 'GET') {
        response = await handleServerMetrics(request, env);
      } else if (path.startsWith('/admin/api/metrics/server/') && method === 'GET') {
        const serverId = decodeURIComponent(path.substring('/admin/api/metrics/server/'.length));
        response = await handleServerMetricsDetail(request, env, serverId);
      } else if (path === '/admin/api/metrics/app' && method === 'GET') {
        response = await handleAppMetrics(request, env);
      } else if (path === '/admin/api/metrics/network' && method === 'GET') {
        response = await handleNetworkMetrics(request, env);
      } else if (path === '/admin/api/metrics/federation' && method === 'GET') {
        response = await handleFederationMetrics(request, env);
      } else if (path === '/admin/api/clients/active' && method === 'GET') {
        response = await handleActiveClients(request, env);
      } else if (path === '/admin/api/clients/platforms' && method === 'GET') {
        response = await handlePlatformBreakdown(request, env);
      } else if (path === '/admin/api/clients/versions' && method === 'GET') {
        response = await handleVersionAdoption(request, env);
      } else if (path === '/admin/api/clients/connections' && method === 'GET') {
        response = await handleConnectionTypes(request, env);
      } else if (path === '/admin/api/servers/health' && method === 'GET') {
        response = await handleServersHealth(request, env);
      } else if (path === '/admin/api/servers/heartbeat-timeline' && method === 'GET') {
        response = await handleHeartbeatTimeline(request, env);
      } else if (path === '/admin/api/logs' && method === 'GET') {
        response = await handleServerLogs(request, env);
      } else if (path === '/admin/api/logs/correlation' && method === 'GET') {
        response = await handleLogDiagnosticCorrelation(request, env);
      } else if (path === '/admin/api/federation/topology' && method === 'GET') {
        response = await handleFederationTopology(request, env);
      } else if (path === '/admin/api/ai/costs' && method === 'GET') {
        response = await handleAiCosts(request, env);
      } else if (path === '/admin/api/security/rate-limits' && method === 'GET') {
        response = await handleRateLimitViolations(request, env);
      } else if (path === '/admin/api/security/attacks' && method === 'GET') {
        response = await handleDdosIndicators(request, env);
      } else if (path === '/admin/api/security/bad-clients' && method === 'GET') {
        response = await handleBadClients(request, env);
      } else if (path === '/admin/api/security/pairing-abuse' && method === 'GET') {
        response = await handlePairingBruteForce(request, env);
      } else if (path === '/admin/api/alerts/rules' && method === 'GET') {
        response = await handleListAlertRules(request, env);
      } else if (path === '/admin/api/alerts/rules' && method === 'POST') {
        response = await handleCreateAlertRule(request, env);
      } else if (path.match(/^\/admin\/api\/alerts\/rules\/\d+$/) && method === 'GET') {
        const ruleId = path.substring('/admin/api/alerts/rules/'.length);
        response = await handleGetAlertRule(request, env, ruleId);
      } else if (path.match(/^\/admin\/api\/alerts\/rules\/\d+$/) && method === 'PUT') {
        const ruleId = path.substring('/admin/api/alerts/rules/'.length);
        response = await handleUpdateAlertRule(request, env, ruleId);
      } else if (path.match(/^\/admin\/api\/alerts\/rules\/\d+$/) && method === 'DELETE') {
        const ruleId = path.substring('/admin/api/alerts/rules/'.length);
        response = await handleDeleteAlertRule(request, env, ruleId);
      } else if (path.match(/^\/admin\/api\/alerts\/rules\/\d+\/toggle$/) && method === 'PATCH') {
        const ruleId = path.match(/^\/admin\/api\/alerts\/rules\/(\d+)\/toggle$/)![1];
        response = await handleToggleAlertRule(request, env, ruleId);
      } else if (path === '/admin/api/alerts/history' && method === 'GET') {
        response = await handleListAlertHistory(request, env);
      } else if (path.match(/^\/admin\/api\/alerts\/history\/\d+\/acknowledge$/) && method === 'POST') {
        const match = path.match(/^\/admin\/api\/alerts\/history\/(\d+)\/acknowledge$/);
        const historyId = match![1];
        response = await handleAcknowledgeAlert(request, env, historyId);
      } else if (path === '/admin/api/notifications/unread-count' && method === 'GET') {
        response = await handleUnreadCount(request, env);
      } else if (path === '/admin/api/notifications/read-all' && method === 'POST') {
        response = await handleMarkAllRead(request, env);
      } else if (path === '/admin/api/notifications/config' && method === 'GET') {
        response = await handleGetNotificationConfig(request, env);
      } else if (path === '/admin/api/notifications/config' && method === 'POST') {
        response = await handleUpdateNotificationConfig(request, env);
      } else if (path === '/admin/api/notifications/test' && method === 'POST') {
        response = await handleTestNotification(request, env);
      } else if (path.match(/^\/admin\/api\/notifications\/\d+\/read$/) && method === 'POST') {
        const match = path.match(/^\/admin\/api\/notifications\/(\d+)\/read$/);
        const notificationId = match![1];
        response = await handleMarkRead(request, env, notificationId);
      } else if (path === '/admin/api/notifications' && method === 'GET') {
        response = await handleListNotifications(request, env);
      } else if (path === '/admin/api/issues' && method === 'GET') {
        response = await handleListIssues(request, env);
      } else if (/^\/admin\/api\/issues\/\d+\/acknowledge$/.test(path) && method === 'POST') {
        const issueId = path.split('/')[5]!;
        response = await handleAcknowledgeIssue(request, env, issueId);
      } else if (/^\/admin\/api\/issues\/\d+$/.test(path) && method === 'GET') {
        const issueId = path.split('/')[5]!;
        response = await handleIssueDetail(request, env, issueId);
      } else if (path === '/admin/api/errors/trends' && method === 'GET') {
        response = await handleErrorTrends(request, env);
      } else if (path === '/admin/api/errors/regressions' && method === 'GET') {
        response = await handleErrorRegressions(request, env);
      } else if (path === '/admin/api/errors' && method === 'GET') {
        response = await handleListErrors(request, env);
      } else if (path.startsWith('/admin/api/errors/') && method === 'GET') {
        const signature = decodeURIComponent(path.substring('/admin/api/errors/'.length));
        if (signature && signature !== 'trends' && signature !== 'regressions') {
          response = await handleErrorDetail(request, env, signature);
        } else {
          return jsonResponse({ success: false, error: 'Not found' }, 404, corsHeaders);
        }
      } else if (path.startsWith('/admin/api/')) {
        return jsonResponse({ success: false, error: 'Not found' }, 404, corsHeaders);
      } else if (path === '/admin' || path === '/admin/') {
        // Serve dashboard HTML
        return serveDashboard();
      } else if (path.startsWith('/admin/')) {
        // Serve static assets or fallback to dashboard for SPA routing
        return serveDashboard();
      } else {
        // Redirect root to admin
        return Response.redirect(new URL('/admin/', request.url).toString(), 302);
      }

      // Add CORS headers to response
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        newHeaders.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse(
        { success: false, error: 'Internal server error' },
        500,
        corsHeaders
      );
    }
  },

  // Cron trigger handler -- evaluates alert rules every 5 minutes.
  // Configured via wrangler.jsonc triggers.crons (every 5 min schedule).
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(
      evaluateAlertRules(env).then((results) => {
        if (results.length > 0) {
          console.log(`Alert engine fired ${results.length} alert(s):`,
            results.map(r => `[${r.severity}] ${r.ruleName}: ${r.message}`).join('; ')
          );
        }
      }).catch((error) => {
        console.error('Alert engine cron failed:', error);
      })
    );
  },
};

/**
 * Check if IP is rate limited
 */
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  return false;
}

/**
 * Serve the Preact SPA dashboard.
 * The HTML is generated by `npm run build:dashboard` and inlined into dashboard-html.ts.
 */
function serveDashboard(): Response {
  return new Response(DASHBOARD_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Legacy inline dashboard HTML (kept as reference, not served).
 * @deprecated Use the Preact SPA dashboard instead. Run `npm run build:dashboard` to build.
 */
function _legacyServeDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel Admin Dashboard (Legacy)</title>
  <link rel="stylesheet" href="https://unpkg.com/uplot@1.6.31/dist/uPlot.min.css">
  <script src="https://unpkg.com/uplot@1.6.31/dist/uPlot.iife.min.js"></script>
  <style>
    :root {
      --bg-primary: #0f172a;
      --bg-secondary: #1e293b;
      --bg-card: #334155;
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --warning: #eab308;
      --danger: #ef4444;
      --border: #475569;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }

    header h1 {
      font-size: 1.5rem;
      font-weight: 600;
    }

    .user-info {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .user-badge {
      background: var(--bg-secondary);
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
    }

    button {
      background: var(--accent);
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.2s;
    }

    button:hover {
      background: var(--accent-hover);
    }

    button.danger {
      background: var(--danger);
    }

    button.danger:hover {
      background: #dc2626;
    }

    /* Login Form */
    .login-container {
      max-width: 400px;
      margin: 4rem auto;
      padding: 2rem;
      background: var(--bg-secondary);
      border-radius: 1rem;
    }

    .login-container h2 {
      margin-bottom: 1.5rem;
      text-align: center;
    }

    .form-group {
      margin-bottom: 1rem;
    }

    .form-group label {
      display: block;
      margin-bottom: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-secondary);
    }

    .form-group input {
      width: 100%;
      padding: 0.75rem;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--text-primary);
      font-size: 1rem;
    }

    .form-group input:focus {
      outline: none;
      border-color: var(--accent);
    }

    .login-container button {
      width: 100%;
      padding: 0.75rem;
      margin-top: 0.5rem;
    }

    .error-message {
      color: var(--danger);
      font-size: 0.875rem;
      margin-top: 1rem;
      text-align: center;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .tab {
      background: var(--bg-secondary);
      padding: 0.5rem 1.5rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.875rem;
      border: 1px solid transparent;
    }

    .tab.active {
      border-color: var(--accent);
      background: var(--bg-card);
    }

    /* Server Grid */
    .server-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
    }

    .server-card {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      border: 1px solid var(--border);
    }

    .server-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .server-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .server-name {
      font-weight: 600;
      font-size: 1.125rem;
    }

    .status-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 1rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .status-healthy {
      background: rgba(34, 197, 94, 0.2);
      color: var(--success);
    }

    .status-degraded {
      background: rgba(234, 179, 8, 0.2);
      color: var(--warning);
    }

    .status-offline {
      background: rgba(239, 68, 68, 0.2);
      color: var(--danger);
    }

    .server-region {
      font-size: 0.875rem;
      color: var(--text-secondary);
      margin-bottom: 0.75rem;
    }

    .server-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
      font-size: 0.875rem;
    }

    .stat-item {
      display: flex;
      justify-content: space-between;
    }

    .stat-label {
      color: var(--text-secondary);
    }

    /* Aggregate Stats */
    .aggregate-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--bg-secondary);
      padding: 1rem;
      border-radius: 0.5rem;
      text-align: center;
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--accent);
    }

    .stat-title {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    /* User Management */
    .user-list {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      overflow: hidden;
    }

    .user-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
    }

    .user-row:last-child {
      border-bottom: none;
    }

    .user-info-row {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .role-badge {
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      background: var(--bg-card);
    }

    .add-user-form {
      background: var(--bg-secondary);
      padding: 1.5rem;
      border-radius: 0.75rem;
      margin-bottom: 1.5rem;
    }

    .form-row {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .form-row .form-group {
      flex: 1;
      min-width: 200px;
    }

    .form-row select {
      width: 100%;
      padding: 0.75rem;
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--text-primary);
      font-size: 1rem;
    }

    /* Loading */
    .loading {
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
    }

    .spinner {
      display: inline-block;
      width: 2rem;
      height: 2rem;
      border: 3px solid var(--bg-card);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Error Dashboard */
    .error-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }

    .time-range-selector {
      display: flex;
      gap: 0.5rem;
    }

    .time-range-btn {
      background: var(--bg-secondary);
      padding: 0.4rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.8rem;
      border: 1px solid transparent;
      color: var(--text-secondary);
    }

    .time-range-btn.active {
      border-color: var(--accent);
      background: var(--bg-card);
      color: var(--text-primary);
    }

    .auto-refresh-indicator {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .error-table {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      overflow: hidden;
      width: 100%;
    }

    .error-table table {
      width: 100%;
      border-collapse: collapse;
    }

    .error-table th {
      text-align: left;
      padding: 0.75rem 1rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .error-table td {
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      border-bottom: 1px solid var(--border);
    }

    .error-table tr:last-child td {
      border-bottom: none;
    }

    .error-table tr:hover {
      background: var(--bg-card);
    }

    .category-badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
    }

    .category-crash { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
    .category-network { background: rgba(234, 179, 8, 0.2); color: var(--warning); }
    .category-crypto { background: rgba(168, 85, 247, 0.2); color: #a855f7; }
    .category-storage { background: rgba(59, 130, 246, 0.2); color: var(--accent); }
    .category-ui { background: rgba(34, 197, 94, 0.2); color: var(--success); }
    .category-protocol { background: rgba(249, 115, 22, 0.2); color: #f97316; }
    .category-other { background: rgba(148, 163, 184, 0.2); color: var(--text-secondary); }

    .severity-critical { color: var(--danger); font-weight: 700; }
    .severity-high { color: #f97316; font-weight: 600; }
    .severity-medium { color: var(--warning); }
    .severity-low { color: var(--text-secondary); }
    .severity-none { color: var(--text-secondary); }

    .rate-change-up { color: var(--danger); }
    .rate-change-down { color: var(--success); }
    .rate-change-flat { color: var(--text-secondary); }

    .empty-state {
      text-align: center;
      padding: 3rem 2rem;
      color: var(--text-secondary);
    }

    .empty-state p {
      margin-top: 0.5rem;
      font-size: 0.875rem;
    }

    /* Error Trends Chart */
    .trends-chart-container {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      position: relative;
      min-height: 320px;
    }

    .trends-chart-container h3 {
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--text-secondary);
    }

    #error-trends-chart {
      width: 100%;
      height: 280px;
    }

    .chart-empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 280px;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    .chart-unavailable {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 280px;
      color: var(--text-secondary);
      font-size: 0.875rem;
    }

    /* uPlot theme overrides for dark mode */
    .uplot .u-title {
      color: var(--text-primary) !important;
    }

    .uplot .u-legend .u-label {
      color: var(--text-secondary) !important;
      font-size: 0.75rem !important;
    }

    .uplot .u-legend .u-value {
      color: var(--text-primary) !important;
      font-size: 0.75rem !important;
    }

    .uplot .u-axis .u-label {
      color: var(--text-secondary) !important;
    }

    .trends-tooltip {
      position: absolute;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.75rem;
      font-size: 0.75rem;
      pointer-events: none;
      z-index: 100;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .trends-tooltip .tooltip-time {
      color: var(--text-secondary);
      margin-bottom: 0.5rem;
      font-weight: 600;
    }

    .trends-tooltip .tooltip-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 0.15rem 0;
    }

    .trends-tooltip .tooltip-color {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 0.25rem;
    }

    .trends-tooltip .tooltip-total {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--border);
      font-weight: 600;
      display: flex;
      justify-content: space-between;
    }

    .deploy-marker-label {
      font-size: 0.625rem;
      fill: var(--text-secondary);
    }

    /* Regression Banner (US-2.4) */
    .regression-banner {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--danger);
      border-radius: 0.75rem;
      padding: 1rem 1.25rem;
      margin-bottom: 1.5rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .regression-icon {
      font-size: 1.25rem;
      flex-shrink: 0;
    }

    .regression-banner span {
      flex: 1;
      font-size: 0.875rem;
    }

    .regression-banner button {
      flex-shrink: 0;
      background: var(--danger);
      font-size: 0.8rem;
      padding: 0.4rem 0.8rem;
    }

    .regression-banner button:hover {
      background: #dc2626;
    }

    .regression-table {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      overflow: hidden;
      width: 100%;
      margin-bottom: 1.5rem;
    }

    .regression-table table {
      width: 100%;
      border-collapse: collapse;
    }

    .regression-table th {
      text-align: left;
      padding: 0.75rem 1rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .regression-table td {
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      border-bottom: 1px solid var(--border);
    }

    .regression-table tr:last-child td {
      border-bottom: none;
    }

    .regression-table tr:hover {
      background: var(--bg-card);
    }

    .regression-multiplier {
      color: var(--danger);
      font-weight: 700;
    }

    .regression-sig-link {
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
    }

    .regression-sig-link:hover {
      color: var(--accent-hover);
    }

    /* Server Metrics Panel (US-3.3) */
    .metrics-aggregate-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .metrics-server-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .metrics-server-card {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      padding: 1.25rem;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      border: 2px solid var(--border);
    }

    .metrics-server-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .metrics-server-card.health-healthy {
      border-color: var(--success);
    }

    .metrics-server-card.health-degraded {
      border-color: var(--warning);
    }

    .metrics-server-card.health-offline {
      border-color: var(--danger);
      opacity: 0.7;
    }

    .metrics-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }

    .metrics-card-header .server-name {
      font-weight: 600;
      font-size: 1rem;
    }

    .stale-indicator {
      font-size: 0.7rem;
      color: var(--danger);
      background: rgba(239, 68, 68, 0.15);
      padding: 0.15rem 0.5rem;
      border-radius: 0.25rem;
    }

    .metrics-bars {
      margin-bottom: 0.75rem;
    }

    .metrics-bar-row {
      margin-bottom: 0.5rem;
    }

    .metrics-bar-label {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
    }

    .metrics-bar-track {
      height: 6px;
      background: var(--bg-card);
      border-radius: 3px;
      overflow: hidden;
    }

    .metrics-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.5s ease;
    }

    .metrics-card-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
      font-size: 0.8rem;
    }

    .metrics-card-stats .stat-item {
      display: flex;
      justify-content: space-between;
    }

    /* Server Metrics Detail View */
    .metrics-detail-container {
      margin-top: 1.5rem;
    }

    .metrics-detail-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .metrics-detail-header h3 {
      font-size: 1rem;
      font-weight: 600;
    }

    .metrics-detail-back {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-primary);
      padding: 0.4rem 0.8rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.8rem;
    }

    .metrics-detail-back:hover {
      background: var(--bg-card);
    }

    .metrics-detail-charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }

    @media (max-width: 768px) {
      .metrics-detail-charts {
        grid-template-columns: 1fr;
      }
    }

    .metrics-chart-card {
      background: var(--bg-secondary);
      border-radius: 0.75rem;
      padding: 1rem;
    }

    .metrics-chart-card h4 {
      font-size: 0.8rem;
      color: var(--text-secondary);
      margin-bottom: 0.75rem;
    }

    .metrics-chart-card canvas {
      width: 100%;
      height: 180px;
    }

    .metrics-range-selector {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }

    .metrics-range-btn {
      background: var(--bg-secondary);
      padding: 0.4rem 1rem;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 0.8rem;
      border: 1px solid transparent;
      color: var(--text-secondary);
    }

    .metrics-range-btn.active {
      border-color: var(--accent);
      background: var(--bg-card);
      color: var(--text-primary);
    }

    .metrics-mini-chart {
      width: 100%;
      height: 180px;
      position: relative;
    }

    .metrics-auto-refresh {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 1rem;
    }

    /* Threshold badge colors (US-3.1) */
    .threshold-green {
      background: rgba(34, 197, 94, 0.2);
      color: var(--success);
    }

    .threshold-yellow {
      background: rgba(234, 179, 8, 0.2);
      color: var(--warning);
    }

    .threshold-red {
      background: rgba(239, 68, 68, 0.2);
      color: var(--danger);
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="loading">
      <div class="spinner"></div>
      <p style="margin-top: 1rem;">Loading...</p>
    </div>
  </div>

  <script type="module">
    // State
    let state = {
      user: null,
      token: null,
      activeTab: 'servers',
      servers: [],
      aggregate: null,
      users: [],
      errorsData: null,
      errorRange: '24h',
      trendsData: null,
      regressionsData: null,
      showRegressionList: false,
      errorsRefreshInterval: null,
      // App performance metrics state (US-3.1)
      appMetricsData: null,
      appMetricsRange: '24h',
      appMetricsPlatform: '',
      appMetricsVersion: '',
      appMetricsRefreshInterval: null,
      // Server Metrics (US-3.3)
      serverMetrics: null,
      serverMetricsAggregate: null,
      serverMetricsDetail: null,
      serverMetricsRange: '1h',
      serverMetricsRefreshInterval: null,
      // Network Metrics (US-3.2)
      networkMetricsData: null,
      networkMetricsRange: '24h',
      networkMetricsPlatform: '',
      networkMetricsVersion: '',
      networkMetricsRefreshInterval: null,
      // Federation Health (US-3.4)
      federationData: null,
      federationRange: '1h',
      federationRefreshInterval: null,
      loading: true,
      error: null,
    };

    // uPlot chart instance reference (destroyed before re-creation)
    let trendsChart = null;

    // HTML escaping to prevent XSS
    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // Initialize
    async function init() {
      // Check for stored token
      const token = localStorage.getItem('zajel_admin_token');
      if (token) {
        try {
          const res = await fetch('/admin/api/auth/verify', {
            headers: { Authorization: 'Bearer ' + token }
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success) {
              state.token = token;
              state.user = data.data;

              // Handle redirect back from VPS dashboard
              const params = new URLSearchParams(window.location.search);
              const redirectUrl = params.get('redirect');
              if (redirectUrl) {
                try {
                  const url = new URL(redirectUrl);
                  // Only allow redirects to HTTPS URLs with /admin/ path
                  if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                    // Generate authorization code for redirect
                    const codeRes = await fetch('/admin/api/auth/code', {
                      method: 'POST',
                      headers: { 'Authorization': 'Bearer ' + state.token },
                    });

                    if (codeRes.ok) {
                      const codeData = await codeRes.json();
                      if (codeData.success && codeData.data?.code) {
                        url.searchParams.set('code', codeData.data.code);
                        window.location.href = url.toString();
                        return; // Stop init — we're redirecting
                      }
                    }

                    // If code generation failed, fall through to normal load
                    console.warn('Failed to generate auth code for redirect');
                  }
                } catch { /* invalid URL, ignore */ }
              }

              await loadData();
            }
          }
        } catch (e) {
          console.warn('Token verification failed:', e);
          localStorage.removeItem('zajel_admin_token');
        }
      }
      state.loading = false;
      render();
    }

    // Load data based on active tab
    async function loadData() {
      if (!state.token) return;

      // Clear any existing auto-refresh when switching tabs
      if (state.errorsRefreshInterval) {
        clearInterval(state.errorsRefreshInterval);
        state.errorsRefreshInterval = null;
      }
      if (state.appMetricsRefreshInterval) {
        clearInterval(state.appMetricsRefreshInterval);
        state.appMetricsRefreshInterval = null;
      }
      if (state.serverMetricsRefreshInterval) {
        clearInterval(state.serverMetricsRefreshInterval);
        state.serverMetricsRefreshInterval = null;
      }
      if (state.networkMetricsRefreshInterval) {
        clearInterval(state.networkMetricsRefreshInterval);
        state.networkMetricsRefreshInterval = null;
      }
      if (state.federationRefreshInterval) {
        clearInterval(state.federationRefreshInterval);
        state.federationRefreshInterval = null;
      }

      if (state.activeTab === 'servers') {
        await loadServers();
      } else if (state.activeTab === 'users') {
        await loadUsers();
      } else if (state.activeTab === 'errors') {
        await loadErrors();
        // Auto-refresh every 30 seconds for errors tab
        state.errorsRefreshInterval = setInterval(async () => {
          await loadErrors();
          render();
        }, 30000);
      } else if (state.activeTab === 'metrics') {
        await Promise.all([loadAppMetrics(), loadServerMetrics(), loadNetworkMetrics(), loadFederationMetrics()]);
        // Auto-refresh every 30 seconds
        state.appMetricsRefreshInterval = setInterval(async () => {
          if (!document.hidden) {
            await loadAppMetrics();
            render();
          }
        }, 30000);
        state.serverMetricsRefreshInterval = setInterval(async () => {
          if (!document.hidden) {
            await loadServerMetrics();
            render();
          }
        }, 30000);
        state.networkMetricsRefreshInterval = setInterval(async () => {
          if (!document.hidden) {
            await loadNetworkMetrics();
            render();
          }
        }, 30000);
        state.federationRefreshInterval = setInterval(async () => {
          if (!document.hidden) {
            await loadFederationMetrics();
            render();
          }
        }, 30000);
      }
    }

    async function loadServers() {
      try {
        const res = await fetch('/admin/api/servers', {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          state.servers = data.data.servers;
          state.aggregate = data.data.aggregate;
        }
      } catch (e) {
        state.error = 'Failed to load servers';
      }
    }

    async function loadUsers() {
      try {
        const res = await fetch('/admin/api/users', {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          state.users = data.data;
        }
      } catch (e) {
        state.error = 'Failed to load users';
      }
    }

    async function loadErrors() {
      try {
        const [errorsRes, trendsRes, regressionsRes] = await Promise.all([
          fetch('/admin/api/errors?range=' + encodeURIComponent(state.errorRange), {
            headers: { Authorization: 'Bearer ' + state.token }
          }),
          fetch('/admin/api/errors/trends?range=' + encodeURIComponent(state.errorRange), {
            headers: { Authorization: 'Bearer ' + state.token }
          }),
          fetch('/admin/api/errors/regressions?window=24h', {
            headers: { Authorization: 'Bearer ' + state.token }
          }),
        ]);
        const errorsData = await errorsRes.json();
        if (errorsData.success) {
          state.errorsData = errorsData.data;
        }
        const trendsData = await trendsRes.json();
        if (trendsData.success) {
          state.trendsData = trendsData.data;
        }
        const regressionsData = await regressionsRes.json();
        if (regressionsData.success) {
          state.regressionsData = regressionsData.data;
          // Update regression alerts count in summary
          if (state.errorsData && state.errorsData.summary) {
            state.errorsData.summary.regressionAlerts = regressionsData.data.regressions.length;
          }
        }
      } catch (e) {
        state.error = 'Failed to load errors';
      }
    }

    async function loadAppMetrics() {
      try {
        let url = '/admin/api/metrics/app?range=' + encodeURIComponent(state.appMetricsRange);
        if (state.appMetricsPlatform) {
          url += '&platform=' + encodeURIComponent(state.appMetricsPlatform);
        }
        if (state.appMetricsVersion) {
          url += '&version=' + encodeURIComponent(state.appMetricsVersion);
        }
        const res = await fetch(url, {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          state.appMetricsData = data.data;
        }
      } catch (e) {
        state.error = 'Failed to load app metrics';
      }
    }

    async function loadServerMetrics() {
      try {
        const res = await fetch('/admin/api/metrics/server', {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          state.serverMetrics = data.data.servers;
          state.serverMetricsAggregate = data.data.aggregate;
        }
      } catch (e) {
        state.error = 'Failed to load server metrics';
      }
    }

    async function loadServerMetricsDetail(serverId) {
      try {
        var url = '/admin/api/metrics/server/' + encodeURIComponent(serverId) + '?range=' + encodeURIComponent(state.serverMetricsRange);
        var res = await fetch(url, {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        var data = await res.json();
        if (data.success) {
          state.serverMetricsDetail = data.data;
        } else {
          state.serverMetricsDetail = null;
        }
      } catch (e) {
        state.serverMetricsDetail = null;
      }
      render();
    }


    async function loadNetworkMetrics() {
      try {
        let url = '/admin/api/metrics/network?range=' + encodeURIComponent(state.networkMetricsRange);
        if (state.networkMetricsPlatform) {
          url += '&platform=' + encodeURIComponent(state.networkMetricsPlatform);
        }
        if (state.networkMetricsVersion) {
          url += '&version=' + encodeURIComponent(state.networkMetricsVersion);
        }
        const res = await fetch(url, {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          state.networkMetricsData = data.data;
        }
      } catch (e) {
        state.error = 'Failed to load network metrics';
      }
    }

    async function loadFederationMetrics() {
      try {
        const res = await fetch('/admin/api/metrics/federation?range=' + encodeURIComponent(state.federationRange), {
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          state.federationData = data.data;
        } else {
          state.federationData = null;
        }
      } catch (e) {
        state.error = 'Failed to load federation metrics';
      }
    }

    // Login
    async function login(username, password) {
      try {
        const res = await fetch('/admin/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
          state.token = data.data.token;
          state.user = data.data.user;
          localStorage.setItem('zajel_admin_token', state.token);

          // Check if we should redirect back to a VPS dashboard
          const params = new URLSearchParams(window.location.search);
          const redirectUrl = params.get('redirect');
          if (redirectUrl) {
            try {
              const url = new URL(redirectUrl);
              // Only allow redirects to HTTPS URLs with /admin/ path
              if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                // Generate authorization code for redirect
                const codeRes = await fetch('/admin/api/auth/code', {
                  method: 'POST',
                  headers: { 'Authorization': 'Bearer ' + state.token },
                });

                if (codeRes.ok) {
                  const codeData = await codeRes.json();
                  if (codeData.success && codeData.data?.code) {
                    url.searchParams.set('code', codeData.data.code);
                    window.location.href = url.toString();
                    return;
                  }
                }

                // If code generation failed, fall through to normal render
                console.warn('Failed to generate auth code for redirect');
              }
            } catch { /* invalid URL, ignore */ }
          }

          await loadData();
          render();
        } else {
          state.error = data.error;
          render();
        }
      } catch (e) {
        state.error = 'Login failed';
        render();
      }
    }

    // Logout
    function logout() {
      state.token = null;
      state.user = null;
      localStorage.removeItem('zajel_admin_token');
      render();
    }

    // Create user
    async function createUser(username, password, role) {
      try {
        const res = await fetch('/admin/api/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + state.token
          },
          body: JSON.stringify({ username, password, role })
        });
        const data = await res.json();
        if (data.success) {
          await loadUsers();
          render();
          return true;
        } else {
          state.error = data.error;
          render();
          return false;
        }
      } catch (e) {
        state.error = 'Failed to create user';
        render();
        return false;
      }
    }

    // Delete user
    async function deleteUser(userId) {
      try {
        const res = await fetch('/admin/api/users/' + userId, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + state.token }
        });
        const data = await res.json();
        if (data.success) {
          await loadUsers();
          render();
        } else {
          state.error = data.error;
          render();
        }
      } catch (e) {
        state.error = 'Failed to delete user';
        render();
      }
    }

    // Navigate to VPS dashboard
    async function openVpsDashboard(server) {
      // Generate a short-lived authorization code
      try {
        const res = await fetch('/admin/api/auth/code', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + state.token,
          },
        });

        if (!res.ok) {
          console.error('Failed to generate auth code:', await res.text());
          state.error = 'Failed to authenticate with VPS dashboard. Please try again.';
          render();
          return;
        }

        const data = await res.json();
        if (!data.success || !data.data?.code) {
          console.error('Invalid auth code response:', data);
          state.error = 'Failed to authenticate with VPS dashboard. Please try again.';
          render();
          return;
        }

        // Convert WS endpoint to HTTP base URL (strip any path component)
        const wsUrl = new URL(server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'));
        const baseUrl = wsUrl.protocol + '//' + wsUrl.host;

        // Pass the short-lived CODE (not the JWT) in the URL
        window.open(baseUrl + '/admin/?code=' + encodeURIComponent(data.data.code), '_blank');
      } catch (error) {
        console.error('Error opening VPS dashboard:', error);
        state.error = 'Failed to authenticate with VPS dashboard. Please try again.';
        render();
      }
    }

    // Render
    function render() {
      const app = document.getElementById('app');

      if (state.loading) {
        return;
      }

      if (!state.user) {
        app.innerHTML = renderLogin();
        attachEventListeners();
        return;
      }

      app.innerHTML = renderDashboard();
      attachEventListeners();
    }

    function renderLogin() {
      return \`
        <div class="login-container">
          <h2>🔐 Zajel Admin</h2>
          <form id="login-form">
            <div class="form-group">
              <label for="username">Username</label>
              <input type="text" id="username" name="username" required autocomplete="username">
            </div>
            <div class="form-group">
              <label for="password">Password</label>
              <input type="password" id="password" name="password" required autocomplete="current-password">
            </div>
            <button type="submit">Login</button>
            \${state.error ? '<p class="error-message">' + escapeHtml(state.error) + '</p>' : ''}
          </form>
        </div>
      \`;
    }

    function renderDashboard() {
      return \`
        <div class="container">
          <header>
            <h1>🕊️ Zajel Admin Dashboard</h1>
            <div class="user-info">
              <span class="user-badge">\${escapeHtml(state.user.username)} (\${escapeHtml(state.user.role)})</span>
              <button id="logout-btn">Logout</button>
            </div>
          </header>

          <div class="tabs">
            <div class="tab \${state.activeTab === 'servers' ? 'active' : ''}" data-tab="servers">Servers</div>
            <div class="tab \${state.activeTab === 'users' ? 'active' : ''}" data-tab="users">Users</div>
            <div class="tab \${state.activeTab === 'errors' ? 'active' : ''}" data-tab="errors">Errors</div>
            <div class="tab \${state.activeTab === 'metrics' ? 'active' : ''}" data-tab="metrics">Metrics</div>
          </div>

          \${state.activeTab === 'servers' ? renderServers() : state.activeTab === 'errors' ? renderErrors() : state.activeTab === 'metrics' ? renderMetricsTab() : renderUsers()}
        </div>
      \`;
    }

    function renderServers() {
      if (!state.aggregate) {
        return '<div class="loading"><div class="spinner"></div></div>';
      }

      return \`
        <div class="aggregate-stats">
          <div class="stat-card">
            <div class="stat-value">\${state.aggregate.totalServers}</div>
            <div class="stat-title">Total Servers</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color: var(--success)">\${state.aggregate.healthyServers}</div>
            <div class="stat-title">Healthy</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color: var(--warning)">\${state.aggregate.degradedServers}</div>
            <div class="stat-title">Degraded</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color: var(--danger)">\${state.aggregate.offlineServers}</div>
            <div class="stat-title">Offline</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">\${state.aggregate.totalConnections}</div>
            <div class="stat-title">Total Connections</div>
          </div>
        </div>

        <div class="server-grid">
          \${state.servers.map(server => \`
            <div class="server-card" data-endpoint="\${escapeHtml(server.endpoint)}">
              <div class="server-header">
                <span class="server-name">\${escapeHtml(server.id)}</span>
                <span class="status-badge status-\${escapeHtml(server.status || 'unknown')}">\${escapeHtml((server.status || 'unknown').toUpperCase())}</span>
              </div>
              <div class="server-region">📍 \${escapeHtml(server.region)}</div>
              <div class="server-stats">
                <div class="stat-item">
                  <span class="stat-label">Connections</span>
                  <span>\${server.stats?.connections || 0}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Relay</span>
                  <span>\${server.stats?.relayConnections || 0}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Signaling</span>
                  <span>\${server.stats?.signalingConnections || 0}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Active Codes</span>
                  <span>\${server.stats?.activeCodes || 0}</span>
                </div>
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function renderUsers() {
      const canManageUsers = state.user.role === 'super-admin';

      return \`
        \${canManageUsers ? \`
          <div class="add-user-form">
            <h3 style="margin-bottom: 1rem;">Add New Admin</h3>
            <form id="add-user-form">
              <div class="form-row">
                <div class="form-group">
                  <label for="new-username">Username</label>
                  <input type="text" id="new-username" required minlength="3">
                </div>
                <div class="form-group">
                  <label for="new-password">Password</label>
                  <input type="password" id="new-password" required minlength="12">
                </div>
                <div class="form-group">
                  <label for="new-role">Role</label>
                  <select id="new-role">
                    <option value="admin">Admin</option>
                    <option value="super-admin">Super Admin</option>
                  </select>
                </div>
              </div>
              <button type="submit" style="margin-top: 1rem;">Add User</button>
            </form>
            \${state.error ? '<p class="error-message">' + escapeHtml(state.error) + '</p>' : ''}
          </div>
        \` : ''}

        <div class="user-list">
          \${state.users.map(user => \`
            <div class="user-row">
              <div class="user-info-row">
                <span>\${escapeHtml(user.username)}</span>
                <span class="role-badge">\${escapeHtml(user.role)}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 1rem;">
                <span style="font-size: 0.75rem; color: var(--text-secondary)">
                  Last login: \${user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never'}
                </span>
                \${canManageUsers && user.id !== state.user.userId ? \`
                  <button class="danger delete-user-btn" data-user-id="\${escapeHtml(user.id)}">Delete</button>
                \` : ''}
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
    }

    function renderErrors() {
      if (!state.errorsData) {
        return '<div class="loading"><div class="spinner"></div></div>';
      }

      const summary = state.errorsData.summary;
      const errors = state.errorsData.errors;
      const range = state.errorsData.range || state.errorRange;

      // Rate change display
      let rateChangeClass = 'rate-change-flat';
      let rateChangeText = '0%';
      if (summary.rateChangePercent > 0) {
        rateChangeClass = 'rate-change-up';
        rateChangeText = '+' + summary.rateChangePercent + '%';
      } else if (summary.rateChangePercent < 0) {
        rateChangeClass = 'rate-change-down';
        rateChangeText = summary.rateChangePercent + '%';
      }

      // Severity display
      const severityClass = 'severity-' + summary.highestSeverity;

      return \`
        <div class="error-controls">
          <div class="time-range-selector">
            <button class="time-range-btn \${range === '1h' ? 'active' : ''}" data-range="1h">1h</button>
            <button class="time-range-btn \${range === '24h' ? 'active' : ''}" data-range="24h">24h</button>
            <button class="time-range-btn \${range === '7d' ? 'active' : ''}" data-range="7d">7d</button>
          </div>
          <span class="auto-refresh-indicator">Auto-refresh: 30s</span>
        </div>

        <div class="aggregate-stats">
          <div class="stat-card">
            <div class="stat-value">\${summary.totalErrors}</div>
            <div class="stat-title">Total Errors (\${escapeHtml(range)})</div>
          </div>
          <div class="stat-card">
            <div class="stat-value \${rateChangeClass}">\${rateChangeText}</div>
            <div class="stat-title">vs Previous Period</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">\${summary.regressionAlerts}</div>
            <div class="stat-title">Regression Alerts</div>
          </div>
          <div class="stat-card">
            <div class="stat-value \${severityClass}">\${escapeHtml((summary.highestSeverity || 'none').toUpperCase())}</div>
            <div class="stat-title">Top Severity</div>
          </div>
        </div>

        \${renderRegressionBanner()}

        <div class="trends-chart-container">
          <h3>Error Trends</h3>
          <div id="error-trends-chart"></div>
        </div>

        \${errors.length === 0 ? \`
          <div class="empty-state">
            <h3>No errors found</h3>
            <p>No errors were reported in the selected time range (\${escapeHtml(range)}).</p>
          </div>
        \` : \`
          <div class="error-table">
            <table>
              <thead>
                <tr>
                  <th>Signature</th>
                  <th>Category</th>
                  <th>Count</th>
                  <th>Platforms</th>
                  <th>First Seen</th>
                  <th>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                \${errors.map(err => \`
                  <tr>
                    <td title="\${escapeHtml(err.sampleMessage)}">\${escapeHtml(err.errorSignature.substring(0, 12))}...</td>
                    <td><span class="category-badge category-\${escapeHtml(err.category)}">\${escapeHtml(err.category)}</span></td>
                    <td>\${err.totalCount}</td>
                    <td>\${escapeHtml((err.platforms || []).join(', '))}</td>
                    <td>\${new Date(err.firstSeen).toLocaleString()}</td>
                    <td>\${new Date(err.lastSeen).toLocaleString()}</td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        \`}
      \`;
    }

    function renderRegressionBanner() {
      const data = state.regressionsData;
      if (!data || !data.regressions || data.regressions.length === 0) {
        return '';
      }

      const count = data.regressions.length;
      const worst = data.regressions[0]; // Already sorted by multiplier desc

      let html = \`
        <div class="regression-banner">
          <span class="regression-icon">&#9888;</span>
          <span><strong>\${count} regression(s) detected</strong> &mdash;
            Worst: \${escapeHtml(worst.errorSignature.substring(0, 12))}... (\${worst.multiplier}x increase in \${escapeHtml(worst.category)})</span>
          <button id="view-regressions-btn">View All</button>
        </div>
      \`;

      if (state.showRegressionList) {
        html += \`
          <div class="regression-table">
            <table>
              <thead>
                <tr>
                  <th>Signature</th>
                  <th>Category</th>
                  <th>Current (v\${escapeHtml(data.currentVersion)})</th>
                  <th>Previous (v\${escapeHtml(data.previousVersion)})</th>
                  <th>Multiplier</th>
                  <th>Detected</th>
                </tr>
              </thead>
              <tbody>
                \${data.regressions.map(r => \`
                  <tr>
                    <td><span class="regression-sig-link" data-signature="\${escapeHtml(r.errorSignature)}" title="\${escapeHtml(r.sampleMessage)}">\${escapeHtml(r.errorSignature.substring(0, 12))}...</span></td>
                    <td><span class="category-badge category-\${escapeHtml(r.category)}">\${escapeHtml(r.category)}</span></td>
                    <td>\${r.currentTotal} (\${r.currentRate}/hr)</td>
                    <td>\${r.previousTotal} (\${r.previousRate}/hr)</td>
                    <td><span class="regression-multiplier">\${r.multiplier}x</span></td>
                    <td>\${new Date(r.firstDetected).toLocaleString()}</td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
          </div>
        \`;
      }

      return html;
    }

    // ─── App Performance Metrics (US-3.1) ─────────────

    function classifyStartupTime(p95) {
      if (p95 === null) return 'green';
      if (p95 < 3000) return 'green';
      if (p95 <= 5000) return 'yellow';
      return 'red';
    }

    function classifyFrameRate(p50) {
      if (p50 === null) return 'green';
      if (p50 > 55) return 'green';
      if (p50 >= 45) return 'yellow';
      return 'red';
    }

    function classifyMemory(p95) {
      if (p95 === null) return 'green';
      if (p95 < 200) return 'green';
      if (p95 <= 400) return 'yellow';
      return 'red';
    }

    function metricDisplayName(name) {
      switch (name) {
        case 'startup_time': return 'Startup Time';
        case 'frame_rate': return 'Frame Rate';
        case 'memory': return 'Memory Usage';
        default: return name;
      }
    }

    function formatMetricValue(value, unit) {
      if (value === null || value === undefined) return '--';
      if (unit === 'ms') return value >= 1000 ? (value / 1000).toFixed(1) + 's' : Math.round(value) + 'ms';
      if (unit === 'fps') return Math.round(value) + ' fps';
      if (unit === 'MB') return Math.round(value) + ' MB';
      return String(value);
    }

    function getThresholdClass(metricName, current) {
      var level;
      if (metricName === 'startup_time') level = classifyStartupTime(current.p95);
      else if (metricName === 'frame_rate') level = classifyFrameRate(current.p50);
      else if (metricName === 'memory') level = classifyMemory(current.p95);
      else level = 'green';
      return 'threshold-' + level;
    }

    function getThresholdLabel(metricName, current) {
      var level;
      if (metricName === 'startup_time') level = classifyStartupTime(current.p95);
      else if (metricName === 'frame_rate') level = classifyFrameRate(current.p50);
      else if (metricName === 'memory') level = classifyMemory(current.p95);
      else level = 'green';
      if (level === 'green') return 'Healthy';
      if (level === 'yellow') return 'Degraded';
      return 'Critical';
    }

    /**
     * Generate an SVG line chart for p50/p95/p99 percentile series.
     */
    function renderSvgLineChart(dataPoints, unit) {
      var width = 700;
      var height = 220;
      var padTop = 20, padRight = 20, padBottom = 40, padLeft = 60;
      var chartW = width - padLeft - padRight;
      var chartH = height - padTop - padBottom;

      if (!dataPoints || dataPoints.length === 0) {
        return '<div style="text-align:center;padding:2rem;color:var(--text-secondary);"><p>No data available for the selected filters and time range.</p></div>';
      }

      var allValues = [];
      for (var i = 0; i < dataPoints.length; i++) {
        if (dataPoints[i].p50 !== null) allValues.push(dataPoints[i].p50);
        if (dataPoints[i].p95 !== null) allValues.push(dataPoints[i].p95);
        if (dataPoints[i].p99 !== null) allValues.push(dataPoints[i].p99);
      }
      if (allValues.length === 0) {
        return '<div style="text-align:center;padding:2rem;color:var(--text-secondary);"><p>No data points in the selected range.</p></div>';
      }

      var minVal = Math.min.apply(null, allValues);
      var maxVal = Math.max.apply(null, allValues);
      var yRange = maxVal - minVal || 1;
      var yMin = Math.max(0, minVal - yRange * 0.1);
      var yMax = maxVal + yRange * 0.1;

      function scaleX(idx) {
        return padLeft + (dataPoints.length === 1 ? chartW / 2 : (idx / (dataPoints.length - 1)) * chartW);
      }
      function scaleY(val) {
        if (val === null) return null;
        return padTop + chartH - ((val - yMin) / (yMax - yMin)) * chartH;
      }

      function buildPath(key) {
        var d = '';
        var started = false;
        for (var j = 0; j < dataPoints.length; j++) {
          var val = dataPoints[j][key];
          if (val === null) continue;
          var x = scaleX(j).toFixed(1);
          var y = scaleY(val).toFixed(1);
          if (!started) { d += 'M' + x + ',' + y; started = true; }
          else { d += ' L' + x + ',' + y; }
        }
        return d;
      }

      var gridLines = '';
      for (var g = 0; g <= 4; g++) {
        var gy = padTop + (g / 4) * chartH;
        var gVal = yMax - (g / 4) * (yMax - yMin);
        gridLines += '<line x1="' + padLeft + '" y1="' + gy.toFixed(1) + '" x2="' + (width - padRight) + '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>';
        gridLines += '<text x="' + (padLeft - 8) + '" y="' + (gy + 4).toFixed(1) + '" fill="#94a3b8" font-size="10" text-anchor="end">' + formatMetricValue(gVal, unit) + '</text>';
      }

      var xLabels = '';
      var xStep = Math.max(1, Math.floor(dataPoints.length / 6));
      for (var xi = 0; xi < dataPoints.length; xi += xStep) {
        var xx = scaleX(xi);
        var label = dataPoints[xi].timeBucket;
        var displayLabel = label.slice(11, 16);
        xLabels += '<text x="' + xx.toFixed(1) + '" y="' + (height - 8) + '" fill="#94a3b8" font-size="10" text-anchor="middle">' + escapeHtml(displayLabel) + '</text>';
      }

      var p50Path = buildPath('p50');
      var p95Path = buildPath('p95');
      var p99Path = buildPath('p99');

      return '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:auto;max-height:250px;" xmlns="http://www.w3.org/2000/svg">'
        + gridLines + xLabels
        + (p50Path ? '<path d="' + p50Path + '" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '')
        + (p95Path ? '<path d="' + p95Path + '" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '')
        + (p99Path ? '<path d="' + p99Path + '" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' : '')
        + '</svg>'
        + '<div style="display:flex;gap:1rem;margin-top:0.5rem;font-size:0.75rem;justify-content:center;">'
        + '<span style="display:flex;align-items:center;gap:0.25rem;"><span style="width:8px;height:8px;border-radius:50%;display:inline-block;background:#3b82f6;"></span> p50</span>'
        + '<span style="display:flex;align-items:center;gap:0.25rem;"><span style="width:8px;height:8px;border-radius:50%;display:inline-block;background:#eab308;"></span> p95</span>'
        + '<span style="display:flex;align-items:center;gap:0.25rem;"><span style="width:8px;height:8px;border-radius:50%;display:inline-block;background:#ef4444;"></span> p99</span>'
        + '</div>';
    }

    function renderAppMetrics() {
      if (!state.appMetricsData) {
        return '<div class="loading"><div class="spinner"></div></div>';
      }

      var data = state.appMetricsData;
      var filters = data.filters || { platforms: [], versions: [] };
      var metrics = data.metrics || [];

      var html = '';

      // Filter bar
      html += '<div style="display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap;align-items:center;">';
      // Time range
      html += '<div style="display:flex;flex-direction:column;"><label style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.25rem;">Time Range</label>';
      html += '<select id="app-metrics-range" style="padding:0.5rem 0.75rem;background:#0f172a;border:1px solid #475569;border-radius:0.5rem;color:#f8fafc;font-size:0.875rem;">';
      var ranges = ['1h', '6h', '24h', '7d'];
      for (var ri = 0; ri < ranges.length; ri++) {
        html += '<option value="' + ranges[ri] + '"' + (state.appMetricsRange === ranges[ri] ? ' selected' : '') + '>' + ranges[ri] + '</option>';
      }
      html += '</select></div>';
      // Platform filter
      html += '<div style="display:flex;flex-direction:column;"><label style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.25rem;">Platform</label>';
      html += '<select id="app-metrics-platform" style="padding:0.5rem 0.75rem;background:#0f172a;border:1px solid #475569;border-radius:0.5rem;color:#f8fafc;font-size:0.875rem;">';
      html += '<option value="">All Platforms</option>';
      for (var pi = 0; pi < filters.platforms.length; pi++) {
        var p = filters.platforms[pi];
        html += '<option value="' + escapeHtml(p) + '"' + (state.appMetricsPlatform === p ? ' selected' : '') + '>' + escapeHtml(p) + '</option>';
      }
      html += '</select></div>';
      // Version filter
      html += '<div style="display:flex;flex-direction:column;"><label style="font-size:0.75rem;color:#94a3b8;margin-bottom:0.25rem;">Version</label>';
      html += '<select id="app-metrics-version" style="padding:0.5rem 0.75rem;background:#0f172a;border:1px solid #475569;border-radius:0.5rem;color:#f8fafc;font-size:0.875rem;">';
      html += '<option value="">All Versions</option>';
      for (var vi = 0; vi < filters.versions.length; vi++) {
        var v = filters.versions[vi];
        html += '<option value="' + escapeHtml(v) + '"' + (state.appMetricsVersion === v ? ' selected' : '') + '>' + escapeHtml(v) + '</option>';
      }
      html += '</select></div>';
      html += '<span style="font-size:0.75rem;color:#94a3b8;margin-left:auto;">Auto-refresh: 30s</span>';
      html += '</div>';

      // Summary cards
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:1.5rem;">';
      for (var mi = 0; mi < metrics.length; mi++) {
        var metric = metrics[mi];
        var thresholdClass = getThresholdClass(metric.metricName, metric.current);
        var thresholdLabel = getThresholdLabel(metric.metricName, metric.current);
        html += '<div style="background:#1e293b;border-radius:0.75rem;padding:1.25rem;border:1px solid #475569;">';
        html += '<h3 style="font-size:1rem;margin-bottom:0.75rem;display:flex;justify-content:space-between;align-items:center;">';
        html += escapeHtml(metricDisplayName(metric.metricName));
        html += '<span class="' + thresholdClass + '" style="font-size:0.75rem;padding:0.2rem 0.6rem;border-radius:1rem;font-weight:500;">' + escapeHtml(thresholdLabel) + '</span>';
        html += '</h3>';
        html += '<div style="display:flex;justify-content:space-around;margin-bottom:0.5rem;">';
        html += '<div style="text-align:center;"><span style="font-size:0.7rem;color:#94a3b8;display:block;">p50</span>';
        html += '<span style="font-size:1.25rem;font-weight:700;color:#3b82f6;">' + formatMetricValue(metric.current.p50, metric.unit) + '</span></div>';
        html += '<div style="text-align:center;"><span style="font-size:0.7rem;color:#94a3b8;display:block;">p95</span>';
        html += '<span style="font-size:1.25rem;font-weight:700;color:#eab308;">' + formatMetricValue(metric.current.p95, metric.unit) + '</span></div>';
        html += '<div style="text-align:center;"><span style="font-size:0.7rem;color:#94a3b8;display:block;">p99</span>';
        html += '<span style="font-size:1.25rem;font-weight:700;color:#ef4444;">' + formatMetricValue(metric.current.p99, metric.unit) + '</span></div>';
        html += '</div></div>';
      }
      html += '</div>';

      // Charts
      for (var ci = 0; ci < metrics.length; ci++) {
        var m = metrics[ci];
        html += '<div style="background:#1e293b;border-radius:0.75rem;padding:1.25rem;margin-bottom:1.5rem;border:1px solid #475569;">';
        html += '<h3 style="font-size:1rem;margin-bottom:1rem;">' + escapeHtml(metricDisplayName(m.metricName)) + ' (' + escapeHtml(m.unit) + ')</h3>';
        html += renderSvgLineChart(m.dataPoints, m.unit);
        html += '</div>';
      }

      if (metrics.length === 0 || metrics.every(function(m) { return m.dataPoints.length === 0; })) {
        html += '<div style="text-align:center;padding:3rem;color:#94a3b8;">';
        html += '<p style="font-size:1.25rem;margin-bottom:0.5rem;">No performance data available</p>';
        html += '<p style="font-size:0.875rem;">Performance metrics will appear here once the diagnostics worker begins receiving data from app clients.</p>';
        html += '</div>';
      }

      return html;
    }


    function renderMetricsTab() {
      return renderAppMetrics() + renderServerMetricsPanel() + (typeof renderNetworkMetrics === 'function' ? renderNetworkMetrics() : '') + renderFederationHealth() + '<div style="margin-top:2rem; color: var(--text-secondary); font-size: 0.75rem;">Auto-refreshes every 30 seconds</div>';
    }

    function renderServerMetricsPanel() {
      if (state.serverMetricsDetail) return renderServerMetricsDetail();
      if (!state.serverMetrics) return '<div class="loading"><div class="spinner"></div></div>';
      var agg = state.serverMetricsAggregate || {};
      var servers = state.serverMetrics || [];
      var html = '<h3 style="margin-bottom:1rem;font-size:1rem;font-weight:600">Server Metrics</h3>';
      html += '<div class="metrics-aggregate-stats">';
      html += '<div class="stat-card"><div class="stat-value">'+(agg.totalServers||0)+'</div><div class="stat-title">Total Servers</div></div>';
      html += '<div class="stat-card"><div class="stat-value" style="color:var(--success)">'+(agg.healthyServers||0)+'</div><div class="stat-title">Healthy</div></div>';
      html += '<div class="stat-card"><div class="stat-value" style="color:var(--warning)">'+(agg.degradedServers||0)+'</div><div class="stat-title">Degraded</div></div>';
      html += '<div class="stat-card"><div class="stat-value" style="color:var(--danger)">'+(agg.offlineServers||0)+'</div><div class="stat-title">Offline</div></div>';
      html += '<div class="stat-card"><div class="stat-value">'+(agg.totalConnections||0)+'</div><div class="stat-title">Total Connections</div></div>';
      html += '<div class="stat-card"><div class="stat-value">'+(agg.totalThroughput||0)+'</div><div class="stat-title">Msgs/min</div></div>';
      html += '</div>';
      if (servers.length === 0) {
        html += '<div class="empty-state"><p>No server metrics data available yet.</p><p>Configure ZAJEL_DIAGNOSTICS_URL and DIAGNOSTICS_PUSH_SECRET on VPS servers.</p></div>';
      } else {
        html += '<div class="metrics-server-grid">';
        servers.forEach(function(server) {
          var m = server.metrics || {};
          var cpuPct = m.cpuPercent || 0;
          var memMb = m.memoryMb || 0;
          var isStale = (Date.now() - server.lastSeen) > 300000;
          var cpuColor = cpuPct > 90 ? 'var(--danger)' : cpuPct > 70 ? 'var(--warning)' : 'var(--success)';
          var connColor = (m.connectionsTotal||0) > 5000 ? 'var(--danger)' : (m.connectionsTotal||0) > 1000 ? 'var(--warning)' : 'var(--success)';
          var sStatus = server.status || 'unknown';
          var sRegion = server.region || 'unknown';
          html += '<div class="metrics-server-card health-'+escapeHtml(sStatus)+'" data-server-id="'+escapeHtml(server.serverId)+'">';
          html += '<div class="metrics-card-header"><span class="server-name">'+escapeHtml(server.serverId)+'</span><span class="status-badge status-'+escapeHtml(sStatus)+'">'+escapeHtml(sStatus.toUpperCase())+'</span></div>';
          html += '<div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.5rem">'+escapeHtml(sRegion)+(isStale?' <span class="stale-indicator">STALE</span>':'')+'</div>';
          html += '<div class="metrics-bars">';
          html += '<div class="metrics-bar-row"><div class="metrics-bar-label"><span>CPU</span><span>'+cpuPct.toFixed(1)+'%</span></div><div class="metrics-bar-track"><div class="metrics-bar-fill" style="width:'+Math.min(100,cpuPct)+'%;background:'+cpuColor+'"></div></div></div>';
          html += '<div class="metrics-bar-row"><div class="metrics-bar-label"><span>Memory</span><span>'+memMb.toFixed(0)+' MB</span></div><div class="metrics-bar-track"><div class="metrics-bar-fill" style="width:'+Math.min(100,(memMb/512)*100)+'%;background:var(--accent)"></div></div></div>';
          html += '</div><div class="metrics-card-stats">';
          html += '<div class="stat-item"><span class="stat-label">Connections</span><span style="color:'+connColor+'">'+(m.connectionsTotal||0)+'</span></div>';
          html += '<div class="stat-item"><span class="stat-label">Relay</span><span>'+(m.connectionsRelay||0)+'</span></div>';
          html += '<div class="stat-item"><span class="stat-label">Msgs/min</span><span>'+(m.messageRatePerMinute||0)+'</span></div>';
          html += '<div class="stat-item"><span class="stat-label">Federation</span><span>'+(m.federationAliveMembers||0)+'/'+(m.federationTotalMembers||0)+'</span></div>';
          html += '<div class="stat-item"><span class="stat-label">Uptime</span><span>'+smFormatUptime(m.uptimeSeconds||0)+'</span></div>';
          html += '<div class="stat-item"><span class="stat-label">Active Codes</span><span>'+(m.entropyActiveCodes||0)+'</span></div>';
          html += '</div></div>';
        });
        html += '</div>';
      }
      return html;
    }

    function renderServerMetricsDetail() {
      var d = state.serverMetricsDetail;
      if (!d) return '';
      var html = '<div class="metrics-detail-container">';
      html += '<div class="metrics-detail-header"><h3>Server: '+escapeHtml(d.serverId)+' ('+escapeHtml(d.region)+')</h3>';
      html += '<button class="metrics-detail-back" id="server-metrics-back">Back to Server List</button></div>';
      html += '<div class="metrics-range-selector">';
      ['1h','6h','24h','7d'].forEach(function(r) {
        html += '<div class="metrics-range-btn '+(state.serverMetricsRange===r?'active':'')+'" data-sm-range="'+r+'">'+r+'</div>';
      });
      html += '</div>';
      if (d.history.length === 0) {
        html += '<div class="empty-state"><p>No historical data for this time range.</p></div>';
      } else {
        html += '<div class="metrics-detail-charts">';
        html += '<div class="metrics-chart-card"><h4>CPU Usage (%)</h4><div class="metrics-mini-chart" id="sm-chart-cpu"></div></div>';
        html += '<div class="metrics-chart-card"><h4>Memory (MB)</h4><div class="metrics-mini-chart" id="sm-chart-memory"></div></div>';
        html += '<div class="metrics-chart-card"><h4>Connections</h4><div class="metrics-mini-chart" id="sm-chart-connections"></div></div>';
        html += '<div class="metrics-chart-card"><h4>Message Rate (msgs/min)</h4><div class="metrics-mini-chart" id="sm-chart-msgrate"></div></div>';
        html += '</div>';
      }
      html += '</div>';
      return html;
    }

    function smFormatUptime(secs) {
      if (secs < 60) return secs + 's';
      if (secs < 3600) return Math.floor(secs/60) + 'm';
      if (secs < 86400) return Math.floor(secs/3600) + 'h ' + Math.floor((secs%3600)/60) + 'm';
      return Math.floor(secs/86400) + 'd ' + Math.floor((secs%86400)/3600) + 'h';
    }

    function drawServerMetricsCharts() {
      var detail = state.serverMetricsDetail;
      if (!detail || !detail.history || detail.history.length < 2) return;
      var history = detail.history;
      [{id:'sm-chart-cpu',key:'cpuPercent',color:'#ef4444',mf:100},{id:'sm-chart-memory',key:'memoryMb',color:'#3b82f6',mf:null},{id:'sm-chart-connections',key:'connectionsTotal',color:'#22c55e',mf:null},{id:'sm-chart-msgrate',key:'messageRatePerMinute',color:'#eab308',mf:null}].forEach(function(c) {
        var el = document.getElementById(c.id);
        if (!el) return;
        var w = el.clientWidth, h = 180, p = {t:10,r:20,b:25,l:50};
        var vals = history.map(function(x){return x[c.key]||0;});
        var mx = c.mf || Math.max.apply(null,vals.concat([1]));
        var t0 = history[0].timestamp, t1 = history[history.length-1].timestamp, ts = t1-t0||1;
        var pd = history.map(function(x,i){
          var px = p.l+((x.timestamp-t0)/ts)*(w-p.l-p.r);
          var py = p.t+(1-(x[c.key]||0)/mx)*(h-p.t-p.b);
          return (i===0?'M':'L')+px.toFixed(1)+','+py.toFixed(1);
        }).join(' ');
        var ad = pd+' L'+(w-p.r)+','+(h-p.b)+' L'+p.l+','+(h-p.b)+' Z';
        var gl = [0,0.25,0.5,0.75,1].map(function(pct){
          var gy = p.t+(1-pct)*(h-p.t-p.b); var gv = (mx*pct).toFixed(0);
          return '<line x1="'+p.l+'" y1="'+gy+'" x2="'+(w-p.r)+'" y2="'+gy+'" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4"/><text x="'+(p.l-5)+'" y="'+(gy+4)+'" fill="var(--text-secondary)" font-size="10" text-anchor="end">'+gv+'</text>';
        }).join('');
        el.innerHTML='<svg width="'+w+'" height="'+h+'">'+gl+'<path d="'+ad+'" fill="'+c.color+'22"/><path d="'+pd+'" fill="none" stroke="'+c.color+'" stroke-width="2"/></svg>';
      });
    }

    function gaugeColor(rate) {
      if (rate === null) return 'na';
      if (rate > 95) return 'green';
      if (rate >= 85) return 'yellow';
      return 'red';
    }

    function renderGaugeSvg(value, size) {
      size = size || 100;
      var r = (size - 10) / 2;
      var cx = size / 2;
      var cy = size / 2;
      var circumference = 2 * Math.PI * r;
      var pct = value !== null ? value / 100 : 0;
      var offset = circumference * (1 - pct);
      var color = value === null ? '#64748b' : value > 95 ? '#22c55e' : value >= 85 ? '#eab308' : '#ef4444';

      return '<svg class="gauge-svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">'
        + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#334155" stroke-width="8"/>'
        + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="8" '
        + 'stroke-dasharray="' + circumference + '" stroke-dashoffset="' + offset + '" '
        + 'transform="rotate(-90 ' + cx + ' ' + cy + ')" stroke-linecap="round"/>'
        + '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="' + color + '" font-size="18" font-weight="700">'
        + (value !== null ? value.toFixed(1) + '%' : 'N/A')
        + '</text></svg>';
    }

    function renderDonutSvg(relayCount, directCount) {
      var total = relayCount + directCount;
      if (total === 0) {
        return '<svg width="120" height="120" viewBox="0 0 120 120">'
          + '<circle cx="60" cy="60" r="50" fill="none" stroke="#334155" stroke-width="16"/>'
          + '<text x="60" y="64" text-anchor="middle" fill="#64748b" font-size="14">No data</text></svg>';
      }
      var relayPct = relayCount / total;
      var r = 50;
      var circumference = 2 * Math.PI * r;
      var relayLen = circumference * relayPct;
      var directLen = circumference - relayLen;

      return '<svg width="120" height="120" viewBox="0 0 120 120">'
        + '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="#3b82f6" stroke-width="16" '
        + 'stroke-dasharray="' + directLen + ' ' + relayLen + '" '
        + 'transform="rotate(-90 60 60)"/>'
        + '<circle cx="60" cy="60" r="' + r + '" fill="none" stroke="#f97316" stroke-width="16" '
        + 'stroke-dasharray="' + relayLen + ' ' + directLen + '" '
        + 'stroke-dashoffset="-' + directLen + '" '
        + 'transform="rotate(-90 60 60)"/>'
        + '<text x="60" y="58" text-anchor="middle" fill="#f8fafc" font-size="16" font-weight="700">' + total + '</text>'
        + '<text x="60" y="74" text-anchor="middle" fill="#94a3b8" font-size="10">total</text></svg>';
    }

    function renderNetworkMetrics() {
      var nd = state.networkMetricsData;
      if (!nd) {
        return '<div class="network-metrics-section"><h3>Network Success Rates</h3><div class="loading"><div class="spinner"></div></div></div>';
      }

      // When API returns raw metrics (no pre-computed aggregates), show empty state
      if (!nd.current) {
        var emptyMetrics = (nd.metrics || []);
        if (emptyMetrics.length === 0) {
          return '<div class="network-metrics-section"><h3>Network Success Rates</h3>'
            + '<div style="color:var(--text-secondary);font-size:0.875rem;padding:2rem 0;text-align:center">No network metrics collected yet</div></div>';
        }
        // Compute aggregates from raw metric rows
        var totalSigSuccess = 0, totalSigFail = 0, totalWrtcSuccess = 0, totalWrtcFail = 0;
        var totalRelay = 0, totalDirect = 0, latencySum = 0, latencyCount = 0;
        var platformMap = {};
        var uniquePlatforms = [];
        var uniqueVersions = [];
        emptyMetrics.forEach(function(m) {
          totalSigSuccess += (m.signaling_success_count || 0);
          totalSigFail += (m.signaling_failure_count || 0);
          totalWrtcSuccess += (m.webrtc_success_count || 0);
          totalWrtcFail += (m.webrtc_failure_count || 0);
          totalRelay += (m.relay_usage_count || 0);
          totalDirect += (m.direct_p2p_count || 0);
          if (m.avg_latency_ms != null) { latencySum += m.avg_latency_ms; latencyCount++; }
          if (m.platform && uniquePlatforms.indexOf(m.platform) === -1) uniquePlatforms.push(m.platform);
          if (m.app_version && uniqueVersions.indexOf(m.app_version) === -1) uniqueVersions.push(m.app_version);
        });
        var sigAttempts = totalSigSuccess + totalSigFail;
        var wrtcAttempts = totalWrtcSuccess + totalWrtcFail;
        nd.current = {
          signalingSuccessRate: sigAttempts > 0 ? (totalSigSuccess / sigAttempts) * 100 : null,
          signalingAttempts: sigAttempts,
          webrtcSuccessRate: wrtcAttempts > 0 ? (totalWrtcSuccess / wrtcAttempts) * 100 : null,
          webrtcAttempts: wrtcAttempts,
          avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
        };
        nd.distribution = { relayCount: totalRelay, directP2pCount: totalDirect };
        nd.filters = { platforms: uniquePlatforms, versions: uniqueVersions };
        nd.platformBreakdown = [];
        nd.trends = { latency: [] };
      }

      var filters = nd.filters || { platforms: [], versions: [] };

      // Filter bar
      var filterHtml = '<div class="network-filter-bar">';
      // Range selector
      ['1h','6h','24h','7d'].forEach(function(r) {
        filterHtml += '<div class="metrics-range-btn network-range-btn ' + (state.networkMetricsRange === r ? 'active' : '') + '" data-range="' + r + '">' + r + '</div>';
      });
      // Platform filter
      filterHtml += '<select id="network-platform-filter"><option value="">All Platforms</option>';
      filters.platforms.forEach(function(p) {
        filterHtml += '<option value="' + escapeHtml(p) + '"' + (state.networkMetricsPlatform === p ? ' selected' : '') + '>' + escapeHtml(p) + '</option>';
      });
      filterHtml += '</select>';
      // Version filter
      filterHtml += '<select id="network-version-filter"><option value="">All Versions</option>';
      filters.versions.forEach(function(v) {
        filterHtml += '<option value="' + escapeHtml(v) + '"' + (state.networkMetricsVersion === v ? ' selected' : '') + '>' + escapeHtml(v) + '</option>';
      });
      filterHtml += '</select></div>';

      var c = nd.current;

      // Gauges
      var gaugesHtml = '<div class="network-gauges">';
      gaugesHtml += '<div class="gauge-card"><h4>Signaling Success Rate</h4>' + renderGaugeSvg(c.signalingSuccessRate, 110)
        + '<div class="gauge-label">' + c.signalingAttempts + ' attempts</div></div>';
      gaugesHtml += '<div class="gauge-card"><h4>WebRTC Establishment Rate</h4>' + renderGaugeSvg(c.webrtcSuccessRate, 110)
        + '<div class="gauge-label">' + c.webrtcAttempts + ' attempts</div></div>';
      gaugesHtml += '<div class="gauge-card"><h4>Avg Latency</h4>'
        + '<div class="gauge-value" style="color: var(--accent); margin-top: 1rem;">'
        + (c.avgLatencyMs !== null ? c.avgLatencyMs.toFixed(1) + ' ms' : 'N/A') + '</div>'
        + '<div class="gauge-label">connection establishment</div></div>';
      gaugesHtml += '</div>';

      // Charts grid: Donut + Latency trend
      var chartsHtml = '<div class="network-charts-grid">';
      // Donut chart
      var dist = nd.distribution;
      chartsHtml += '<div class="network-chart-card"><h4>Connection Type Distribution</h4>'
        + '<div class="donut-container">' + renderDonutSvg(dist.relayCount, dist.directP2pCount)
        + '<div class="donut-legend">'
        + '<div class="donut-legend-item"><div class="donut-legend-color" style="background:#3b82f6"></div>Direct P2P: ' + dist.directP2pCount + '</div>'
        + '<div class="donut-legend-item"><div class="donut-legend-color" style="background:#f97316"></div>Relay: ' + dist.relayCount + '</div>'
        + '</div></div></div>';

      // Latency card
      chartsHtml += '<div class="network-chart-card"><h4>Connection Latency</h4>'
        + '<div class="latency-cards">'
        + '<div class="latency-card"><div class="value">' + (c.avgLatencyMs !== null ? c.avgLatencyMs.toFixed(0) : '--') + '</div><div class="label">Avg (ms)</div></div>'
        + '</div>';
      // Mini trend for latency
      if (nd.trends && nd.trends.latency && nd.trends.latency.length > 0) {
        var maxLat = 0;
        nd.trends.latency.forEach(function(p) { if (p.avgLatencyMs !== null && p.avgLatencyMs > maxLat) maxLat = p.avgLatencyMs; });
        if (maxLat > 0) {
          var latW = 300;
          var latH = 60;
          var step = latW / Math.max(nd.trends.latency.length - 1, 1);
          var points = '';
          nd.trends.latency.forEach(function(p, i) {
            var val = p.avgLatencyMs !== null ? p.avgLatencyMs : 0;
            var x = i * step;
            var y = latH - (val / maxLat) * (latH - 4);
            points += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
          });
          chartsHtml += '<svg viewBox="0 0 ' + latW + ' ' + (latH + 4) + '" style="width:100%;height:80px;margin-top:0.75rem">'
            + '<path d="' + points + '" fill="none" stroke="#3b82f6" stroke-width="2"/></svg>';
        }
      }
      chartsHtml += '</div></div>';

      // Platform breakdown table
      var tableHtml = '';
      if (nd.platformBreakdown && nd.platformBreakdown.length > 0) {
        tableHtml = '<div class="network-chart-card" style="margin-bottom:1.5rem"><h4>Platform Breakdown</h4>'
          + '<table class="platform-table"><thead><tr>'
          + '<th>Platform</th><th>Signaling Rate</th><th>WebRTC Rate</th><th>Avg Latency</th><th>Samples</th>'
          + '</tr></thead><tbody>';
        nd.platformBreakdown.forEach(function(p) {
          var sigClass = gaugeColor(p.signalingSuccessRate);
          var webrtcClass = gaugeColor(p.webrtcSuccessRate);
          tableHtml += '<tr>'
            + '<td>' + escapeHtml(p.platform) + '</td>'
            + '<td class="rate-cell ' + sigClass + '">' + (p.signalingSuccessRate !== null ? p.signalingSuccessRate.toFixed(1) + '%' : 'N/A') + '</td>'
            + '<td class="rate-cell ' + webrtcClass + '">' + (p.webrtcSuccessRate !== null ? p.webrtcSuccessRate.toFixed(1) + '%' : 'N/A') + '</td>'
            + '<td>' + (p.avgLatencyMs !== null ? p.avgLatencyMs.toFixed(1) + ' ms' : 'N/A') + '</td>'
            + '<td>' + p.sampleCount + '</td>'
            + '</tr>';
        });
        tableHtml += '</tbody></table></div>';
      }

      return '<div class="network-metrics-section"><h3>Network Success Rates</h3>'
        + filterHtml + gaugesHtml + chartsHtml + tableHtml + '</div>';
    }

    function renderFederationHealth() {
      if (!state.federationData) {
        return '<div style="margin-top:2rem"><h3 style="margin-bottom:1rem;font-size:1rem;font-weight:600">Federation Health</h3><div style="color:var(--text-secondary);font-size:0.875rem">Loading federation data...</div></div>';
      }
      var fed = state.federationData;

      // When API returns raw data (no pre-computed aggregates), compute from raw rows
      if (!fed.health) {
        var currentRows = fed.current || [];
        var historyRows = fed.history || [];
        if (currentRows.length === 0 && historyRows.length === 0) {
          return '<div style="margin-top:2rem"><h3 style="margin-bottom:1rem;font-size:1rem;font-weight:600">Federation Health</h3>'
            + '<div style="color:var(--text-secondary);font-size:0.875rem;padding:2rem 0;text-align:center">No federation data collected yet</div></div>';
        }
        // Compute aggregates from raw rows
        var totalAlive = 0, totalMembers = 0, latencies = [];
        currentRows.forEach(function(r) {
          totalAlive += (r.alive_members || 0);
          totalMembers += (r.total_members || 0);
          if (r.gossip_latency_ms != null) latencies.push(r.gossip_latency_ms);
        });
        latencies.sort(function(a, b) { return a - b; });
        var failedNodes = totalMembers - totalAlive;
        fed.health = failedNodes === 0 ? 'healthy' : failedNodes <= totalMembers * 0.5 ? 'degraded' : 'critical';
        fed.summary = { aliveNodes: totalAlive, suspectNodes: 0, failedNodes: failedNodes, totalNodes: totalMembers, regions: {} };
        fed.gossipLatency = {
          p50Ms: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : null,
          p95Ms: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null,
          p99Ms: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)] : null,
          pingCount: latencies.length,
        };
        fed.syncCompleteness = totalMembers > 0 ? Math.round((totalAlive / totalMembers) * 100) : 0;
        fed.perServer = currentRows.map(function(r) {
          return { serverId: r.server_id, region: '', aliveMembers: r.alive_members || 0, totalMembers: r.total_members || 0, gossipRttP50Ms: r.gossip_latency_ms, gossipRttP95Ms: null, lastSeen: r.timestamp };
        });
        fed.availabilityHistory = [];
      }

      var healthColor = fed.health === 'healthy' ? 'var(--success)' : fed.health === 'degraded' ? 'var(--warning)' : 'var(--danger)';
      var healthBg = fed.health === 'healthy' ? 'rgba(34,197,94,0.15)' : fed.health === 'degraded' ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)';
      function fmtMs(v) { return v !== null && v !== undefined ? v.toFixed(1) + ' ms' : 'N/A'; }
      function fmtTime(ts) { return new Date(ts).toLocaleTimeString(); }

      var rangeHtml = '<div style="display:flex;gap:0.5rem;margin-bottom:1rem">';
      ['1h','6h','24h'].forEach(function(r) {
        var active = state.federationRange === r ? 'background:var(--accent);color:white;border-color:var(--accent)' : '';
        rangeHtml += '<button class="fed-range-btn" data-range="' + r + '" style="padding:0.25rem 0.75rem;font-size:0.75rem;border:1px solid var(--border);border-radius:0.25rem;cursor:pointer;' + active + '">' + r + '</button>';
      });
      rangeHtml += '</div>';

      var badgeHtml = '<div style="display:inline-block;padding:0.5rem 1.5rem;border-radius:0.5rem;font-size:1.1rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:' + healthColor + ';background:' + healthBg + '">' + escapeHtml(fed.health) + '</div>';

      var nodesHtml = '<div style="display:flex;gap:1.5rem;margin:1rem 0;flex-wrap:wrap;font-size:0.9rem">'
        + '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--success);vertical-align:middle"></span> Alive: ' + fed.summary.aliveNodes + '</span>'
        + '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--warning);vertical-align:middle"></span> Suspect: ' + fed.summary.suspectNodes + '</span>'
        + '<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--danger);vertical-align:middle"></span> Failed: ' + fed.summary.failedNodes + '</span>'
        + '<span>Total: ' + fed.summary.totalNodes + '</span></div>';

      var latencyHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1rem;margin:1rem 0">';
      [['p50',fed.gossipLatency.p50Ms],['p95',fed.gossipLatency.p95Ms],['p99',fed.gossipLatency.p99Ms],['Pings',fed.gossipLatency.pingCount]].forEach(function(item) {
        var val = item[0] === 'Pings' ? (item[1] || 0) : fmtMs(item[1]);
        latencyHtml += '<div style="background:var(--bg-secondary);padding:1rem;border-radius:0.5rem;text-align:center"><div style="font-size:1.3rem;font-weight:700;color:var(--accent)">' + val + '</div><div style="font-size:0.75rem;color:var(--text-secondary);margin-top:0.25rem">' + item[0] + '</div></div>';
      });
      latencyHtml += '</div>';

      var syncColor = fed.syncCompleteness >= 90 ? 'var(--success)' : fed.syncCompleteness >= 50 ? 'var(--warning)' : 'var(--danger)';
      var syncHtml = '<div style="margin:1rem 0"><div style="display:flex;justify-content:space-between;font-size:0.875rem;margin-bottom:0.5rem"><span>Sync Completeness</span><span>' + fed.syncCompleteness + '%</span></div>'
        + '<div style="height:1.5rem;background:var(--bg-card);border-radius:0.75rem;overflow:hidden"><div style="height:100%;width:' + fed.syncCompleteness + '%;background:' + syncColor + ';border-radius:0.75rem;transition:width 0.5s"></div></div></div>';

      var regions = fed.summary.regions || {};
      var regionEntries = Object.entries(regions);
      var regionHtml = '';
      if (regionEntries.length > 0) {
        regionHtml = '<table style="width:100%;border-collapse:collapse;margin:1rem 0"><thead><tr><th style="text-align:left;padding:0.5rem;border-bottom:1px solid var(--border);color:var(--text-secondary);font-size:0.75rem;text-transform:uppercase">Region</th><th style="text-align:left;padding:0.5rem;border-bottom:1px solid var(--border);color:var(--text-secondary);font-size:0.75rem;text-transform:uppercase">Nodes</th></tr></thead><tbody>'
          + regionEntries.map(function(e) { return '<tr><td style="padding:0.5rem;border-bottom:1px solid var(--border)">' + escapeHtml(e[0]) + '</td><td style="padding:0.5rem;border-bottom:1px solid var(--border)">' + e[1] + '</td></tr>'; }).join('')
          + '</tbody></table>';
      }

      var serverCards = (fed.perServer || []).map(function(s) {
        var st = s.aliveMembers === s.totalMembers ? 'alive' : s.aliveMembers === 0 ? 'failed' : 'suspect';
        var sc = st === 'alive' ? 'var(--success)' : st === 'suspect' ? 'var(--warning)' : 'var(--danger)';
        return '<div style="background:var(--bg-secondary);border-radius:0.75rem;padding:1rem;border:1px solid var(--border)">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem"><span style="font-weight:600;font-size:0.9rem">' + escapeHtml(s.serverId) + '</span><span style="padding:0.15rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;font-weight:600;color:white;background:' + sc + '">' + st.toUpperCase() + '</span></div>'
          + '<div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.5rem">' + escapeHtml(s.region) + '</div>'
          + '<div style="font-size:0.8rem;color:var(--text-secondary);display:grid;grid-template-columns:1fr 1fr;gap:0.25rem">'
          + '<div>Members: ' + s.aliveMembers + '/' + s.totalMembers + '</div><div>RTT p50: ' + fmtMs(s.gossipRttP50Ms) + '</div>'
          + '<div>RTT p95: ' + fmtMs(s.gossipRttP95Ms) + '</div><div>Last: ' + fmtTime(s.lastSeen) + '</div></div></div>';
      }).join('');
      var gridHtml = serverCards ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;margin:1rem 0">' + serverCards + '</div>' : '<div style="color:var(--text-secondary);font-size:0.875rem">No server data</div>';

      var timelineHtml = '';
      (fed.availabilityHistory || []).forEach(function(entry) {
        var tl = entry.timeline || [];
        if (tl.length === 0) return;
        var minTs = tl[0].timestamp, maxTs = tl[tl.length - 1].timestamp, range = maxTs - minTs || 1;
        var rects = '';
        for (var i = 0; i < tl.length; i++) {
          var t = tl[i], x = ((t.timestamp - minTs) / range) * 600;
          var nextTs = i < tl.length - 1 ? tl[i + 1].timestamp : maxTs;
          var w = Math.max(((nextTs - t.timestamp) / range) * 600, 2);
          var c = t.status === 'alive' ? '#22c55e' : t.status === 'suspect' ? '#eab308' : t.status === 'failed' ? '#ef4444' : '#94a3b8';
          rects += '<rect x="' + x + '" y="0" width="' + w + '" height="20" fill="' + c + '" rx="2"/>';
        }
        timelineHtml += '<div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.5rem"><span style="min-width:120px;font-size:0.8rem;color:var(--text-secondary);text-align:right">' + escapeHtml(entry.serverId) + '</span><div style="flex:1;height:20px"><svg width="100%" height="20" viewBox="0 0 600 20" preserveAspectRatio="none">' + rects + '</svg></div></div>';
      });
      if (timelineHtml) {
        timelineHtml = '<div style="display:flex;gap:1rem;margin-bottom:0.5rem;font-size:0.75rem;color:var(--text-secondary)"><span style="display:inline-flex;align-items:center;gap:0.25rem"><span style="width:10px;height:10px;border-radius:50%;background:#22c55e"></span> Alive</span><span style="display:inline-flex;align-items:center;gap:0.25rem"><span style="width:10px;height:10px;border-radius:50%;background:#eab308"></span> Suspect</span><span style="display:inline-flex;align-items:center;gap:0.25rem"><span style="width:10px;height:10px;border-radius:50%;background:#ef4444"></span> Failed</span><span style="display:inline-flex;align-items:center;gap:0.25rem"><span style="width:10px;height:10px;border-radius:50%;background:#94a3b8"></span> Offline</span></div>' + timelineHtml;
      } else {
        timelineHtml = '<div style="color:var(--text-secondary);font-size:0.875rem">No timeline data</div>';
      }

      return '<div style="margin-top:2rem"><h3 style="margin-bottom:1rem;font-size:1rem;font-weight:600">Federation Health</h3>'
        + rangeHtml + badgeHtml + nodesHtml
        + '<h4 style="margin-top:1.5rem;margin-bottom:0.5rem;font-size:0.9rem;font-weight:600">Gossip Latency</h4>' + latencyHtml
        + '<h4 style="margin-top:1.5rem;margin-bottom:0.5rem;font-size:0.9rem;font-weight:600">Sync Completeness</h4>' + syncHtml
        + (regionHtml ? '<h4 style="margin-top:1.5rem;margin-bottom:0.5rem;font-size:0.9rem;font-weight:600">Regions</h4>' + regionHtml : '')
        + '<h4 style="margin-top:1.5rem;margin-bottom:0.5rem;font-size:0.9rem;font-weight:600">Per-Server Status</h4>' + gridHtml
        + '<h4 style="margin-top:1.5rem;margin-bottom:0.5rem;font-size:0.9rem;font-weight:600">Availability Timeline</h4>' + timelineHtml
        + '</div>';
    }

    function attachEventListeners() {
      // Login form
      const loginForm = document.getElementById('login-form');
      if (loginForm) {
        loginForm.addEventListener('submit', (e) => {
          e.preventDefault();
          state.error = null;
          const username = document.getElementById('username').value;
          const password = document.getElementById('password').value;
          login(username, password);
        });
      }

      // Logout button
      const logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
      }

      // Tabs
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', async () => {
          state.activeTab = tab.dataset.tab;
          await loadData();
          render();
        });
      });

      // Federation range buttons
      document.querySelectorAll('.fed-range-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          state.federationRange = btn.dataset.range;
          await loadFederationMetrics();
          render();
        });
      });

      // Server cards
      document.querySelectorAll('.server-card').forEach(card => {
        card.addEventListener('click', () => {
          const server = state.servers.find(s => s.endpoint === card.dataset.endpoint);
          if (server) openVpsDashboard(server);
        });
      });

      // Add user form
      const addUserForm = document.getElementById('add-user-form');
      if (addUserForm) {
        addUserForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          state.error = null;
          const username = document.getElementById('new-username').value;
          const password = document.getElementById('new-password').value;
          const role = document.getElementById('new-role').value;
          if (await createUser(username, password, role)) {
            addUserForm.reset();
          }
        });
      }

      // Delete user buttons
      document.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteUser(btn.dataset.userId);
        });
      });

      // Time range selector for errors tab
      document.querySelectorAll('.time-range-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          state.errorRange = btn.dataset.range;
          await loadErrors();
          render();
        });
      });

      // View Regressions button
      const viewRegressionsBtn = document.getElementById('view-regressions-btn');
      if (viewRegressionsBtn) {
        viewRegressionsBtn.addEventListener('click', () => {
          state.showRegressionList = !state.showRegressionList;
          render();
        });
      }

      // Regression signature links (link to error detail view if available)
      document.querySelectorAll('.regression-sig-link').forEach(link => {
        link.addEventListener('click', () => {
          const sig = link.dataset.signature;
          if (sig) {
            // Navigate to error detail view (US-2.3)
            window.location.hash = '#error/' + encodeURIComponent(sig);
          }
        });
      });

      // App metrics filter controls (US-3.1)
      const appMetricsRange = document.getElementById('app-metrics-range');
      if (appMetricsRange) {
        appMetricsRange.addEventListener('change', async () => {
          state.appMetricsRange = appMetricsRange.value;
          await loadAppMetrics();
          render();
        });
      }
      const appMetricsPlatform = document.getElementById('app-metrics-platform');
      if (appMetricsPlatform) {
        appMetricsPlatform.addEventListener('change', async () => {
          state.appMetricsPlatform = appMetricsPlatform.value;
          await loadAppMetrics();
          render();
        });
      }
      const appMetricsVersion = document.getElementById('app-metrics-version');
      if (appMetricsVersion) {
        appMetricsVersion.addEventListener('change', async () => {
          state.appMetricsVersion = appMetricsVersion.value;
          await loadAppMetrics();
          render();
        });
      }

      // Initialize error trends chart if on errors tab
      if (state.activeTab === 'errors') {
        initTrendsChart();
      }

      // Network metrics range buttons
      document.querySelectorAll('.network-range-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          state.networkMetricsRange = btn.dataset.range;
          await loadNetworkMetrics();
          render();
        });
      });

      // Network metrics platform filter
      var platformFilter = document.getElementById('network-platform-filter');
      if (platformFilter) {
        platformFilter.addEventListener('change', async () => {
          state.networkMetricsPlatform = platformFilter.value;
          await loadNetworkMetrics();
          render();
        });
      }

      // Network metrics version filter
      var versionFilter = document.getElementById('network-version-filter');
      if (versionFilter) {
        versionFilter.addEventListener('change', async () => {
          state.networkMetricsVersion = versionFilter.value;
          await loadNetworkMetrics();
          render();
        });
      }

      // Server metrics cards (US-3.3)
      document.querySelectorAll('.metrics-server-card').forEach(card => {
        card.addEventListener('click', () => {
          var serverId = card.dataset.serverId;
          if (serverId) loadServerMetricsDetail(serverId);
        });
      });

      // Server metrics detail back button
      var smBackBtn = document.getElementById('server-metrics-back');
      if (smBackBtn) {
        smBackBtn.addEventListener('click', () => {
          state.serverMetricsDetail = null;
          render();
        });
      }

      // Server metrics detail range buttons
      document.querySelectorAll('[data-sm-range]').forEach(btn => {
        btn.addEventListener('click', () => {
          state.serverMetricsRange = btn.dataset.smRange;
          if (state.serverMetricsDetail) {
            loadServerMetricsDetail(state.serverMetricsDetail.serverId);
          }
        });
      });

      // Draw server metrics charts if detail view
      if (state.activeTab === 'metrics' && state.serverMetricsDetail) {
        drawServerMetricsCharts();
      }
    }

    // Category colors for the chart
    var CATEGORY_COLORS = {
      crash: '#ef4444',
      network: '#eab308',
      crypto: '#a855f7',
      storage: '#3b82f6',
      ui: '#22c55e',
      protocol: '#f97316',
      other: '#94a3b8',
    };

    function initTrendsChart() {
      var chartEl = document.getElementById('error-trends-chart');
      if (!chartEl) return;

      // Destroy previous chart instance
      if (trendsChart) {
        trendsChart.destroy();
        trendsChart = null;
      }

      // Check if uPlot is loaded
      if (typeof uPlot === 'undefined') {
        chartEl.innerHTML = '<div class="chart-unavailable">Chart library unavailable</div>';
        return;
      }

      var trends = state.trendsData;
      if (!trends || !trends.timestamps || trends.timestamps.length === 0) {
        chartEl.innerHTML = '<div class="chart-empty-state">No trend data available for the selected time range</div>';
        return;
      }

      // Build uPlot data: [timestamps, ...series_values]
      var categories = Object.keys(trends.series);
      if (categories.length === 0) {
        chartEl.innerHTML = '<div class="chart-empty-state">No trend data available for the selected time range</div>';
        return;
      }

      var chartData = [trends.timestamps];
      categories.forEach(function(cat) {
        chartData.push(trends.series[cat]);
      });

      // Stacking plugin: offset each series by cumulative sum of prior series
      function stackedPaths(u, seriesIdx, idx0, idx1) {
        var xdata = u.data[0];
        var ydata = u.data[seriesIdx];
        var scaleY = function(val) { return u.valToPos(val, u.series[seriesIdx].scale, true); };

        var baseline = new Array(xdata.length).fill(0);
        for (var si = 1; si < seriesIdx; si++) {
          for (var sj = 0; sj < xdata.length; sj++) {
            baseline[sj] += (u.data[si][sj] || 0);
          }
        }

        var strokePath = new Path2D();
        var fillPath = new Path2D();
        var isFirst = true;

        for (var pi = idx0; pi <= idx1; pi++) {
          var xp = u.valToPos(xdata[pi], 'x', true);
          var yv = (ydata[pi] || 0) + baseline[pi];
          var yp = scaleY(yv);
          if (isFirst) {
            strokePath.moveTo(xp, yp);
            fillPath.moveTo(xp, yp);
            isFirst = false;
          } else {
            strokePath.lineTo(xp, yp);
            fillPath.lineTo(xp, yp);
          }
        }

        for (var bi = idx1; bi >= idx0; bi--) {
          var bx = u.valToPos(xdata[bi], 'x', true);
          var by = scaleY(baseline[bi]);
          fillPath.lineTo(bx, by);
        }
        fillPath.closePath();

        return { stroke: strokePath, fill: fillPath };
      }

      // Build series config
      var seriesConfig = [{}];
      categories.forEach(function(cat) {
        var color = CATEGORY_COLORS[cat] || '#94a3b8';
        seriesConfig.push({
          label: cat,
          stroke: color,
          fill: color + '40',
          width: 2,
          scale: 'y',
          paths: stackedPaths,
        });
      });

      // Calculate max stacked value for scale
      var maxStacked = 0;
      for (var mi = 0; mi < trends.timestamps.length; mi++) {
        var msum = 0;
        categories.forEach(function(cat) {
          msum += (trends.series[cat][mi] || 0);
        });
        if (msum > maxStacked) maxStacked = msum;
      }

      var opts = {
        width: chartEl.clientWidth,
        height: 280,
        cursor: { drag: { setScale: false } },
        scales: {
          x: { time: true },
          y: { range: [0, Math.max(maxStacked * 1.1, 1)] },
        },
        axes: [
          {
            stroke: '#94a3b8',
            grid: { stroke: '#1e293b', width: 1 },
            ticks: { stroke: '#334155', width: 1 },
            font: '11px system-ui',
          },
          {
            stroke: '#94a3b8',
            grid: { stroke: '#1e293b', width: 1 },
            ticks: { stroke: '#334155', width: 1 },
            font: '11px system-ui',
            size: 50,
          },
        ],
        series: seriesConfig,
        hooks: {
          draw: [
            function(u) {
              if (!trends.deployments || trends.deployments.length === 0) return;
              var ctx = u.ctx;
              var pLeft = u.bbox.left / devicePixelRatio;
              var pTop = u.bbox.top / devicePixelRatio;
              var pHeight = u.bbox.height / devicePixelRatio;
              var pRight = pLeft + u.bbox.width / devicePixelRatio;

              trends.deployments.forEach(function(dep) {
                var tsS = dep.timestamp / 1000;
                var xp = u.valToPos(tsS, 'x', true);
                if (xp < pLeft || xp > pRight) return;

                ctx.save();
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = '#94a3b8';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(xp, pTop);
                ctx.lineTo(xp, pTop + pHeight);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.fillStyle = '#94a3b8';
                ctx.font = '10px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText('v' + dep.version, xp, pTop - 4);
                ctx.restore();
              });
            }
          ],
        },
      };

      try {
        trendsChart = new uPlot(opts, chartData, chartEl);

        var ro = new ResizeObserver(function() {
          if (trendsChart && chartEl.clientWidth > 0) {
            trendsChart.setSize({ width: chartEl.clientWidth, height: 280 });
          }
        });
        ro.observe(chartEl);

        var tooltip = document.createElement('div');
        tooltip.className = 'trends-tooltip';
        tooltip.style.display = 'none';
        chartEl.appendChild(tooltip);

        trendsChart.over.addEventListener('mousemove', function(e) {
          var idx = trendsChart.cursor.idx;
          if (idx == null || idx < 0 || idx >= trends.timestamps.length) {
            tooltip.style.display = 'none';
            return;
          }
          var ts = trends.timestamps[idx];
          var date = new Date(ts * 1000);
          var timeStr = date.toLocaleString();

          var total = 0;
          var rows = '';
          categories.forEach(function(cat) {
            var val = trends.series[cat][idx] || 0;
            total += val;
            var clr = CATEGORY_COLORS[cat] || '#94a3b8';
            rows += '<div class="tooltip-row"><span><span class="tooltip-color" style="background:' + clr + '"></span>' + escapeHtml(cat) + '</span><span>' + val + '</span></div>';
          });

          tooltip.innerHTML = '<div class="tooltip-time">' + escapeHtml(timeStr) + '</div>' + rows + '<div class="tooltip-total"><span>Total</span><span>' + total + '</span></div>';
          tooltip.style.display = 'block';

          var rect = chartEl.getBoundingClientRect();
          var tooltipRect = tooltip.getBoundingClientRect();
          var left = e.clientX - rect.left + 12;
          if (left + tooltipRect.width > rect.width) {
            left = e.clientX - rect.left - tooltipRect.width - 12;
          }
          var ttop = e.clientY - rect.top - tooltipRect.height / 2;
          if (ttop < 0) ttop = 0;
          if (ttop + tooltipRect.height > rect.height) ttop = rect.height - tooltipRect.height;
          tooltip.style.left = left + 'px';
          tooltip.style.top = ttop + 'px';
        });

        trendsChart.over.addEventListener('mouseleave', function() {
          tooltip.style.display = 'none';
        });

      } catch (err) {
        console.error('Failed to initialize trends chart:', err);
        chartEl.innerHTML = '<div class="chart-unavailable">Chart unavailable</div>';
      }
    }

    // Start
    init();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * JSON response helper
 */
function jsonResponse<T>(
  data: { success: boolean; data?: T; error?: string },
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
