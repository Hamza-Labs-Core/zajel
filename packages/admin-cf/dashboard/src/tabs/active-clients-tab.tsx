/**
 * Active Clients tab - NEW.
 * Fetches from /admin/api/clients/* endpoints.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
// Card/CardGrid available if needed for future stat cards
import { DonutChart, BarChart } from '../components/chart';

interface ActiveData { totalActive: number; byPlatform: Record<string, number> }
interface PlatformData { platforms: Array<{ platform: string; count: number; percentage: number }> }
interface VersionData { versions: Array<{ version: string; count: number; percentage: number }> }
interface ConnectionData { types: Array<{ type: string; count: number; percentage: number }> }

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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Active Clients</h3>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      {/* Big number */}
      <div class="panel" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
        <div style={{ fontSize: '4rem', fontWeight: 700, color: 'var(--accent)' }}>
          {active?.totalActive ?? 0}
        </div>
        <div style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>Total Active Clients</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
        {/* Platform breakdown donut */}
        <div class="panel">
          <h3>Platform Breakdown</h3>
          {platforms && platforms.platforms.length > 0 ? (
            <DonutChart
              segments={platforms.platforms.map(p => ({
                label: p.platform,
                value: p.count,
                color: platformColors[p.platform.toLowerCase()] || '#94a3b8',
              }))}
              centerValue={String(platforms.platforms.reduce((s, p) => s + p.count, 0))}
              centerLabel="total"
            />
          ) : (
            <div class="empty-state"><p>No platform data</p></div>
          )}
        </div>

        {/* Connection type distribution */}
        <div class="panel">
          <h3>Connection Types</h3>
          {connections && connections.types.length > 0 ? (
            <DonutChart
              segments={connections.types.map(t => ({
                label: t.type,
                value: t.count,
                color: t.type === 'direct' ? '#3b82f6' : t.type === 'relay' ? '#f97316' : '#94a3b8',
              }))}
              centerValue={String(connections.types.reduce((s, t) => s + t.count, 0))}
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
        {versions && versions.versions.length > 0 ? (
          <div>
            <BarChart
              items={versions.versions.slice(0, 10).map(v => ({
                label: v.version,
                value: v.count,
                color: '#3b82f6',
              }))}
            />
            <table class="data-table" style={{ marginTop: '1rem' }}>
              <thead><tr><th>Version</th><th>Count</th><th>Percentage</th></tr></thead>
              <tbody>
                {versions.versions.map(v => (
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
