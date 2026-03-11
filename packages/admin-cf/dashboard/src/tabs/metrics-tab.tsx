/**
 * Metrics tab - combines App Performance, Server Metrics, Network, and Federation.
 * Port of existing inline dashboard.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, formatMetricValue, formatUptime, fmtMs } from '../api';
import { Card, CardGrid } from '../components/card';
import { LineChart, Gauge, DonutChart, AreaChart } from '../components/chart';

// ── Types ──

interface AppMetricCurrent { p50: number | null; p95: number | null; p99: number | null }
interface AppMetric {
  metricName: string;
  unit: string;
  current: AppMetricCurrent;
  dataPoints: Array<{ timeBucket: string; p50: number | null; p95: number | null; p99: number | null }>;
}
interface AppMetricsData { metrics: AppMetric[]; filters: { platforms: string[]; versions: string[] } }

interface ServerMetricEntry {
  serverId: string;
  region: string;
  status: string;
  lastSeen: number;
  metrics: {
    cpuPercent: number; memoryMb: number; connectionsTotal: number; connectionsRelay: number;
    messageRatePerMinute: number; federationAliveMembers: number; federationTotalMembers: number;
    uptimeSeconds: number; entropyActiveCodes: number;
  };
}
interface ServerMetricsData { servers: ServerMetricEntry[]; aggregate: Record<string, number> }
interface ServerDetailData {
  serverId: string; region: string;
  history: Array<{ timestamp: number; cpuPercent: number; memoryMb: number; connectionsTotal: number; messageRatePerMinute: number }>;
}

interface NetworkMetricsData {
  current?: { signalingSuccessRate: number | null; signalingAttempts: number; webrtcSuccessRate: number | null; webrtcAttempts: number; avgLatencyMs: number | null };
  distribution?: { relayCount: number; directP2pCount: number };
  filters?: { platforms: string[]; versions: string[] };
  platformBreakdown?: Array<{ platform: string; signalingSuccessRate: number | null; webrtcSuccessRate: number | null; avgLatencyMs: number | null; sampleCount: number }>;
  trends?: { latency: Array<{ avgLatencyMs: number | null }> };
  metrics?: Array<Record<string, unknown>>;
}

interface FederationData {
  health?: string;
  summary?: { aliveNodes: number; suspectNodes: number; failedNodes: number; totalNodes: number; regions: Record<string, number> };
  gossipLatency?: { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; pingCount: number };
  syncCompleteness?: number;
  perServer?: Array<{ serverId: string; region: string; aliveMembers: number; totalMembers: number; gossipRttP50Ms: number | null; gossipRttP95Ms: number | null; lastSeen: string }>;
  availabilityHistory?: Array<{ serverId: string; timeline: Array<{ timestamp: number; status: string }> }>;
  current?: Array<Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
}

// ── Helpers ──

function classifyStartup(p95: number | null) { return p95 === null ? 'green' : p95 < 3000 ? 'green' : p95 <= 5000 ? 'yellow' : 'red'; }
function classifyFps(p50: number | null) { return p50 === null ? 'green' : p50 > 55 ? 'green' : p50 >= 45 ? 'yellow' : 'red'; }
function classifyMem(p95: number | null) { return p95 === null ? 'green' : p95 < 200 ? 'green' : p95 <= 400 ? 'yellow' : 'red'; }

function thresholdFor(name: string, cur: AppMetricCurrent) {
  const level = name === 'startup_time' ? classifyStartup(cur.p95) : name === 'frame_rate' ? classifyFps(cur.p50) : name === 'memory' ? classifyMem(cur.p95) : 'green';
  return { cls: `badge badge-${level === 'green' ? 'healthy' : level === 'yellow' ? 'degraded' : 'critical'}`, label: level === 'green' ? 'Healthy' : level === 'yellow' ? 'Degraded' : 'Critical' };
}

function metricLabel(name: string) {
  switch (name) { case 'startup_time': return 'Startup Time'; case 'frame_rate': return 'Frame Rate'; case 'memory': return 'Memory Usage'; default: return name; }
}

// ── Component ──

export function MetricsTab() {
  // App metrics state
  const [appData, setAppData] = useState<AppMetricsData | null>(null);
  const [appRange, setAppRange] = useState('24h');
  const [appPlatform, setAppPlatform] = useState('');
  const [appVersion, setAppVersion] = useState('');

  // Server metrics state
  const [serverData, setServerData] = useState<ServerMetricsData | null>(null);
  const [serverDetail, setServerDetail] = useState<ServerDetailData | null>(null);
  const [smRange, setSmRange] = useState('1h');

  // Network metrics state
  const [netData, setNetData] = useState<NetworkMetricsData | null>(null);
  const [netRange, setNetRange] = useState('24h');

  // Federation state
  const [fedData, setFedData] = useState<FederationData | null>(null);
  const [fedRange, setFedRange] = useState('1h');

  // Loaders
  const loadApp = useCallback(async () => {
    let url = `/admin/api/metrics/app?range=${encodeURIComponent(appRange)}`;
    if (appPlatform) url += `&platform=${encodeURIComponent(appPlatform)}`;
    if (appVersion) url += `&version=${encodeURIComponent(appVersion)}`;
    const res = await api<AppMetricsData>(url);
    if (res.success && res.data) setAppData(res.data);
  }, [appRange, appPlatform, appVersion]);

  const loadServers = useCallback(async () => {
    const res = await api<ServerMetricsData>('/admin/api/metrics/server');
    if (res.success && res.data) setServerData(res.data);
  }, []);

  const loadNet = useCallback(async () => {
    const res = await api<NetworkMetricsData>(`/admin/api/metrics/network?range=${encodeURIComponent(netRange)}`);
    if (res.success && res.data) setNetData(res.data);
  }, [netRange]);

  const loadFed = useCallback(async () => {
    const res = await api<FederationData>(`/admin/api/metrics/federation?range=${encodeURIComponent(fedRange)}`);
    if (res.success && res.data) setFedData(res.data);
  }, [fedRange]);

  const loadDetail = useCallback(async (serverId: string) => {
    const res = await api<ServerDetailData>(`/admin/api/metrics/server/${encodeURIComponent(serverId)}?range=${encodeURIComponent(smRange)}`);
    if (res.success && res.data) setServerDetail(res.data);
  }, [smRange]);

  useEffect(() => {
    loadApp(); loadServers(); loadNet(); loadFed();
    const i = setInterval(() => {
      if (!document.hidden) { loadApp(); loadServers(); loadNet(); loadFed(); }
    }, 30_000);
    return () => clearInterval(i);
  }, [loadApp, loadServers, loadNet, loadFed]);

  return (
    <div>
      <AppMetricsSection data={appData} range={appRange} setRange={setAppRange} platform={appPlatform} setPlatform={setAppPlatform} version={appVersion} setVersion={setAppVersion} />
      <ServerMetricsSection data={serverData} detail={serverDetail} loadDetail={loadDetail} onBack={() => setServerDetail(null)} smRange={smRange} setSmRange={setSmRange} />
      <NetworkSection data={netData} range={netRange} setRange={setNetRange} />
      <FederationSection data={fedData} range={fedRange} setRange={setFedRange} />
      <div style={{ marginTop: '2rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Auto-refreshes every 30 seconds</div>
    </div>
  );
}

// ── App Metrics Section ──

function AppMetricsSection({ data, range, setRange, platform, setPlatform, version, setVersion }: {
  data: AppMetricsData | null; range: string; setRange: (v: string) => void;
  platform: string; setPlatform: (v: string) => void; version: string; setVersion: (v: string) => void;
}) {
  if (!data) return <div class="loading"><div class="spinner" /></div>;
  const filters = data.filters || { platforms: [], versions: [] };
  const metrics = data.metrics || [];

  return (
    <div>
      <div class="filter-bar">
        <div class="filter-group">
          <label>Time Range</label>
          <select value={range} onChange={(e) => setRange((e.target as HTMLSelectElement).value)}>
            {['1h', '6h', '24h', '7d'].map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div class="filter-group">
          <label>Platform</label>
          <select value={platform} onChange={(e) => setPlatform((e.target as HTMLSelectElement).value)}>
            <option value="">All Platforms</option>
            {filters.platforms.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div class="filter-group">
          <label>Version</label>
          <select value={version} onChange={(e) => setVersion((e.target as HTMLSelectElement).value)}>
            <option value="">All Versions</option>
            {filters.versions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
        {metrics.map(m => {
          const th = thresholdFor(m.metricName, m.current);
          return (
            <div key={m.metricName} class="panel">
              <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                {metricLabel(m.metricName)}
                <span class={th.cls} style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderRadius: '1rem' }}>{th.label}</span>
              </h3>
              <div style={{ display: 'flex', justifyContent: 'space-around', margin: '0.75rem 0' }}>
                <div style={{ textAlign: 'center' }}><span style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block' }}>p50</span><span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#3b82f6' }}>{formatMetricValue(m.current.p50, m.unit)}</span></div>
                <div style={{ textAlign: 'center' }}><span style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block' }}>p95</span><span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#eab308' }}>{formatMetricValue(m.current.p95, m.unit)}</span></div>
                <div style={{ textAlign: 'center' }}><span style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'block' }}>p99</span><span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#ef4444' }}>{formatMetricValue(m.current.p99, m.unit)}</span></div>
              </div>
            </div>
          );
        })}
      </div>

      {metrics.map(m => (
        <div key={m.metricName} class="panel">
          <h3>{metricLabel(m.metricName)} ({m.unit})</h3>
          <LineChart dataPoints={m.dataPoints} unit={m.unit} />
        </div>
      ))}

      {(metrics.length === 0 || metrics.every(m => m.dataPoints.length === 0)) && (
        <div class="empty-state">
          <p style={{ fontSize: '1.25rem' }}>No performance data available</p>
          <p>Performance metrics will appear here once the diagnostics worker begins receiving data from app clients.</p>
        </div>
      )}
    </div>
  );
}

// ── Server Metrics Section ──

function ServerMetricsSection({ data, detail, loadDetail, onBack, smRange, setSmRange }: {
  data: ServerMetricsData | null; detail: ServerDetailData | null;
  loadDetail: (id: string) => void; onBack: () => void;
  smRange: string; setSmRange: (v: string) => void;
}) {
  if (detail) {
    return (
      <div style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3>Server: {detail.serverId} ({detail.region})</h3>
          <button class="secondary" onClick={onBack}>Back to Server List</button>
        </div>
        <div class="range-selector" style={{ marginBottom: '1rem' }}>
          {['1h', '6h', '24h', '7d'].map(r => (
            <button key={r} class={`range-btn${smRange === r ? ' active' : ''}`}
              onClick={() => { setSmRange(r); loadDetail(detail.serverId); }}>{r}</button>
          ))}
        </div>
        {detail.history.length === 0 ? (
          <div class="empty-state"><p>No historical data for this time range.</p></div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div class="panel"><h3>CPU Usage (%)</h3><AreaChart data={detail.history.map(h => ({ timestamp: h.timestamp, value: h.cpuPercent }))} color="#ef4444" maxForced={100} /></div>
            <div class="panel"><h3>Memory (MB)</h3><AreaChart data={detail.history.map(h => ({ timestamp: h.timestamp, value: h.memoryMb }))} color="#3b82f6" /></div>
            <div class="panel"><h3>Connections</h3><AreaChart data={detail.history.map(h => ({ timestamp: h.timestamp, value: h.connectionsTotal }))} color="#22c55e" /></div>
            <div class="panel"><h3>Message Rate (msgs/min)</h3><AreaChart data={detail.history.map(h => ({ timestamp: h.timestamp, value: h.messageRatePerMinute }))} color="#eab308" /></div>
          </div>
        )}
      </div>
    );
  }

  if (!data) return <div class="loading"><div class="spinner" /></div>;
  const agg = data.aggregate || {};
  const servers = data.servers || [];

  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 600 }}>Server Metrics</h3>
      <CardGrid>
        <Card title="Total Servers" value={agg['totalServers'] || 0} />
        <Card title="Healthy" value={agg['healthyServers'] || 0} valueColor="var(--success)" />
        <Card title="Degraded" value={agg['degradedServers'] || 0} valueColor="var(--warning)" />
        <Card title="Offline" value={agg['offlineServers'] || 0} valueColor="var(--danger)" />
        <Card title="Total Connections" value={agg['totalConnections'] || 0} />
        <Card title="Msgs/min" value={agg['totalThroughput'] || 0} />
      </CardGrid>
      {servers.length === 0 ? (
        <div class="empty-state"><p>No server metrics data available yet.</p><p>Configure ZAJEL_DIAGNOSTICS_URL and DIAGNOSTICS_PUSH_SECRET on VPS servers.</p></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: '1rem' }}>
          {servers.map(s => {
            const m = s.metrics || {} as ServerMetricEntry['metrics'];
            const cpuPct = m.cpuPercent || 0;
            const memMb = m.memoryMb || 0;
            const isStale = (Date.now() - s.lastSeen) > 300_000;
            const cpuColor = cpuPct > 90 ? 'var(--danger)' : cpuPct > 70 ? 'var(--warning)' : 'var(--success)';
            const connColor = (m.connectionsTotal || 0) > 5000 ? 'var(--danger)' : (m.connectionsTotal || 0) > 1000 ? 'var(--warning)' : 'var(--success)';
            return (
              <div key={s.serverId} class="server-card" style={{ borderWidth: 2, borderColor: s.status === 'healthy' ? 'var(--success)' : s.status === 'degraded' ? 'var(--warning)' : 'var(--danger)' }}
                onClick={() => loadDetail(s.serverId)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <span style={{ fontWeight: 600 }}>{s.serverId}</span>
                  <span class={`badge badge-${s.status}`}>{(s.status || 'unknown').toUpperCase()}</span>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                  {s.region}{isStale && <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: 'var(--danger)', background: 'rgba(239,68,68,0.15)', padding: '0.15rem 0.5rem', borderRadius: '0.25rem' }}>STALE</span>}
                </div>
                <div style={{ marginBottom: '0.75rem' }}>
                  <div class="metrics-bar-row"><div class="metrics-bar-label"><span>CPU</span><span>{cpuPct.toFixed(1)}%</span></div><div class="metrics-bar-track"><div class="metrics-bar-fill" style={{ width: `${Math.min(100, cpuPct)}%`, background: cpuColor }} /></div></div>
                  <div class="metrics-bar-row"><div class="metrics-bar-label"><span>Memory</span><span>{memMb.toFixed(0)} MB</span></div><div class="metrics-bar-track"><div class="metrics-bar-fill" style={{ width: `${Math.min(100, (memMb / 512) * 100)}%`, background: 'var(--accent)' }} /></div></div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-secondary)' }}>Connections</span><span style={{ color: connColor }}>{m.connectionsTotal || 0}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-secondary)' }}>Relay</span><span>{m.connectionsRelay || 0}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-secondary)' }}>Msgs/min</span><span>{m.messageRatePerMinute || 0}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-secondary)' }}>Federation</span><span>{m.federationAliveMembers || 0}/{m.federationTotalMembers || 0}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-secondary)' }}>Uptime</span><span>{formatUptime(m.uptimeSeconds || 0)}</span></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--text-secondary)' }}>Active Codes</span><span>{m.entropyActiveCodes || 0}</span></div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Network Section ──

function NetworkSection({ data, range, setRange }: { data: NetworkMetricsData | null; range: string; setRange: (v: string) => void }) {
  if (!data) return <div style={{ marginTop: '2rem' }}><h3>Network Success Rates</h3><div class="loading"><div class="spinner" /></div></div>;

  // Normalize data if API returns raw metrics
  let current = data.current;
  let distribution = data.distribution || { relayCount: 0, directP2pCount: 0 };
  if (!current && data.metrics) {
    let sigS = 0, sigF = 0, wS = 0, wF = 0, relay = 0, direct = 0, latSum = 0, latN = 0;
    (data.metrics as Array<Record<string, number>>).forEach(m => {
      sigS += (m['signaling_success_count'] || 0);
      sigF += (m['signaling_failure_count'] || 0);
      wS += (m['webrtc_success_count'] || 0);
      wF += (m['webrtc_failure_count'] || 0);
      relay += (m['relay_usage_count'] || 0);
      direct += (m['direct_p2p_count'] || 0);
      if (m['avg_latency_ms'] != null) { latSum += m['avg_latency_ms']; latN++; }
    });
    const sigA = sigS + sigF, wA = wS + wF;
    current = { signalingSuccessRate: sigA > 0 ? (sigS / sigA) * 100 : null, signalingAttempts: sigA, webrtcSuccessRate: wA > 0 ? (wS / wA) * 100 : null, webrtcAttempts: wA, avgLatencyMs: latN > 0 ? latSum / latN : null };
    distribution = { relayCount: relay, directP2pCount: direct };
  }
  if (!current) return <div style={{ marginTop: '2rem' }}><h3>Network Success Rates</h3><div class="empty-state"><p>No network metrics collected yet</p></div></div>;

  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 600 }}>Network Success Rates</h3>
      <div class="range-selector" style={{ marginBottom: '1rem' }}>
        {['1h', '6h', '24h', '7d'].map(r => (
          <button key={r} class={`range-btn${range === r ? ' active' : ''}`} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <Gauge value={current.signalingSuccessRate} label={`${current.signalingAttempts} attempts`} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>Signaling</div>
        </div>
        <Gauge value={current.webrtcSuccessRate} label={`${current.webrtcAttempts} attempts`} />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>WebRTC</div>
        </div>
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--accent)' }}>{current.avgLatencyMs !== null ? current.avgLatencyMs.toFixed(1) + ' ms' : 'N/A'}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Avg Latency</div>
        </div>
      </div>
      <DonutChart
        segments={[
          { label: 'Direct P2P', value: distribution.directP2pCount, color: '#3b82f6' },
          { label: 'Relay', value: distribution.relayCount, color: '#f97316' },
        ]}
        centerValue={String(distribution.directP2pCount + distribution.relayCount)}
        centerLabel="total"
      />
      {data.platformBreakdown && data.platformBreakdown.length > 0 && (
        <div class="panel" style={{ marginTop: '1.5rem' }}>
          <h3>Platform Breakdown</h3>
          <table class="data-table">
            <thead><tr><th>Platform</th><th>Signaling Rate</th><th>WebRTC Rate</th><th>Avg Latency</th><th>Samples</th></tr></thead>
            <tbody>
              {data.platformBreakdown.map(p => (
                <tr key={p.platform}>
                  <td>{p.platform}</td>
                  <td>{p.signalingSuccessRate !== null ? p.signalingSuccessRate.toFixed(1) + '%' : 'N/A'}</td>
                  <td>{p.webrtcSuccessRate !== null ? p.webrtcSuccessRate.toFixed(1) + '%' : 'N/A'}</td>
                  <td>{p.avgLatencyMs !== null ? p.avgLatencyMs.toFixed(1) + ' ms' : 'N/A'}</td>
                  <td>{p.sampleCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Federation Section ──

function FederationSection({ data, range, setRange }: { data: FederationData | null; range: string; setRange: (v: string) => void }) {
  if (!data) return <div style={{ marginTop: '2rem' }}><h3>Federation Health</h3><div class="loading"><div class="spinner" /></div></div>;

  // Normalize from raw data if needed
  let health = data.health;
  let summary = data.summary;
  let gossipLatency = data.gossipLatency;
  let syncCompleteness = data.syncCompleteness;
  let perServer = data.perServer;

  if (!health && data.current) {
    const rows = data.current as Array<Record<string, number>>;
    if (rows.length === 0) return <div style={{ marginTop: '2rem' }}><h3>Federation Health</h3><div class="empty-state"><p>No federation data collected yet</p></div></div>;
    let totalAlive = 0, totalMembers = 0;
    const latencies: number[] = [];
    rows.forEach(r => {
      totalAlive += (r['alive_members'] || 0);
      totalMembers += (r['total_members'] || 0);
      if (r['gossip_latency_ms'] != null) latencies.push(r['gossip_latency_ms']);
    });
    latencies.sort((a, b) => a - b);
    const failed = totalMembers - totalAlive;
    health = failed === 0 ? 'healthy' : failed <= totalMembers * 0.5 ? 'degraded' : 'critical';
    summary = { aliveNodes: totalAlive, suspectNodes: 0, failedNodes: failed, totalNodes: totalMembers, regions: {} };
    gossipLatency = {
      p50Ms: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)]! : null,
      p95Ms: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)]! : null,
      p99Ms: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)]! : null,
      pingCount: latencies.length,
    };
    syncCompleteness = totalMembers > 0 ? Math.round((totalAlive / totalMembers) * 100) : 0;
    perServer = rows.map(r => ({
      serverId: String(r['server_id'] || ''), region: '', aliveMembers: r['alive_members'] || 0,
      totalMembers: r['total_members'] || 0, gossipRttP50Ms: r['gossip_latency_ms'] ?? null,
      gossipRttP95Ms: null, lastSeen: String(r['timestamp'] || ''),
    }));
  }

  if (!health || !summary || !gossipLatency) return null;

  const healthColor = health === 'healthy' ? 'var(--success)' : health === 'degraded' ? 'var(--warning)' : 'var(--danger)';
  const healthBg = health === 'healthy' ? 'rgba(34,197,94,0.15)' : health === 'degraded' ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)';
  const syncColor = (syncCompleteness || 0) >= 90 ? 'var(--success)' : (syncCompleteness || 0) >= 50 ? 'var(--warning)' : 'var(--danger)';

  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={{ marginBottom: '1rem', fontSize: '1rem', fontWeight: 600 }}>Federation Health</h3>
      <div class="range-selector" style={{ marginBottom: '1rem' }}>
        {['1h', '6h', '24h'].map(r => (
          <button key={r} class={`range-btn${range === r ? ' active' : ''}`} onClick={() => setRange(r)}>{r}</button>
        ))}
      </div>

      <div style={{ display: 'inline-block', padding: '0.5rem 1.5rem', borderRadius: '0.5rem', fontSize: '1.1rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: healthColor, background: healthBg }}>{health}</div>

      <div style={{ display: 'flex', gap: '1.5rem', margin: '1rem 0', flexWrap: 'wrap', fontSize: '0.9rem' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--success)', verticalAlign: 'middle' }} /> Alive: {summary.aliveNodes}</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--warning)', verticalAlign: 'middle' }} /> Suspect: {summary.suspectNodes}</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'var(--danger)', verticalAlign: 'middle' }} /> Failed: {summary.failedNodes}</span>
        <span>Total: {summary.totalNodes}</span>
      </div>

      <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>Gossip Latency</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: '1rem', margin: '1rem 0' }}>
        {([['p50', gossipLatency.p50Ms], ['p95', gossipLatency.p95Ms], ['p99', gossipLatency.p99Ms], ['Pings', gossipLatency.pingCount]] as [string, number | null][]).map(([label, val]) => (
          <div key={label} class="stat-card">
            <div class="stat-value" style={{ fontSize: '1.3rem' }}>{label === 'Pings' ? (val || 0) : fmtMs(val)}</div>
            <div class="stat-title">{label}</div>
          </div>
        ))}
      </div>

      <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>Sync Completeness</h4>
      <div style={{ margin: '1rem 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
          <span>Sync Completeness</span><span>{syncCompleteness}%</span>
        </div>
        <div style={{ height: '1.5rem', background: 'var(--bg-card)', borderRadius: '0.75rem', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${syncCompleteness}%`, background: syncColor, borderRadius: '0.75rem', transition: 'width 0.5s' }} />
        </div>
      </div>

      {perServer && perServer.length > 0 && (
        <>
          <h4 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>Per-Server Status</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: '1rem', margin: '1rem 0' }}>
            {perServer.map(s => {
              const st = s.aliveMembers === s.totalMembers ? 'alive' : s.aliveMembers === 0 ? 'failed' : 'suspect';
              const sc = st === 'alive' ? 'var(--success)' : st === 'suspect' ? 'var(--warning)' : 'var(--danger)';
              return (
                <div key={s.serverId} class="panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{s.serverId}</span>
                    <span style={{ padding: '0.15rem 0.5rem', borderRadius: '0.25rem', fontSize: '0.7rem', fontWeight: 600, color: 'white', background: sc }}>{st.toUpperCase()}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem' }}>
                    <div>Members: {s.aliveMembers}/{s.totalMembers}</div>
                    <div>RTT p50: {fmtMs(s.gossipRttP50Ms)}</div>
                    <div>RTT p95: {fmtMs(s.gossipRttP95Ms)}</div>
                    <div>Last: {new Date(s.lastSeen).toLocaleTimeString()}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
