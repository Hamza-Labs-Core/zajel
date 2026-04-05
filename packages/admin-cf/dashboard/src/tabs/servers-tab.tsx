/**
 * Servers tab - port of existing inline dashboard.
 */
import { useFetch } from '../hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';

interface ServerStats {
  connections: number;
  relayConnections: number;
  signalingConnections: number;
  activeCodes: number;
}

interface Server {
  id: string;
  endpoint: string;
  region: string;
  status: string;
  stats: ServerStats;
}

interface Aggregate {
  totalServers: number;
  healthyServers: number;
  degradedServers: number;
  offlineServers: number;
  totalConnections: number;
}

interface ServersData {
  servers: Server[];
  aggregate: Aggregate;
}

export function ServersTab() {
  const { data, loading } = useFetch<ServersData>('/admin/api/servers');

  const openVpsDashboard = async (server: Server) => {
    try {
      const res = await api<{ code: string }>('/admin/api/auth/code', { method: 'POST' });
      if (!res.success || !res.data?.code) {
        return;
      }
      const wsUrl = new URL(
        server.endpoint.replace('wss://', 'https://').replace('ws://', 'http://'),
      );
      const baseUrl = wsUrl.protocol + '//' + wsUrl.host;
      window.open(baseUrl + '/admin/?code=' + encodeURIComponent(res.data.code), '_blank');
    } catch (error) {
      console.error('Error opening VPS dashboard:', error);
    }
  };

  if (loading || !data) {
    return <div class="loading"><div class="spinner" /></div>;
  }

  const { servers, aggregate } = data;

  return (
    <div>
      <CardGrid>
        <Card title="Total Servers" value={aggregate.totalServers} />
        <Card title="Healthy" value={aggregate.healthyServers} valueColor="var(--success)" />
        <Card title="Degraded" value={aggregate.degradedServers} valueColor="var(--warning)" />
        <Card title="Offline" value={aggregate.offlineServers} valueColor="var(--danger)" />
        <Card title="Total Connections" value={aggregate.totalConnections} />
      </CardGrid>

      <div class="server-grid">
        {servers.map(server => (
          <div
            key={server.id}
            class="server-card"
            onClick={() => openVpsDashboard(server)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontWeight: 600, fontSize: '1.125rem' }}>{server.id}</span>
              <span class={`badge badge-${server.status || 'offline'}`}>
                {(server.status || 'unknown').toUpperCase()}
              </span>
            </div>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
              {server.region}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.875rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Connections</span>
                <span>{server.stats?.connections || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Relay</span>
                <span>{server.stats?.relayConnections || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Signaling</span>
                <span>{server.stats?.signalingConnections || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Active Codes</span>
                <span>{server.stats?.activeCodes || 0}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
