/**
 * Security tab - NEW.
 * Fetches from /admin/api/security/* endpoints.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';
import { BarChart, MiniLine } from '../components/chart';
import { DataTable, type Column } from '../components/table';

interface RateLimitViolation {
  timestamp: string;
  ip: string;
  count: number;
  endpoint: string;
}
interface RateLimitData { violations: RateLimitViolation[]; total: number }

interface BadClient {
  ip: string;
  violationCount: number;
  lastSeen: string;
  categories: string[];
}
interface BadClientsData { clients: BadClient[]; total: number }

interface DdosIndicator {
  timestamp: string;
  requestsPerSecond: number;
  uniqueIps: number;
  severity: string;
}
interface DdosData { indicators: DdosIndicator[]; currentRps: number; threshold: number }

interface PairingAbuse {
  ip: string;
  attempts: number;
  uniqueCodes: number;
  lastAttempt: string;
}
interface PairingData { abusers: PairingAbuse[]; total: number }

export function SecurityTab() {
  const [rateLimits, setRateLimits] = useState<RateLimitData | null>(null);
  const [badClients, setBadClients] = useState<BadClientsData | null>(null);
  const [ddos, setDdos] = useState<DdosData | null>(null);
  const [pairing, setPairing] = useState<PairingData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const [rl, bc, dd, pa] = await Promise.all([
      api<RateLimitData>('/admin/api/security/rate-limits'),
      api<BadClientsData>('/admin/api/security/bad-clients'),
      api<DdosData>('/admin/api/security/attacks'),
      api<PairingData>('/admin/api/security/pairing-abuse'),
    ]);
    if (rl.success && rl.data) setRateLimits(rl.data);
    if (bc.success && bc.data) setBadClients(bc.data);
    if (dd.success && dd.data) setDdos(dd.data);
    if (pa.success && pa.data) setPairing(pa.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(() => { if (!document.hidden) loadAll(); }, 30_000);
    return () => clearInterval(interval);
  }, [loadAll]);

  if (loading) return <div class="loading"><div class="spinner" /></div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Security Overview</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      <CardGrid>
        <Card title="Rate Limit Violations" value={rateLimits?.total ?? 0} valueColor="var(--warning)" />
        <Card title="Bad Clients" value={badClients?.total ?? 0} valueColor="var(--danger)" />
        <Card title="Current RPS" value={ddos?.currentRps ?? 0} />
        <Card title="Pairing Abusers" value={pairing?.total ?? 0} valueColor="var(--warning)" />
      </CardGrid>

      {/* DDoS Spike Indicators */}
      <div class="panel">
        <h3>DDoS Indicators</h3>
        {ddos && ddos.indicators.length > 0 ? (
          <div>
            <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Threshold: {ddos.threshold} rps | Current: <span style={{ color: ddos.currentRps > ddos.threshold ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{ddos.currentRps} rps</span>
            </div>
            <MiniLine
              values={ddos.indicators.map(i => i.requestsPerSecond)}
              color={ddos.currentRps > ddos.threshold ? '#ef4444' : '#3b82f6'}
              height={80}
            />
            <table class="data-table" style={{ marginTop: '1rem' }}>
              <thead><tr><th>Time</th><th>RPS</th><th>Unique IPs</th><th>Severity</th></tr></thead>
              <tbody>
                {ddos.indicators.slice(0, 20).map((ind, i) => (
                  <tr key={i}>
                    <td>{new Date(ind.timestamp).toLocaleString()}</td>
                    <td>{ind.requestsPerSecond}</td>
                    <td>{ind.uniqueIps}</td>
                    <td><span class={`badge badge-${ind.severity === 'high' ? 'critical' : ind.severity === 'medium' ? 'degraded' : 'healthy'}`}>{ind.severity}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty-state"><p>No DDoS indicators detected</p></div>
        )}
      </div>

      {/* Rate Limit Violations Timeline */}
      <div class="panel">
        <h3>Rate Limit Violations</h3>
        {rateLimits && rateLimits.violations.length > 0 ? (
          <div>
            <BarChart
              items={aggregateByHour(rateLimits.violations).map(b => ({
                label: b.label,
                value: b.count,
                color: '#eab308',
              }))}
            />
            <table class="data-table" style={{ marginTop: '1rem' }}>
              <thead><tr><th>Time</th><th>IP</th><th>Count</th><th>Endpoint</th></tr></thead>
              <tbody>
                {rateLimits.violations.slice(0, 25).map((v, i) => (
                  <tr key={i}>
                    <td>{new Date(v.timestamp).toLocaleString()}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{v.ip}</td>
                    <td>{v.count}</td>
                    <td>{v.endpoint}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty-state"><p>No rate limit violations in the current window</p></div>
        )}
      </div>

      {/* Bad Clients */}
      <div class="panel">
        <h3>Bad Clients</h3>
        {badClients && badClients.clients.length > 0 ? (
          <table class="data-table">
            <thead><tr><th>IP Address</th><th>Violations</th><th>Categories</th><th>Last Seen</th></tr></thead>
            <tbody>
              {badClients.clients.map((c, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{c.ip}</td>
                  <td><span style={{ color: c.violationCount > 100 ? 'var(--danger)' : c.violationCount > 10 ? 'var(--warning)' : 'var(--text-primary)', fontWeight: 600 }}>{c.violationCount}</span></td>
                  <td>{c.categories.map(cat => <span key={cat} class={`badge badge-${cat === 'rate_limit' ? 'degraded' : 'critical'}`} style={{ marginRight: '0.25rem' }}>{cat}</span>)}</td>
                  <td>{new Date(c.lastSeen).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="empty-state"><p>No bad clients flagged</p></div>
        )}
      </div>

      {/* Pairing Brute Force */}
      <div class="panel">
        <h3>Pairing Brute Force Attempts</h3>
        {pairing && pairing.abusers.length > 0 ? (
          <div>
            <BarChart
              items={pairing.abusers.slice(0, 10).map(a => ({
                label: a.ip.slice(-8),
                value: a.attempts,
                color: '#ef4444',
              }))}
            />
            <table class="data-table" style={{ marginTop: '1rem' }}>
              <thead><tr><th>IP</th><th>Attempts</th><th>Unique Codes</th><th>Last Attempt</th></tr></thead>
              <tbody>
                {pairing.abusers.map((a, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{a.ip}</td>
                    <td style={{ color: 'var(--danger)', fontWeight: 600 }}>{a.attempts}</td>
                    <td>{a.uniqueCodes}</td>
                    <td>{new Date(a.lastAttempt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty-state"><p>No pairing brute force attempts detected</p></div>
        )}
      </div>
    </div>
  );
}

function aggregateByHour(violations: RateLimitViolation[]): Array<{ label: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const v of violations) {
    const d = new Date(v.timestamp);
    const label = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    buckets.set(label, (buckets.get(label) || 0) + v.count);
  }
  return Array.from(buckets.entries())
    .map(([label, count]) => ({ label, count }))
    .slice(-12);
}
