/**
 * Notifications tab - NEW.
 * Fetches from /admin/api/notifications/config, /admin/api/alerts/*, /admin/api/notifications.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';

// ── Types ──

interface NotificationConfig {
  emailAddresses: string[];
  emailSeverityFilter: string;
  webhookUrl: string;
  webhookFormat: string;
  webhookAuth: string;
  enabled: boolean;
}

interface AlertRule {
  id: number;
  name: string;
  metric: string;
  condition: string;
  threshold: number;
  severity: string;
  enabled: boolean;
  cooldownMinutes: number;
}
interface AlertRulesData { rules: AlertRule[] }

interface AlertHistory {
  id: number;
  ruleName: string;
  severity: string;
  message: string;
  firedAt: string;
  acknowledged: boolean;
}
interface AlertHistoryData { history: AlertHistory[] }

interface Notification {
  id: number;
  title: string;
  body: string;
  severity: string;
  createdAt: string;
  read: boolean;
}
interface NotificationsData { notifications: Notification[] }
interface UnreadData { count: number }

// ── Component ──

export function NotificationsTab() {
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [rules, setRules] = useState<AlertRulesData | null>(null);
  const [history, setHistory] = useState<AlertHistoryData | null>(null);
  const [notifications, setNotifications] = useState<NotificationsData | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Edit state for config
  const [editEmails, setEditEmails] = useState('');
  const [editSeverity, setEditSeverity] = useState('medium');
  const [editWebhookUrl, setEditWebhookUrl] = useState('');
  const [editWebhookFormat, setEditWebhookFormat] = useState('json');
  const [editWebhookAuth, setEditWebhookAuth] = useState('');

  const loadAll = useCallback(async () => {
    const [cfg, rl, hist, notifs, unr] = await Promise.all([
      api<NotificationConfig>('/admin/api/notifications/config'),
      api<AlertRulesData>('/admin/api/alerts/rules'),
      api<AlertHistoryData>('/admin/api/alerts/history'),
      api<NotificationsData>('/admin/api/notifications'),
      api<UnreadData>('/admin/api/notifications/unread-count'),
    ]);
    if (cfg.success && cfg.data) {
      setConfig(cfg.data);
      setEditEmails((cfg.data.emailAddresses || []).join(', '));
      setEditSeverity(cfg.data.emailSeverityFilter || 'medium');
      setEditWebhookUrl(cfg.data.webhookUrl || '');
      setEditWebhookFormat(cfg.data.webhookFormat || 'json');
      setEditWebhookAuth(cfg.data.webhookAuth || '');
    }
    if (rl.success && rl.data) setRules(rl.data);
    if (hist.success && hist.data) setHistory(hist.data);
    if (notifs.success && notifs.data) setNotifications(notifs.data);
    if (unr.success && unr.data) setUnread(unr.data.count);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(() => { if (!document.hidden) loadAll(); }, 30_000);
    return () => clearInterval(interval);
  }, [loadAll]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    const body = {
      emailAddresses: editEmails.split(',').map(e => e.trim()).filter(Boolean),
      emailSeverityFilter: editSeverity,
      webhookUrl: editWebhookUrl,
      webhookFormat: editWebhookFormat,
      webhookAuth: editWebhookAuth,
    };
    await api('/admin/api/notifications/config', { method: 'POST', body: JSON.stringify(body) });
    setSaving(false);
    await loadAll();
  }, [editEmails, editSeverity, editWebhookUrl, editWebhookFormat, editWebhookAuth, loadAll]);

  const testNotification = useCallback(async () => {
    setTestResult(null);
    const res = await api<{ message: string }>('/admin/api/notifications/test', { method: 'POST' });
    setTestResult(res.success ? 'Test notification sent successfully' : (res.error || 'Failed to send test'));
  }, []);

  const toggleRule = useCallback(async (ruleId: number) => {
    await api(`/admin/api/alerts/rules/${ruleId}/toggle`, { method: 'PATCH' });
    await loadAll();
  }, [loadAll]);

  const acknowledgeAlert = useCallback(async (historyId: number) => {
    await api(`/admin/api/alerts/history/${historyId}/acknowledge`, { method: 'POST' });
    await loadAll();
  }, [loadAll]);

  const markAllRead = useCallback(async () => {
    await api('/admin/api/notifications/read-all', { method: 'POST' });
    await loadAll();
  }, [loadAll]);

  if (loading) return <div class="loading"><div class="spinner" /></div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Notifications & Alerts</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      <CardGrid>
        <Card title="Unread Notifications" value={unread} valueColor={unread > 0 ? 'var(--warning)' : 'var(--success)'} />
        <Card title="Alert Rules" value={rules?.rules?.length ?? 0} />
        <Card title="Alerts Fired (recent)" value={history?.history?.length ?? 0} />
        <Card title="Config Status" value={config?.enabled ? 'Enabled' : 'Disabled'} valueColor={config?.enabled ? 'var(--success)' : 'var(--text-secondary)'} />
      </CardGrid>

      {/* Email Config Form */}
      <div class="panel">
        <h3>Email Configuration</h3>
        <div style={{ marginTop: '1rem' }}>
          <div class="form-group">
            <label>Email Addresses (comma-separated)</label>
            <input type="text" value={editEmails}
              onInput={(e) => setEditEmails((e.target as HTMLInputElement).value)}
              placeholder="admin@example.com, ops@example.com"
            />
          </div>
          <div class="form-group">
            <label>Minimum Severity</label>
            <select value={editSeverity} onChange={(e) => setEditSeverity((e.target as HTMLSelectElement).value)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
        </div>
      </div>

      {/* Webhook Config Form */}
      <div class="panel">
        <h3>Webhook Configuration</h3>
        <div style={{ marginTop: '1rem' }}>
          <div class="form-group">
            <label>Webhook URL</label>
            <input type="text" value={editWebhookUrl}
              onInput={(e) => setEditWebhookUrl((e.target as HTMLInputElement).value)}
              placeholder="https://hooks.slack.com/services/..."
            />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Format</label>
              <select value={editWebhookFormat} onChange={(e) => setEditWebhookFormat((e.target as HTMLSelectElement).value)}>
                <option value="json">JSON</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
              </select>
            </div>
            <div class="form-group">
              <label>Auth Header (optional)</label>
              <input type="text" value={editWebhookAuth}
                onInput={(e) => setEditWebhookAuth((e.target as HTMLInputElement).value)}
                placeholder="Bearer token..."
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
          <button onClick={saveConfig} disabled={saving}>{saving ? 'Saving...' : 'Save Configuration'}</button>
          <button class="secondary" onClick={testNotification}>Test Notification</button>
        </div>
        {testResult && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: testResult.includes('success') ? 'var(--success)' : 'var(--danger)' }}>
            {testResult}
          </p>
        )}
      </div>

      {/* Alert Rules Table */}
      <div class="panel">
        <h3>Alert Rules</h3>
        {rules && rules.rules && rules.rules.length > 0 ? (
          <table class="data-table">
            <thead><tr><th>Name</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Cooldown</th><th>Enabled</th></tr></thead>
            <tbody>
              {rules.rules.map(rule => (
                <tr key={rule.id}>
                  <td style={{ fontWeight: 600 }}>{rule.name}</td>
                  <td>{rule.metric}</td>
                  <td>{rule.condition} {rule.threshold}</td>
                  <td><span class={`severity-${rule.severity}`}>{rule.severity}</span></td>
                  <td>{rule.cooldownMinutes}m</td>
                  <td>
                    <label class="toggle">
                      <input type="checkbox" checked={rule.enabled} onChange={() => toggleRule(rule.id)} />
                      <span class="toggle-slider" />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="empty-state"><p>No alert rules configured</p></div>
        )}
      </div>

      {/* Alert History */}
      <div class="panel">
        <h3>Alert History</h3>
        {history && history.history && history.history.length > 0 ? (
          <table class="data-table">
            <thead><tr><th>Rule</th><th>Severity</th><th>Message</th><th>Fired</th><th>Status</th></tr></thead>
            <tbody>
              {history.history.map(h => (
                <tr key={h.id}>
                  <td style={{ fontWeight: 600 }}>{h.ruleName}</td>
                  <td><span class={`severity-${h.severity}`}>{h.severity}</span></td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.message}</td>
                  <td>{new Date(h.firedAt).toLocaleString()}</td>
                  <td>
                    {h.acknowledged
                      ? <span class="badge badge-healthy">ACK</span>
                      : <button style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }} onClick={() => acknowledgeAlert(h.id)}>Acknowledge</button>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="empty-state"><p>No alert history</p></div>
        )}
      </div>

      {/* Notification List */}
      <div class="panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3>Recent Notifications</h3>
          {unread > 0 && <button class="secondary" style={{ fontSize: '0.75rem' }} onClick={markAllRead}>Mark All Read</button>}
        </div>
        {notifications && notifications.notifications && notifications.notifications.length > 0 ? (
          <div>
            {notifications.notifications.map(n => (
              <div key={n.id} style={{
                padding: '0.75rem',
                borderBottom: '1px solid var(--border)',
                background: n.read ? 'transparent' : 'rgba(59,130,246,0.05)',
                borderLeft: n.read ? 'none' : '3px solid var(--accent)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.875rem' }}>
                    {!n.read && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', marginRight: '0.5rem' }} />}
                    {n.title}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{n.body}</div>
              </div>
            ))}
          </div>
        ) : (
          <div class="empty-state"><p>No notifications</p></div>
        )}
      </div>
    </div>
  );
}
