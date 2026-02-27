/**
 * Admin API Routes for VPS Dashboard
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { requireAuth, sendJson, setAuthCookie, extractToken, verifyJwt } from './auth.js';
import type { MetricsCollector } from './metrics.js';
import type { AdminConfig } from './types.js';

export class AdminRoutes {
  private metricsCollector: MetricsCollector;
  private config: AdminConfig;

  constructor(metricsCollector: MetricsCollector, config: AdminConfig) {
    this.metricsCollector = metricsCollector;
    this.config = config;
  }

  /**
   * Handle admin HTTP requests
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    path: string
  ): Promise<boolean> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', this.config.cfAdminUrl || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // Handle token from URL (set cookie and redirect)
    if (path === '/admin/' || path === '/admin') {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const queryToken = url.searchParams.get('token');

      if (queryToken) {
        // Verify token before setting cookie
        const payload = verifyJwt(queryToken, this.config.jwtSecret);
        if (payload) {
          const isSecure = req.headers['x-forwarded-proto'] === 'https'
            || (req.connection as { encrypted?: boolean })?.encrypted === true;
          setAuthCookie(res, queryToken, isSecure);
          // Redirect to remove token from URL
          res.writeHead(302, { Location: '/admin/' });
          res.end();
          return true;
        }
        // Token invalid/expired — redirect to CF admin if configured
        if (this.config.cfAdminUrl) {
          res.writeHead(302, { Location: this.config.cfAdminUrl });
          res.end();
          return true;
        }
      }

      // Serve dashboard HTML
      this.serveDashboard(res);
      return true;
    }

    // API routes
    if (path === '/admin/api/auth/verify') {
      return this.handleVerify(req, res);
    }

    if (path === '/admin/api/metrics') {
      return this.handleMetrics(req, res);
    }

    if (path === '/admin/api/metrics/history') {
      return this.handleMetricsHistory(req, res);
    }

    if (path === '/admin/api/federation') {
      return this.handleFederation(req, res);
    }

    if (path === '/admin/api/scaling') {
      return this.handleScaling(req, res);
    }

    // Serve dashboard for any other /admin/* route (SPA routing)
    if (path.startsWith('/admin/')) {
      this.serveDashboard(res);
      return true;
    }

    return false;
  }

  /**
   * Verify authentication
   */
  private handleVerify(req: IncomingMessage, res: ServerResponse): boolean {
    const token = extractToken(req);
    if (!token) {
      sendJson(res, { success: false, error: 'Unauthorized' }, 401);
      return true;
    }

    const payload = verifyJwt(token, this.config.jwtSecret);
    if (!payload) {
      sendJson(res, { success: false, error: 'Invalid or expired token' }, 401);
      return true;
    }

    sendJson(res, {
      success: true,
      data: {
        userId: payload.sub,
        username: payload.username,
        role: payload.role,
      },
    });
    return true;
  }

  /**
   * Get current metrics snapshot
   */
  private handleMetrics(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = requireAuth(req, res, this.config.jwtSecret);
    if (!auth) return true;

    const snapshot = this.metricsCollector.takeSnapshot();
    sendJson(res, { success: true, data: snapshot });
    return true;
  }

  /**
   * Get historical metrics
   */
  private handleMetricsHistory(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = requireAuth(req, res, this.config.jwtSecret);
    if (!auth) return true;

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const seconds = parseInt(url.searchParams.get('seconds') || '3600', 10);

    const history = this.metricsCollector.getHistory(seconds);
    sendJson(res, { success: true, data: history });
    return true;
  }

  /**
   * Get federation topology
   */
  private handleFederation(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = requireAuth(req, res, this.config.jwtSecret);
    if (!auth) return true;

    const topology = this.metricsCollector.getFederationTopology();
    sendJson(res, { success: true, data: topology });
    return true;
  }

  /**
   * Get scaling recommendations
   */
  private handleScaling(req: IncomingMessage, res: ServerResponse): boolean {
    const auth = requireAuth(req, res, this.config.jwtSecret);
    if (!auth) return true;

    const scaling = this.metricsCollector.getScalingRecommendation();
    sendJson(res, { success: true, data: scaling });
    return true;
  }

  /**
   * Serve the dashboard HTML
   */
  private serveDashboard(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(getDashboardHtml(this.config.cfAdminUrl));
  }
}

/**
 * Dashboard HTML (inline for simplicity)
 */
