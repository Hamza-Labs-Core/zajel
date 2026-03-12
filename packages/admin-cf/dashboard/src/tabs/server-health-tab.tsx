/**
 * Server Health tab - NEW.
 * Fetches from /admin/api/servers/health, /admin/api/logs, /admin/api/federation/topology.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';

interface ServerHealth {
  serverId: string;
  region: string;
  status: string;
  lastHeartbeat?: string;
  lastSeen?: number;
  uptimeSeconds: number;
  version?: string;
  cpuPercent?: number;
  memoryMb?: number;
  connectionsTotal?: number;
  healthScore?: number;
  endpoint?: string;
}

interface HealthData {
  servers: ServerHealth[];
  lastUpdated?: number;
}

interface LogEntry {
  timestamp: string;
  level: string;
  server_id: string;
  message: string;
  category?: string;
}

interface LogsData {
  logs: LogEntry[];
  total: number;
}

interface TopologyNode {
  serverId: string;
  region: string;
  status: string;
  connections?: string[];
  aliveMembers?: number;
  totalMembers?: number;
  endpoint?: string;
}

interface TopologyEdge {
  source: string;
  target: string;
  latencyMs?: number;
}

interface TopologyData {
  nodes: TopologyNode[];
  edges?: TopologyEdge[];
  summary?: { totalNodes: number; aliveNodes: number; edgeCount: number; avgLatencyMs: number | null };
}

interface HeartbeatSegment {
  startTime: number;
  endTime: number;
  status: string;
}

interface HeartbeatEntry {
  serverId: string;
  region?: string;
  segments?: HeartbeatSegment[];
  timestamps?: number[];
  uptimePercent?: number;
  gapCount?: number;
  status?: string;
}

interface HeartbeatData {
  servers: HeartbeatEntry[];
  range?: string;
  lastUpdated?: number;
}

export function ServerHealthTab() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [logs, setLogs] = useState<LogsData | null>(null);
  const [topology, setTopology] = useState<TopologyData | null>(null);
  const [heartbeats, setHeartbeats] = useState<HeartbeatData | null>(null);
  const [loading, setLoading] = useState(true);

  // Log filters
  const [logLevel, setLogLevel] = useState('');
  const [logSearch, setLogSearch] = useState('');
  const [logRange, setLogRange] = useState('1h');

  const loadAll = useCallback(async () => {
    const [h, t, hb] = await Promise.all([
      api<HealthData>('/admin/api/servers/health'),
      api<TopologyData>('/admin/api/federation/topology'),
      api<HeartbeatData>('/admin/api/servers/heartbeat-timeline'),
    ]);
    if (h.success && h.data) setHealth(h.data);
    if (t.success && t.data) setTopology(t.data);
    if (hb.success && hb.data) setHeartbeats(hb.data);
    setLoading(false);
  }, []);

  const loadLogs = useCallback(async () => {
    let url = `/admin/api/logs?range=${encodeURIComponent(logRange)}&limit=100`;
    if (logLevel) url += `&level=${encodeURIComponent(logLevel)}`;
    if (logSearch) url += `&search=${encodeURIComponent(logSearch)}`;
    const res = await api<LogsData>(url);
    if (res.success && res.data) setLogs(res.data);
  }, [logRange, logLevel, logSearch]);

  useEffect(() => {
    loadAll();
    loadLogs();
    const interval = setInterval(() => { if (!document.hidden) { loadAll(); loadLogs(); } }, 30_000);
    return () => clearInterval(interval);
  }, [loadAll, loadLogs]);

  if (loading) return <div class="loading"><div class="spinner" /></div>;

  const servers = health?.servers || [];
  const healthyCt = servers.filter(s => s.status === 'healthy').length;
  const degradedCt = servers.filter(s => s.status === 'degraded').length;
  const offlineCt = servers.filter(s => s.status === 'offline').length;

  const statusColor = (status: string) => {
    switch (status) {
      case 'healthy': case 'alive': return 'var(--success)';
      case 'degraded': case 'suspect': return 'var(--warning)';
      default: return 'var(--danger)';
    }
  };

  const levelColor = (level: string) => {
    switch (level.toLowerCase()) {
      case 'error': case 'fatal': return 'var(--danger)';
      case 'warn': case 'warning': return 'var(--warning)';
      case 'info': return 'var(--accent)';
      default: return 'var(--text-secondary)';
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Server Health</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      <CardGrid>
        <Card title="Total Servers" value={servers.length} />
        <Card title="Healthy" value={healthyCt} valueColor="var(--success)" />
        <Card title="Degraded" value={degradedCt} valueColor="var(--warning)" />
        <Card title="Offline" value={offlineCt} valueColor="var(--danger)" />
      </CardGrid>

      {/* Server status cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: '1rem', marginBottom: '2rem' }}>
        {servers.map(s => {
          const lastSeenMs = s.lastSeen ? s.lastSeen : s.lastHeartbeat ? new Date(s.lastHeartbeat).getTime() : 0;
          const freshMs = lastSeenMs ? Date.now() - lastSeenMs : Infinity;
          const freshLabel = freshMs < 60_000 ? 'just now' : freshMs < 300_000 ? `${Math.floor(freshMs / 60_000)}m ago` : 'stale';
          const freshColor = freshMs < 120_000 ? 'var(--success)' : freshMs < 300_000 ? 'var(--warning)' : 'var(--danger)';
          const displayId = s.serverId.length > 20 ? s.serverId.slice(0, 12) + '...' + s.serverId.slice(-6) : s.serverId;
          return (
            <div key={s.serverId} class="panel" style={{ borderLeft: `4px solid ${statusColor(s.status)}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.85rem' }} title={s.serverId}>{displayId}</span>
                <span class={`badge badge-${s.status}`}>{s.status.toUpperCase()}</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem' }}>
                <div>Region: {s.region || 'unknown'}</div>
                <div>Connections: {s.connectionsTotal ?? 'N/A'}</div>
                <div>Heartbeat: <span style={{ color: freshColor }}>{freshLabel}</span></div>
                <div>Uptime: {formatUptime(s.uptimeSeconds)}</div>
              </div>
            </div>
          );
        })}
        {servers.length === 0 && <div class="empty-state"><p>No server health data available</p></div>}
      </div>

      {/* Heartbeat Freshness */}
      {heartbeats && heartbeats.servers && heartbeats.servers.length > 0 && (
        <div class="panel" style={{ marginBottom: '2rem' }}>
          <h3>Heartbeat Timeline</h3>
          <div style={{ marginTop: '1rem' }}>
            {heartbeats.servers.map(hb => {
              // Support both old (timestamps[]) and new (segments[]) API shapes
              let freshMs = Infinity;
              let count = 0;
              if (hb.segments && hb.segments.length > 0) {
                freshMs = Date.now() - hb.segments[hb.segments.length - 1]!.endTime;
                count = hb.segments.length;
              } else if (hb.timestamps && hb.timestamps.length > 0) {
                freshMs = Date.now() - hb.timestamps[hb.timestamps.length - 1]!;
                count = hb.timestamps.length;
              }
              const freshColor = freshMs < 120_000 ? 'var(--success)' : freshMs < 300_000 ? 'var(--warning)' : 'var(--danger)';
              const displayId = hb.serverId.length > 20 ? hb.serverId.slice(0, 12) + '...' + hb.serverId.slice(-6) : hb.serverId;
              return (
                <div key={hb.serverId} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: freshColor, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, minWidth: 120, fontSize: '0.85rem' }} title={hb.serverId}>{displayId}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {count} segments{hb.uptimePercent != null ? `, ${hb.uptimePercent.toFixed(1)}% uptime` : ''}, last {freshMs < 60_000 ? 'just now' : `${Math.floor(freshMs / 60_000)}m ago`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Log Viewer */}
      <div class="panel">
        <h3>Server Logs</h3>
        <div class="filter-bar" style={{ marginTop: '1rem' }}>
          <div class="filter-group">
            <label>Severity</label>
            <select value={logLevel} onChange={(e) => setLogLevel((e.target as HTMLSelectElement).value)}>
              <option value="">All</option>
              <option value="error">Error</option>
              <option value="warn">Warning</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
            </select>
          </div>
          <div class="filter-group">
            <label>Time Range</label>
            <select value={logRange} onChange={(e) => setLogRange((e.target as HTMLSelectElement).value)}>
              {['1h', '6h', '24h', '7d'].map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div class="filter-group" style={{ flex: 1, minWidth: 200 }}>
            <label>Search</label>
            <input type="text" value={logSearch} placeholder="Keyword search..."
              onInput={(e) => setLogSearch((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        {logs && logs.logs && logs.logs.length > 0 ? (
          <div style={{ maxHeight: 400, overflowY: 'auto', fontSize: '0.8rem', fontFamily: 'monospace' }}>
            {logs.logs.map((log, i) => (
              <div key={i} style={{ padding: '0.4rem 0.6rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.75rem' }}>
                <span style={{ color: 'var(--text-secondary)', minWidth: 130, flexShrink: 0 }}>
                  {new Date(log.timestamp).toLocaleString()}
                </span>
                <span style={{ color: levelColor(log.level), minWidth: 50, fontWeight: 600, textTransform: 'uppercase', flexShrink: 0 }}>
                  {log.level}
                </span>
                <span style={{ color: 'var(--text-secondary)', minWidth: 80, flexShrink: 0 }}>
                  {log.server_id}
                </span>
                <span style={{ wordBreak: 'break-all' }}>{log.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <div class="empty-state"><p>No logs found for the selected filters</p></div>
        )}
      </div>

      {/* Federation Topology */}
      {topology && topology.nodes && topology.nodes.length > 0 && (
        <div class="panel" style={{ marginTop: '1.5rem' }}>
          <h3>Federation Topology</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: '1rem', marginTop: '1rem' }}>
            {topology.nodes.map(node => (
              <div key={node.serverId} style={{ background: 'var(--bg-primary)', padding: '1rem', borderRadius: '0.5rem', border: `1px solid ${statusColor(node.status)}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 600 }}>{node.serverId}</span>
                  <span class={`badge badge-${node.status}`}>{node.status}</span>
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  Region: {node.region}
                </div>
                {node.connections && node.connections.length > 0 && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                    Connected to: {node.connections.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatUptime(secs: number): string {
  if (!secs) return 'N/A';
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
  return Math.floor(secs / 86400) + 'd ' + Math.floor((secs % 86400) / 3600) + 'h';
}
