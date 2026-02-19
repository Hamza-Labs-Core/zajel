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

// Re-export Durable Object
export { AdminUsersDO } from './admin-users-do.js';

// Rate limiting state (per worker instance)
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 login attempts per minute

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers for dashboard
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };

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
 * Serve the dashboard HTML (inline for simplicity)
 */
function serveDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zajel Admin Dashboard</title>
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
      loading: true,
      error: null,
    };

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
              await loadData();
            }
          }
        } catch (e) {
          localStorage.removeItem('zajel_admin_token');
        }
      }
      state.loading = false;
      render();
    }

    // Load data based on active tab
    async function loadData() {
      if (!state.token) return;

      if (state.activeTab === 'servers') {
        await loadServers();
      } else if (state.activeTab === 'users') {
        await loadUsers();
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
            // Redirect back to VPS with token
            const url = new URL(redirectUrl);
            url.searchParams.set('token', state.token);
            window.location.href = url.toString();
            return;
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
    function openVpsDashboard(server) {
      // Convert WS endpoint to HTTP base URL (strip any path component)
      const wsUrl = new URL(server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'));
      const baseUrl = wsUrl.protocol + '//' + wsUrl.host;
      // Pass token in URL for initial auth
      window.open(baseUrl + '/admin/?token=' + encodeURIComponent(state.token), '_blank');
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
            \${state.error ? '<p class="error-message">' + state.error + '</p>' : ''}
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
              <span class="user-badge">\${state.user.username} (\${state.user.role})</span>
              <button id="logout-btn">Logout</button>
            </div>
          </header>

          <div class="tabs">
            <div class="tab \${state.activeTab === 'servers' ? 'active' : ''}" data-tab="servers">Servers</div>
            <div class="tab \${state.activeTab === 'users' ? 'active' : ''}" data-tab="users">Users</div>
          </div>

          \${state.activeTab === 'servers' ? renderServers() : renderUsers()}
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
            <div class="server-card" data-endpoint="\${server.endpoint}">
              <div class="server-header">
                <span class="server-name">\${server.id}</span>
                <span class="status-badge status-\${server.status}">\${server.status.toUpperCase()}</span>
              </div>
              <div class="server-region">📍 \${server.region}</div>
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
            \${state.error ? '<p class="error-message">' + state.error + '</p>' : ''}
          </div>
        \` : ''}

        <div class="user-list">
          \${state.users.map(user => \`
            <div class="user-row">
              <div class="user-info-row">
                <span>\${user.username}</span>
                <span class="role-badge">\${user.role}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 1rem;">
                <span style="font-size: 0.75rem; color: var(--text-secondary)">
                  Last login: \${user.lastLogin ? new Date(user.lastLogin).toLocaleDateString() : 'Never'}
                </span>
                \${canManageUsers && user.id !== state.user.userId ? \`
                  <button class="danger delete-user-btn" data-user-id="\${user.id}">Delete</button>
                \` : ''}
              </div>
            </div>
          \`).join('')}
        </div>
      \`;
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