function getDashboardHtml(cfAdminUrl?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel VPS Dashboard</title>
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
      max-width: 1400px;
      margin: 0 auto;
      padding: 1.5rem;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }

    header h1 {
      font-size: 1.25rem;
      font-weight: 600;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    .metric-card {
      background: var(--bg-secondary);
      padding: 1.25rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
    }

    .metric-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .metric-value {
      font-size: 2rem;
      font-weight: 700;
    }

    .metric-value.success { color: var(--success); }
    .metric-value.warning { color: var(--warning); }
    .metric-value.danger { color: var(--danger); }

    .metric-subtitle {
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-top: 0.25rem;
    }

    /* Charts Row */
    .charts-row {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }

    @media (max-width: 1024px) {
      .charts-row {
        grid-template-columns: 1fr;
      }
    }

    .chart-card {
      background: var(--bg-secondary);
      padding: 1.25rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
    }

    .chart-title {
      font-size: 0.875rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }

    /* Line Chart Canvas */
    .chart-canvas {
      width: 100%;
      height: 200px;
      position: relative;
    }

    /* Entropy Gauge */
    .gauge-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 1rem 0;
    }

    .gauge-ring {
      width: 160px;
      height: 160px;
      position: relative;
    }

    .gauge-ring svg {
      transform: rotate(-90deg);
    }

    .gauge-ring circle {
      fill: none;
      stroke-width: 12;
    }

    .gauge-bg {
      stroke: var(--bg-card);
    }

    .gauge-fill {
      stroke: var(--success);
      stroke-linecap: round;
    }

    .gauge-text {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
    }

    .gauge-value {
      font-size: 1.5rem;
      font-weight: 700;
    }

    .gauge-label {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    /* Federation Graph */
    .federation-graph {
      height: 300px;
      position: relative;
      background: var(--bg-card);
      border-radius: 0.5rem;
      overflow: hidden;
    }

    .node {
      position: absolute;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.625rem;
      font-weight: 600;
      border: 2px solid;
      transition: all 0.3s ease;
    }

    .node.local {
      background: var(--accent);
      border-color: var(--accent);
      width: 64px;
      height: 64px;
      font-size: 0.75rem;
    }

    .node.alive {
      background: rgba(34, 197, 94, 0.2);
      border-color: var(--success);
      color: var(--success);
    }

    .node.suspect {
      background: rgba(234, 179, 8, 0.2);
      border-color: var(--warning);
      color: var(--warning);
    }

    .node.failed {
      background: rgba(239, 68, 68, 0.2);
      border-color: var(--danger);
      color: var(--danger);
    }

    /* Scaling Indicator */
    .scaling-card {
      background: var(--bg-secondary);
      padding: 1.25rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
    }

    .scaling-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .scaling-badge {
      padding: 0.25rem 0.75rem;
      border-radius: 1rem;
      font-size: 0.75rem;
      font-weight: 600;
    }

    .scaling-badge.normal {
      background: rgba(34, 197, 94, 0.2);
      color: var(--success);
    }

    .scaling-badge.warning {
      background: rgba(234, 179, 8, 0.2);
      color: var(--warning);
    }

    .scaling-badge.critical {
      background: rgba(239, 68, 68, 0.2);
      color: var(--danger);
    }

    .scaling-bar {
      height: 8px;
      background: var(--bg-card);
      border-radius: 4px;
      margin-bottom: 0.5rem;
      overflow: hidden;
    }

    .scaling-bar-fill {
      height: 100%;
    }

    .scaling-bar-label {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 0.75rem;
    }

    .recommendations {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
    }

    .recommendation {
      font-size: 0.875rem;
      color: var(--text-secondary);
      padding: 0.25rem 0;
    }

    /* Alerts */
    .alert {
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .alert.warning {
      background: rgba(234, 179, 8, 0.15);
      border: 1px solid var(--warning);
      color: var(--warning);
    }

    .alert.error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid var(--danger);
      color: var(--danger);
    }

    /* Login */
    .login-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: var(--bg-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .login-card {
      background: var(--bg-secondary);
      padding: 2rem;
      border-radius: 1rem;
      width: 100%;
      max-width: 360px;
      text-align: center;
    }

    .login-card h2 {
      margin-bottom: 0.5rem;
    }

    .login-card p {
      color: var(--text-secondary);
      font-size: 0.875rem;
      margin-bottom: 1.5rem;
    }

    .login-error {
      color: var(--danger);
      font-size: 0.875rem;
      margin-top: 1rem;
    }

    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 200px;
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--bg-card);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div id="app">
    <div class="loading">
      <div class="spinner"></div>
    </div>
  </div>

  <script type="module">
    // CF Admin URL for authentication redirect
    const CF_ADMIN_URL = ${cfAdminUrl ? `'${cfAdminUrl}'` : 'null'};

    // State
    let state = {
      authenticated: false,
      checking: true,
      metrics: null,
      history: [],
      federation: null,
      scaling: null,
      alerts: [],
      wsConnected: false,
    };

    let ws = null;
    let alertTimeouts = new Map();

    // Initialize
    async function init() {
      // Check authentication
      try {
        const res = await fetch('/admin/api/auth/verify', {
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json();
          if (data.success) {
            state.authenticated = true;
            await loadInitialData();
            connectWebSocket();
          }
        }
      } catch (e) {
        console.error('Auth check failed:', e);
      }

      state.checking = false;
      render();
    }

    async function loadInitialData() {
      try {
        const [metricsRes, historyRes, scalingRes] = await Promise.all([
          fetch('/admin/api/metrics', { credentials: 'include' }),
          fetch('/admin/api/metrics/history?seconds=300', { credentials: 'include' }),
          fetch('/admin/api/scaling', { credentials: 'include' }),
        ]);

        if (metricsRes.ok) {
          const data = await metricsRes.json();
          if (data.success) state.metrics = data.data;
        }

        if (historyRes.ok) {
          const data = await historyRes.json();
          if (data.success) state.history = data.data.snapshots || [];
        }

        if (scalingRes.ok) {
          const data = await scalingRes.json();
          if (data.success) state.scaling = data.data;
        }
      } catch (e) {
        console.error('Failed to load initial data:', e);
      }
    }

    function connectWebSocket() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/admin/ws';

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        state.wsConnected = true;
        render();
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWsMessage(message);
      };

      ws.onclose = () => {
        state.wsConnected = false;
        render();
        // Reconnect after 3 seconds
        setTimeout(connectWebSocket, 3000);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    }

    function handleWsMessage(message) {
      switch (message.type) {
        case 'metrics':
          state.metrics = message.data;
          // Add to history (keep last 300 entries = 5 minutes)
          state.history.push(message.data);
          if (state.history.length > 300) {
            state.history.shift();
          }
          render();
          break;

        case 'federation':
          state.federation = message.data;
          render();
          break;

        case 'alert':
          addAlert(message.data.level, message.data.message);
          break;
      }
    }

    function addAlert(level, message) {
      const id = Date.now();
      state.alerts.push({ id, level, message });
      render();

      // Auto-remove after 10 seconds
      const timeout = setTimeout(() => {
        state.alerts = state.alerts.filter(a => a.id !== id);
        alertTimeouts.delete(id);
        render();
      }, 10000);
      alertTimeouts.set(id, timeout);
    }

    function dismissAlert(id) {
      state.alerts = state.alerts.filter(a => a.id !== id);
      const timeout = alertTimeouts.get(id);
      if (timeout) {
        clearTimeout(timeout);
        alertTimeouts.delete(id);
      }
      render();
    }

    function render() {
      const app = document.getElementById('app');

      if (state.checking) {
        return;
      }

      if (!state.authenticated) {
        app.innerHTML = renderLoginRequired();
        return;
      }

      app.innerHTML = renderDashboard();
      drawConnectionChart();
      drawFederationGraph();
    }

    function renderLoginRequired() {
      if (CF_ADMIN_URL) {
        // Redirect to CF Admin after a short delay
        setTimeout(() => {
          const returnUrl = encodeURIComponent(window.location.href);
          window.location.href = CF_ADMIN_URL + '/admin/?redirect=' + returnUrl;
        }, 1500);
      }

      return \`
        <div class="login-overlay">
          <div class="login-card">
            <h2>🔐 VPS Admin Dashboard</h2>
            <p>Authentication required. Please login via the central admin dashboard.</p>
            \${CF_ADMIN_URL
              ? '<p class="login-error">Redirecting to CF Admin...</p>'
              : '<p class="login-error">CF Admin URL not configured. Set ZAJEL_CF_ADMIN_URL on the VPS.</p>'
            }
          </div>
        </div>
      \`;
    }

    function renderDashboard() {
      const m = state.metrics || {};
      const conn = m.connections || {};
      const entropy = m.entropy || {};
      const fed = m.federation || {};
      const rate = m.messageRate || {};
      const scaling = state.scaling || {};

      return \`
        <div class="container">
          <header>
            <h1>🖥️ VPS Server Dashboard</h1>
            <div class="status-indicator">
              <div class="status-dot" style="background: \${state.wsConnected ? 'var(--success)' : 'var(--danger)'}"></div>
              <span>\${state.wsConnected ? 'Live' : 'Reconnecting...'}</span>
            </div>
          </header>

          \${state.alerts.map(alert => \`
            <div class="alert \${alert.level}" onclick="dismissAlert(\${alert.id})">
              <span>\${alert.level === 'error' ? '⚠️' : 'ℹ️'}</span>
              <span>\${alert.message}</span>
            </div>
          \`).join('')}

          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">Total Connections</div>
              <div class="metric-value">\${conn.total || 0}</div>
              <div class="metric-subtitle">Relay: \${conn.relay || 0} / Signaling: \${conn.signaling || 0}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Message Rate</div>
              <div class="metric-value">\${rate.perSecond || 0}/s</div>
              <div class="metric-subtitle">\${rate.perMinute || 0} per minute</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Active Codes</div>
              <div class="metric-value \${entropy.collisionRisk === 'high' ? 'danger' : entropy.collisionRisk === 'medium' ? 'warning' : ''}">\${entropy.activeCodes || 0}</div>
              <div class="metric-subtitle">Peak: \${entropy.peakActiveCodes || 0}</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Federation Peers</div>
              <div class="metric-value \${fed.aliveMembers < 2 ? 'warning' : 'success'}">\${fed.aliveMembers || 0}</div>
              <div class="metric-subtitle">\${fed.suspectMembers || 0} suspect / \${fed.totalMembers || 0} total</div>
            </div>
          </div>

          <div class="charts-row">
            <div class="chart-card">
              <div class="chart-title">Connections Over Time</div>
              <div class="chart-canvas" id="connections-chart"></div>
            </div>
            <div class="chart-card">
              <div class="chart-title">Entropy Health</div>
              <div class="gauge-container">
                \${renderEntropyGauge(entropy)}
              </div>
            </div>
          </div>

          <div class="charts-row">
            <div class="chart-card">
              <div class="chart-title">Federation Topology</div>
              <div class="federation-graph" id="federation-graph"></div>
            </div>
            <div class="scaling-card">
              <div class="scaling-header">
                <span class="chart-title">System Health</span>
                <span class="scaling-badge \${scaling.level || 'normal'}">\${(scaling.level || 'normal').toUpperCase()}</span>
              </div>
              \${renderScalingBars(scaling.metrics || {})}
              <div class="recommendations">
                \${(scaling.recommendations || ['All systems normal']).map(r => \`
                  <div class="recommendation">• \${r}</div>
                \`).join('')}
              </div>
            </div>
          </div>
        </div>
      \`;
    }

    function renderEntropyGauge(entropy) {
      const activeCodes = entropy.activeCodes || 0;
      const maxCodes = 30000; // Critical threshold
      const percentage = Math.min(100, (activeCodes / maxCodes) * 100);
      const circumference = 2 * Math.PI * 65;
      const offset = circumference - (percentage / 100) * circumference;

      let color = 'var(--success)';
      if (entropy.collisionRisk === 'medium') color = 'var(--warning)';
      if (entropy.collisionRisk === 'high') color = 'var(--danger)';

      return \`
        <div class="gauge-ring">
          <svg width="160" height="160">
            <circle class="gauge-bg" cx="80" cy="80" r="65" />
            <circle class="gauge-fill" cx="80" cy="80" r="65"
              style="stroke: \${color}; stroke-dasharray: \${circumference}; stroke-dashoffset: \${offset}" />
          </svg>
          <div class="gauge-text">
            <div class="gauge-value" style="color: \${color}">\${Math.round(percentage)}%</div>
            <div class="gauge-label">\${entropy.collisionRisk?.toUpperCase() || 'LOW'} RISK</div>
          </div>
        </div>
      \`;
    }

    function renderScalingBars(metrics) {
      const bars = [
        { label: 'Connection Load', value: metrics.connectionLoad || 0 },
        { label: 'Entropy Pressure', value: metrics.entropyPressure || 0 },
        { label: 'Federation Health', value: metrics.federationHealth || 100 },
      ];

      return bars.map(bar => {
        let color = 'var(--success)';
        if (bar.value > 70) color = 'var(--warning)';
        if (bar.value > 90) color = 'var(--danger)';
        // Invert for federation health
        if (bar.label === 'Federation Health') {
          color = bar.value >= 100 ? 'var(--success)' : bar.value >= 50 ? 'var(--warning)' : 'var(--danger)';
        }

        return \`
          <div class="scaling-bar-label">
            <span>\${bar.label}</span>
            <span>\${Math.round(bar.value)}%</span>
          </div>
          <div class="scaling-bar">
            <div class="scaling-bar-fill" style="width: \${bar.value}%; background: \${color}"></div>
          </div>
        \`;
      }).join('');
    }

    function drawConnectionChart() {
      const container = document.getElementById('connections-chart');
      if (!container || state.history.length < 2) return;

      const width = container.clientWidth;
      const height = 200;
      const padding = { top: 20, right: 20, bottom: 30, left: 50 };

      // Get data points (last 5 minutes)
      const data = state.history.slice(-300);
      if (data.length === 0) return;

      const maxConn = Math.max(...data.map(d => d.connections?.total || 0), 10);
      const minTime = data[0].timestamp;
      const maxTime = data[data.length - 1].timestamp;

      // Create SVG
      const svg = \`
        <svg width="\${width}" height="\${height}">
          <!-- Grid lines -->
          \${[0, 0.25, 0.5, 0.75, 1].map(pct => {
            const y = padding.top + (1 - pct) * (height - padding.top - padding.bottom);
            const val = Math.round(maxConn * pct);
            return \`
              <line x1="\${padding.left}" y1="\${y}" x2="\${width - padding.right}" y2="\${y}"
                stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4" />
              <text x="\${padding.left - 5}" y="\${y + 4}" fill="var(--text-secondary)"
                font-size="10" text-anchor="end">\${val}</text>
            \`;
          }).join('')}

          <!-- Line -->
          <path d="\${data.map((d, i) => {
            const x = padding.left + (d.timestamp - minTime) / (maxTime - minTime) * (width - padding.left - padding.right);
            const y = padding.top + (1 - (d.connections?.total || 0) / maxConn) * (height - padding.top - padding.bottom);
            return (i === 0 ? 'M' : 'L') + x + ',' + y;
          }).join(' ')}"
            fill="none" stroke="var(--accent)" stroke-width="2" />

          <!-- Area under line -->
          <path d="\${data.map((d, i) => {
            const x = padding.left + (d.timestamp - minTime) / (maxTime - minTime) * (width - padding.left - padding.right);
            const y = padding.top + (1 - (d.connections?.total || 0) / maxConn) * (height - padding.top - padding.bottom);
            return (i === 0 ? 'M' : 'L') + x + ',' + y;
          }).join(' ')} L\${width - padding.right},\${height - padding.bottom} L\${padding.left},\${height - padding.bottom} Z"
            fill="rgba(59, 130, 246, 0.1)" />
        </svg>
      \`;

      container.innerHTML = svg;
    }

    function drawFederationGraph() {
      const container = document.getElementById('federation-graph');
      if (!container) return;

      const topology = state.federation || state.metrics?.federation;
      if (!topology || !topology.nodes) {
        // Use metrics to create basic topology
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">No federation data</div>';
        return;
      }

      const nodes = topology.nodes || [];
      if (nodes.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-secondary);">No peers connected</div>';
        return;
      }

      const width = container.clientWidth;
      const height = 300;
      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) / 2 - 50;

      // Position nodes in a circle
      const html = nodes.map((node, i) => {
        const isLocal = node.isLocal;
        let x, y;

        if (isLocal) {
          x = centerX - 32;
          y = centerY - 32;
        } else {
          const angle = (i / (nodes.length - 1)) * Math.PI * 2 - Math.PI / 2;
          x = centerX + Math.cos(angle) * radius - 24;
          y = centerY + Math.sin(angle) * radius - 24;
        }

        const shortId = node.id.substring(0, 6);
        const statusClass = isLocal ? 'local' : node.status;

        return \`<div class="node \${statusClass}" style="left: \${x}px; top: \${y}px;" title="\${node.id}\\n\${node.region}">\${shortId}</div>\`;
      }).join('');

      container.innerHTML = html;
    }

    // Make dismissAlert available globally
    window.dismissAlert = dismissAlert;

    // Start
    init();
  </script>
</body>
</html>`;
}
