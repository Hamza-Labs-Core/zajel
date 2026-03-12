/**
 * Main App component with hash-based tab routing and auth state.
 *
 * Each tab gets its own URL via hash routing (e.g., #/servers, #/errors).
 * This lets users bookmark tabs and use browser back/forward navigation.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, getToken, setToken } from './api';
import { ServersTab } from './tabs/servers-tab';
import { UsersTab } from './tabs/users-tab';
import { ErrorsTab } from './tabs/errors-tab';
import { MetricsTab } from './tabs/metrics-tab';
import { ActiveClientsTab } from './tabs/active-clients-tab';
import { ServerHealthTab } from './tabs/server-health-tab';
import { SecurityTab } from './tabs/security-tab';
import { AiIssuesTab } from './tabs/ai-issues-tab';
import { NotificationsTab } from './tabs/notifications-tab';

interface User {
  userId: string;
  username: string;
  role: string;
}

const TABS = [
  { id: 'servers', label: 'Servers' },
  { id: 'users', label: 'Users' },
  { id: 'errors', label: 'Errors' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'clients', label: 'Active Clients' },
  { id: 'health', label: 'Server Health' },
  { id: 'security', label: 'Security' },
  { id: 'ai-issues', label: 'AI Issues' },
  { id: 'notifications', label: 'Notifications' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const VALID_TABS = new Set<string>(TABS.map(t => t.id));

function getTabFromHash(): TabId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return VALID_TABS.has(hash) ? (hash as TabId) : 'servers';
}

function setHashRoute(tab: TabId) {
  window.location.hash = `#/${tab}`;
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>(getTabFromHash);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sync tab state with hash changes (browser back/forward)
  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigateTab = useCallback((tab: TabId) => {
    setHashRoute(tab);
    setActiveTab(tab);
  }, []);

  // Verify existing token on mount
  useEffect(() => {
    (async () => {
      const token = getToken();
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const res = await api<User>('/admin/api/auth/verify');
        if (res.success && res.data) {
          setUser(res.data);

          // Handle redirect from VPS dashboard
          const params = new URLSearchParams(window.location.search);
          const redirectUrl = params.get('redirect');
          if (redirectUrl) {
            try {
              const url = new URL(redirectUrl);
              if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
                const codeRes = await api<{ code: string }>('/admin/api/auth/code', { method: 'POST' });
                if (codeRes.success && codeRes.data?.code) {
                  url.searchParams.set('code', codeRes.data.code);
                  window.location.href = url.toString();
                  return;
                }
              }
            } catch { /* invalid URL */ }
          }
        } else {
          setToken(null);
        }
      } catch {
        setToken(null);
      }
      setLoading(false);
    })();
  }, []);

  const handleLogin = useCallback(async (username: string, password: string) => {
    setError(null);
    try {
      const res = await api<{ token: string; user: User }>('/admin/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (res.success && res.data) {
        setToken(res.data.token);
        setUser(res.data.user);

        // Handle redirect
        const params = new URLSearchParams(window.location.search);
        const redirectUrl = params.get('redirect');
        if (redirectUrl) {
          try {
            const url = new URL(redirectUrl);
            if (url.protocol === 'https:' && url.pathname.startsWith('/admin')) {
              const codeRes = await api<{ code: string }>('/admin/api/auth/code', { method: 'POST' });
              if (codeRes.success && codeRes.data?.code) {
                url.searchParams.set('code', codeRes.data.code);
                window.location.href = url.toString();
                return;
              }
            }
          } catch { /* invalid URL */ }
        }
      } else {
        setError(res.error || 'Login failed');
      }
    } catch {
      setError('Login failed');
    }
  }, []);

  const handleLogout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  if (loading) {
    return (
      <div class="loading">
        <div class="spinner" />
        <p style={{ marginTop: '1rem' }}>Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginForm onLogin={handleLogin} error={error} />;
  }

  return (
    <div class="container">
      <header>
        <h1>Zajel Admin Dashboard</h1>
        <div class="user-info">
          <span class="user-badge">{user.username} ({user.role})</span>
          <button onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <div class="tabs">
        {TABS.map(tab => (
          <a
            key={tab.id}
            href={`#/${tab.id}`}
            class={`tab${activeTab === tab.id ? ' active' : ''}`}
            onClick={(e) => { e.preventDefault(); navigateTab(tab.id); }}
          >
            {tab.label}
          </a>
        ))}
      </div>

      <TabContent tab={activeTab} user={user} />
    </div>
  );
}

// ── Login Form ──

function LoginForm({ onLogin, error }: { onLogin: (u: string, p: string) => void; error: string | null }) {
  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const username = (form.elements.namedItem('username') as HTMLInputElement).value;
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    onLogin(username, password);
  };

  return (
    <div class="login-container">
      <h2>Zajel Admin</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" name="username" required autocomplete="username" />
        </div>
        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" />
        </div>
        <button type="submit">Login</button>
        {error && <p class="error-message">{error}</p>}
      </form>
    </div>
  );
}

// ── Tab Content Router ──

function TabContent({ tab, user }: { tab: TabId; user: User }) {
  switch (tab) {
    case 'servers': return <ServersTab />;
    case 'users': return <UsersTab user={user} />;
    case 'errors': return <ErrorsTab />;
    case 'metrics': return <MetricsTab />;
    case 'clients': return <ActiveClientsTab />;
    case 'health': return <ServerHealthTab />;
    case 'security': return <SecurityTab />;
    case 'ai-issues': return <AiIssuesTab />;
    case 'notifications': return <NotificationsTab />;
    default: return null;
  }
}
