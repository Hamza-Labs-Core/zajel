/**
 * Active Clients tab - NEW.
 * Fetches from /admin/api/clients/* endpoints.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
// Card/CardGrid available if needed for future stat cards
import { DonutChart, BarChart } from '../components/chart';

interface ActiveData { activeCount: number; totalActive?: number; sparkline?: Array<{ timestamp: number; count: number }>; lastUpdated?: number }

// API returns: { platforms: [{platform, count, percentage}], totalActive, lastUpdated }
interface PlatformEntry { platform: string; count: number; percentage: number }
interface PlatformData { platforms: PlatformEntry[]; totalActive?: number; lastUpdated?: number }

// API returns: { range, buckets: [{timestamp, counts}], versions: string[], lastUpdated }
interface VersionBucket { timestamp: number; counts: Record<string, number> }
interface VersionData { range?: string; buckets?: VersionBucket[]; versions?: string[]; lastUpdated?: number }

// API returns: { current: [{connectionType, count, percentage}], trend: [...], totalActive, lastUpdated }
interface ConnectionEntry { connectionType: string; count: number; percentage: number }
interface ConnectionData { current?: ConnectionEntry[]; trend?: unknown[]; totalActive?: number; lastUpdated?: number }

export function ActiveClientsTab() {
  const [active, setActive] = useState<ActiveData | null>(null);
  const [platforms, setPlatforms] = useState<PlatformData | null>(null);
  const [versions, setVersions] = useState<VersionData | null>(null);
  const [connections, setConnections] = useState<ConnectionData | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    const [a, p, v, c] = await Promise.all([
      api<ActiveData>('/admin/api/clients/active'),
      api<PlatformData>('/admin/api/clients/platforms'),
      api<VersionData>('/admin/api/clients/versions'),
      api<ConnectionData>('/admin/api/clients/connections'),
    ]);
    if (a.success && a.data) setActive(a.data);
    if (p.success && p.data) setPlatforms(p.data);
    if (v.success && v.data) setVersions(v.data);
    if (c.success && c.data) setConnections(c.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(() => { if (!document.hidden) loadAll(); }, 30_000);
    return () => clearInterval(interval);
  }, [loadAll]);

  if (loading) return <div class="loading"><div class="spinner" /></div>;

  const platformColors: Record<string, string> = {
    android: '#22c55e', ios: '#3b82f6', linux: '#f97316', macos: '#a855f7',
    windows: '#eab308', web: '#06b6d4',
  };

  // Normalize platforms array
  const platformList = platforms?.platforms || [];

  // Normalize connections — API returns `current` not `types`
  const connectionList = connections?.current || [];

  // Normalize versions — API returns buckets + version names, aggregate totals per version
  const versionList: Array<{ version: string; count: number; percentage: number }> = [];
  if (versions?.buckets && versions.versions) {
    const totals: Record<string, number> = {};
    for (const bucket of versions.buckets) {
      for (const [ver, count] of Object.entries(bucket.counts)) {
        totals[ver] = (totals[ver] || 0) + count;
      }
    }
    const grandTotal = Object.values(totals).reduce((s, c) => s + c, 0) || 1;
    for (const ver of versions.versions) {
      const count = totals[ver] || 0;
      versionList.push({ version: ver, count, percentage: (count / grandTotal) * 100 });
    }
    versionList.sort((a, b) => b.count - a.count);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Active Clients</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      {/* Big number */}
      <div class="panel" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '4rem', fontWeight: 700, color: 'var(--accent)' }}>
          {active?.activeCount ?? active?.totalActive ?? 0}
        </div>
        <div style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>Total Active Clients</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
        {/* Platform breakdown donut */}
        <div class="panel">
          <h3>Platform Breakdown</h3>
          {platformList.length > 0 ? (
            <DonutChart
              segments={platformList.map(p => ({
                label: p.platform,
                value: p.count,
                color: platformColors[p.platform.toLowerCase()] || '#94a3b8',
              }))}
              centerValue={String(platformList.reduce((s, p) => s + p.count, 0))}
              centerLabel="total"
            />
          ) : (
            <div class="empty-state"><p>No platform data</p></div>
          )}
        </div>

        {/* Connection type distribution */}
        <div class="panel">
          <h3>Connection Types</h3>
          {connectionList.length > 0 ? (
            <DonutChart
              segments={connectionList.map(t => ({
                label: t.connectionType,
                value: t.count,
                color: t.connectionType === 'direct_p2p' ? '#3b82f6' : t.connectionType === 'relay' ? '#f97316' : '#94a3b8',
              }))}
              centerValue={String(connectionList.reduce((s, t) => s + t.count, 0))}
              centerLabel="connections"
            />
          ) : (
            <div class="empty-state"><p>No connection data</p></div>
          )}
        </div>
      </div>

      {/* Version adoption */}
      <div class="panel" style={{ marginTop: '1.5rem' }}>
        <h3>Version Adoption</h3>
        {versionList.length > 0 ? (
          <div>
            <BarChart
              items={versionList.slice(0, 10).map(v => ({
                label: v.version,
                value: v.count,
                color: '#3b82f6',
              }))}
            />
            <table class="data-table" style={{ marginTop: '1rem' }}>
              <thead><tr><th>Version</th><th>Count</th><th>Percentage</th></tr></thead>
              <tbody>
                {versionList.map(v => (
                  <tr key={v.version}>
                    <td style={{ fontWeight: 600 }}>{v.version}</td>
                    <td>{v.count}</td>
                    <td>{v.percentage.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div class="empty-state"><p>No version data yet</p></div>
        )}
      </div>
    </div>
  );
}
