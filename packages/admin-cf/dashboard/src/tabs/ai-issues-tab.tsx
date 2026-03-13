/**
 * AI Issues tab - NEW.
 * Fetches from /admin/api/issues, /admin/api/ai/costs.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';

interface Issue {
  id: number;
  severity: string;
  component: string;
  title: string;
  status: string;
  githubUrl: string | null;
  createdAt: string;
  analysis: string | null;
  acknowledged: boolean;
}

interface IssuesData {
  issues: Issue[];
  total: number;
}

interface IssueDetail {
  id: number;
  severity: string;
  component: string;
  title: string;
  status: string;
  githubUrl: string | null;
  createdAt: string;
  analysis: string;
  rawLogs: string;
  acknowledged: boolean;
}

interface AiCosts {
  totalTokensUsed: number;
  totalRuns: number;
  estimatedCostUsd: number;
  byDay: Array<{ date: string; tokens: number; runs: number; cost: number }>;
}

export function AiIssuesTab() {
  const [issues, setIssues] = useState<IssuesData | null>(null);
  const [costs, setCosts] = useState<AiCosts | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const [iss, co] = await Promise.all([
      api<IssuesData>('/admin/api/issues'),
      api<AiCosts>('/admin/api/ai/costs'),
    ]);
    if (iss.success && iss.data) setIssues(iss.data);
    if (co.success && co.data) setCosts(co.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(() => { if (!document.hidden) loadAll(); }, 30_000);
    return () => clearInterval(interval);
  }, [loadAll]);

  const toggleExpand = useCallback(async (issueId: number) => {
    if (expanded === issueId) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setExpanded(issueId);
    const res = await api<IssueDetail>(`/admin/api/issues/${issueId}`);
    if (res.success && res.data) setDetail(res.data);
  }, [expanded]);

  const acknowledgeIssue = useCallback(async (issueId: number) => {
    await api(`/admin/api/issues/${issueId}/acknowledge`, { method: 'POST' });
    await loadAll();
  }, [loadAll]);

  if (loading) return <div class="loading"><div class="spinner" /></div>;

  const severityColor = (sev: string) => {
    switch (sev) { case 'critical': return 'var(--danger)'; case 'high': return '#f97316'; case 'medium': return 'var(--warning)'; default: return 'var(--text-secondary)'; }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>AI Issues</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      {/* Cost Monitoring */}
      {costs && (
        <CardGrid>
          <Card title="Total Tokens Used" value={(costs.totalTokensUsed ?? 0).toLocaleString()} />
          <Card title="Total Runs" value={costs.totalRuns ?? 0} />
          <Card title="Estimated Cost" value={`$${(costs.estimatedCostUsd ?? 0).toFixed(4)}`} valueColor="var(--warning)" />
          <Card title="Total Issues" value={issues?.total ?? 0} />
        </CardGrid>
      )}

      {/* Cost by Day */}
      {costs && costs.byDay && costs.byDay.length > 0 && (
        <div class="panel">
          <h3>Cost by Day</h3>
          <table class="data-table">
            <thead><tr><th>Date</th><th>Tokens</th><th>Runs</th><th>Est. Cost</th></tr></thead>
            <tbody>
              {costs.byDay.map(d => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{d.tokens.toLocaleString()}</td>
                  <td>{d.runs}</td>
                  <td>${d.cost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Issues Table */}
      <div class="panel">
        <h3>Issues ({issues?.total ?? 0})</h3>
        {issues && issues.issues && issues.issues.length > 0 ? (
          <div>
            {issues.issues.map(issue => (
              <div key={issue.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 0', cursor: 'pointer' }}
                  onClick={() => toggleExpand(issue.id)}
                >
                  <span style={{ color: severityColor(issue.severity), fontWeight: 700, minWidth: 60, fontSize: '0.8rem', textTransform: 'uppercase' }}>
                    {issue.severity}
                  </span>
                  <span class={`badge badge-${issue.component === 'network' ? 'network' : issue.component === 'crash' ? 'crash' : 'other'}`}>
                    {issue.component}
                  </span>
                  <span style={{ flex: 1, fontSize: '0.875rem' }}>{issue.title}</span>
                  <span class={`badge ${issue.status === 'open' ? 'badge-degraded' : issue.status === 'resolved' ? 'badge-healthy' : 'badge-other'}`}>
                    {issue.status}
                  </span>
                  {issue.githubUrl && (
                    <a
                      href={issue.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ fontSize: '0.75rem', color: 'var(--accent)', textDecoration: 'underline' }}
                    >
                      GitHub
                    </a>
                  )}
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                    {new Date(issue.createdAt).toLocaleDateString()}
                  </span>
                  {!issue.acknowledged && (
                    <button
                      style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}
                      onClick={(e) => { e.stopPropagation(); acknowledgeIssue(issue.id); }}
                    >
                      ACK
                    </button>
                  )}
                </div>

                {/* Expanded detail */}
                {expanded === issue.id && detail && (
                  <div style={{ padding: '0 0 1rem 1rem', fontSize: '0.85rem' }}>
                    <div style={{ background: 'var(--bg-primary)', padding: '1rem', borderRadius: '0.5rem', whiteSpace: 'pre-wrap', fontFamily: 'monospace', maxHeight: 400, overflowY: 'auto' }}>
                      {detail.analysis || 'No analysis available'}
                    </div>
                    {detail.rawLogs && (
                      <details style={{ marginTop: '0.75rem' }}>
                        <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>Raw Logs</summary>
                        <pre style={{ background: 'var(--bg-primary)', padding: '0.75rem', borderRadius: '0.5rem', fontSize: '0.75rem', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                          {detail.rawLogs}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div class="empty-state"><p>No AI-generated issues</p></div>
        )}
      </div>
    </div>
  );
}
