/**
 * Security tab - NEW.
 * Fetches from /admin/api/security/* endpoints.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';
import { BarChart, MiniLine } from '../components/chart';

// ── Rate Limits (matches RateLimitViolationsData in types.ts) ──
interface RateLimitData {
  range?: string;
  summary?: {
    totalViolations: number;
    uniqueEndpoints: number;
    uniqueRegions: number;
    peakHourlyRate: number;
  };
  timeline?: Array<{ timestamp: number; count: number }>;
  topEndpoints?: Array<{ endpoint: string; count: number; percentage: number }>;
  regionalBreakdown?: Array<{ region: string; count: number; percentage: number }>;
  lastUpdated?: number;
  // Legacy shape fallback
  violations?: Array<{ timestamp: string; ip: string; count: number; endpoint: string }>;
  total?: number;
}

// ── Bad Clients (matches BadClientsData in types.ts) ──
interface BadClientEntry {
  sourceIp?: string;
  ip?: string;
  violationCount: number;
  lastSeen: number | string;
  firstSeen?: number;
  severity?: string;
  violations?: Record<string, number>;
  categories?: string[];
}

interface BadClientsData {
  range?: string;
  summary?: { totalBadClients: number; totalViolations: number; quarantinedCount: number };
  clients?: BadClientEntry[];
  total?: number;
  lastUpdated?: number;
}

// ── DDoS (matches DdosIndicatorsData in types.ts) ──
interface DdosData {
  range?: string;
  summary?: {
    totalSpikes: number;
    activeAlerts: number;
    highestMultiplier: number;
    currentConnectionRate: number;
  };
  connectionRateTimeline?: Array<{
    timestamp: number;
    rate: number;
    isAnomaly: boolean;
    normalRate: number;
  }>;
  activeAlerts?: Array<{
    id: number;
    timestamp: number;
    serverId: string;
    region: string;
    currentRate: number;
    normalRate: number;
    multiplier: number;
    severity: string;
  }>;
  lastUpdated?: number;
  // Legacy shape fallback
  indicators?: Array<{ timestamp: string; requestsPerSecond: number; uniqueIps: number; severity: string }>;
  currentRps?: number;
  threshold?: number;
}

// ── Pairing Abuse (matches PairingBruteForceData in types.ts) ──
interface PairingData {
  range?: string;
  summary?: {
    totalFailedAttempts: number;
    uniqueSessions: number;
    alertCount: number;
    threshold: number;
  };
  timeline?: Array<{ timestamp: number; failedAttempts: number; uniqueSessions: number }>;
  topOffenders?: Array<{
    sourceIp: string;
    failedAttempts: number;
    firstSeen: number;
    lastSeen: number;
  }>;
  lastUpdated?: number;
  // Legacy shape fallback
  abusers?: Array<{ ip: string; attempts: number; uniqueCodes: number; lastAttempt: string }>;
  total?: number;
}

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

  // Normalize values for summary cards
  const totalViolations = rateLimits?.summary?.totalViolations ?? rateLimits?.total ?? 0;
  const totalBadClients = badClients?.summary?.totalBadClients ?? badClients?.total ?? 0;
  const currentRps = ddos?.summary?.currentConnectionRate ?? ddos?.currentRps ?? 0;
  const totalPairingAbuse = pairing?.summary?.totalFailedAttempts ?? pairing?.total ?? 0;

  // Normalize DDoS data
  const ddosTimeline = ddos?.connectionRateTimeline || [];
  const ddosAlerts = ddos?.activeAlerts || [];
  const ddosThreshold = ddos?.threshold ?? 0;

  // Normalize rate limit data
  const rlTimeline = rateLimits?.timeline || [];
  const rlEndpoints = rateLimits?.topEndpoints || [];

  // Normalize bad clients
  const clientsList = badClients?.clients || [];

  // Normalize pairing data
  const offenders = pairing?.topOffenders || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Security Overview</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      <CardGrid>
        <Card title="Rate Limit Violations" value={totalViolations} valueColor="var(--warning)" />
        <Card title="Bad Clients" value={totalBadClients} valueColor="var(--danger)" />
        <Card title="Current Conn Rate" value={currentRps} />
        <Card title="Pairing Abuse" value={totalPairingAbuse} valueColor="var(--warning)" />
      </CardGrid>

      {/* DDoS / Connection Rate */}
      <div class="panel">
        <h3>Connection Rate & DDoS Indicators</h3>
        {ddosTimeline.length > 0 ? (
          <div>
            <MiniLine
              values={ddosTimeline.map(i => i.rate)}
              color={ddosAlerts.length > 0 ? '#ef4444' : '#3b82f6'}
              height={80}
            />
            {ddosAlerts.length > 0 && (
              <table class="data-table" style={{ marginTop: '1rem' }}>
                <thead><tr><th>Time</th><th>Server</th><th>Rate</th><th>Normal</th><th>Multiplier</th><th>Severity</th></tr></thead>
                <tbody>
                  {ddosAlerts.slice(0, 20).map((alert, i) => (
                    <tr key={i}>
                      <td>{new Date(alert.timestamp).toLocaleString()}</td>
                      <td style={{ fontSize: '0.8rem' }}>{alert.serverId?.slice(0, 12) || alert.region}</td>
                      <td>{alert.currentRate}</td>
                      <td>{alert.normalRate}</td>
                      <td><span style={{ color: alert.multiplier > 5 ? 'var(--danger)' : 'var(--warning)', fontWeight: 600 }}>{alert.multiplier.toFixed(1)}x</span></td>
                      <td><span class={`badge badge-${alert.severity === 'high' ? 'critical' : alert.severity === 'medium' ? 'degraded' : 'healthy'}`}>{alert.severity}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : ddos?.indicators && ddos.indicators.length > 0 ? (
          <div>
            <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Threshold: {ddosThreshold} rps | Current: <span style={{ color: currentRps > ddosThreshold ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{currentRps} rps</span>
            </div>
            <MiniLine
              values={ddos.indicators.map(i => i.requestsPerSecond)}
              color={currentRps > ddosThreshold ? '#ef4444' : '#3b82f6'}
              height={80}
            />
          </div>
        ) : (
          <div class="empty-state"><p>No DDoS indicators detected</p></div>
        )}
      </div>

      {/* Rate Limit Violations */}
      <div class="panel">
        <h3>Rate Limit Violations</h3>
        {rlTimeline.length > 0 ? (
          <div>
            <BarChart
              items={rlTimeline.slice(-12).map(b => ({
                label: new Date(b.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
                value: b.count,
                color: '#eab308',
              }))}
            />
            {rlEndpoints.length > 0 && (
              <table class="data-table" style={{ marginTop: '1rem' }}>
                <thead><tr><th>Endpoint</th><th>Count</th><th>Percentage</th></tr></thead>
                <tbody>
                  {rlEndpoints.map((ep, i) => (
                    <tr key={i}>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{ep.endpoint}</td>
                      <td>{ep.count}</td>
                      <td>{ep.percentage.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : rateLimits?.violations && rateLimits.violations.length > 0 ? (
          <div>
            <table class="data-table">
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
        {clientsList.length > 0 ? (
          <table class="data-table">
            <thead><tr><th>IP Address</th><th>Violations</th><th>Severity</th><th>Last Seen</th></tr></thead>
            <tbody>
              {clientsList.map((c, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{c.sourceIp || c.ip}</td>
                  <td><span style={{ color: c.violationCount > 100 ? 'var(--danger)' : c.violationCount > 10 ? 'var(--warning)' : 'var(--text-primary)', fontWeight: 600 }}>{c.violationCount}</span></td>
                  <td>{c.severity ? <span class={`badge badge-${c.severity === 'critical' ? 'critical' : c.severity === 'high' ? 'degraded' : 'healthy'}`}>{c.severity}</span> : (c.categories || []).map(cat => <span key={cat} class="badge badge-degraded" style={{ marginRight: '0.25rem' }}>{cat}</span>)}</td>
                  <td>{typeof c.lastSeen === 'number' ? new Date(c.lastSeen).toLocaleString() : new Date(c.lastSeen).toLocaleString()}</td>
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
        {offenders.length > 0 ? (
          <div>
            <BarChart
              items={offenders.slice(0, 10).map(a => ({
                label: a.sourceIp.slice(-8),
                value: a.failedAttempts,
                color: '#ef4444',
              }))}
            />
            <table class="data-table" style={{ marginTop: '1rem' }}>
              <thead><tr><th>IP</th><th>Failed Attempts</th><th>First Seen</th><th>Last Seen</th></tr></thead>
              <tbody>
                {offenders.map((a, i) => (
                  <tr key={i}>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{a.sourceIp}</td>
                    <td style={{ color: 'var(--danger)', fontWeight: 600 }}>{a.failedAttempts}</td>
                    <td>{new Date(a.firstSeen).toLocaleString()}</td>
                    <td>{new Date(a.lastSeen).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : pairing?.abusers && pairing.abusers.length > 0 ? (
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
