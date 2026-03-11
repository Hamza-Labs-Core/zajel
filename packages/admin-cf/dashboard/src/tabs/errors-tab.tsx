/**
 * Errors tab - port of existing inline dashboard with trends chart and regressions.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../api';
import { Card, CardGrid } from '../components/card';
import { DataTable, type Column } from '../components/table';

interface ErrorSummary {
  totalErrors: number;
  rateChangePercent: number;
  regressionAlerts: number;
  highestSeverity: string;
}

interface ErrorRow {
  errorSignature: string;
  category: string;
  totalCount: number;
  platforms: string[];
  firstSeen: string;
  lastSeen: string;
  sampleMessage: string;
}

interface ErrorsData {
  summary: ErrorSummary;
  errors: ErrorRow[];
  range: string;
}

interface TrendsData {
  timestamps: number[];
  series: Record<string, number[]>;
  deployments?: Array<{ timestamp: number; version: string }>;
}

interface Regression {
  errorSignature: string;
  category: string;
  currentTotal: number;
  currentRate: number;
  previousTotal: number;
  previousRate: number;
  multiplier: number;
  sampleMessage: string;
  firstDetected: string;
}

interface RegressionsData {
  regressions: Regression[];
  currentVersion: string;
  previousVersion: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  crash: '#ef4444', network: '#eab308', crypto: '#a855f7',
  storage: '#3b82f6', ui: '#22c55e', protocol: '#f97316', other: '#94a3b8',
};

export function ErrorsTab() {
  const [range, setRange] = useState('24h');
  const [errorsData, setErrorsData] = useState<ErrorsData | null>(null);
  const [trendsData, setTrendsData] = useState<TrendsData | null>(null);
  const [regressionsData, setRegressionsData] = useState<RegressionsData | null>(null);
  const [showRegressions, setShowRegressions] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadErrors = useCallback(async () => {
    const [errorsRes, trendsRes, regressionsRes] = await Promise.all([
      api<ErrorsData>(`/admin/api/errors?range=${encodeURIComponent(range)}`),
      api<TrendsData>(`/admin/api/errors/trends?range=${encodeURIComponent(range)}`),
      api<RegressionsData>('/admin/api/errors/regressions?window=24h'),
    ]);
    if (errorsRes.success && errorsRes.data) {
      setErrorsData(errorsRes.data);
    }
    if (trendsRes.success && trendsRes.data) {
      setTrendsData(trendsRes.data);
    }
    if (regressionsRes.success && regressionsRes.data) {
      setRegressionsData(regressionsRes.data);
      if (errorsRes.data?.summary) {
        errorsRes.data.summary.regressionAlerts = regressionsRes.data.regressions.length;
        setErrorsData({ ...errorsRes.data });
      }
    }
    setLoading(false);
  }, [range]);

  useEffect(() => {
    setLoading(true);
    loadErrors();
    const interval = setInterval(() => {
      if (!document.hidden) loadErrors();
    }, 30_000);
    return () => clearInterval(interval);
  }, [loadErrors]);

  if (loading || !errorsData) {
    return <div class="loading"><div class="spinner" /></div>;
  }

  const summary = errorsData.summary;

  let rateChangeClass = '';
  let rateChangeText = '0%';
  if (summary.rateChangePercent > 0) {
    rateChangeClass = 'color: var(--danger)';
    rateChangeText = '+' + summary.rateChangePercent + '%';
  } else if (summary.rateChangePercent < 0) {
    rateChangeClass = 'color: var(--success)';
    rateChangeText = summary.rateChangePercent + '%';
  }

  const errColumns: Column<ErrorRow>[] = [
    {
      key: 'errorSignature',
      label: 'Signature',
      render: (row) => <span title={row.sampleMessage}>{row.errorSignature.substring(0, 12)}...</span>,
    },
    {
      key: 'category',
      label: 'Category',
      render: (row) => <span class={`badge badge-${row.category}`}>{row.category}</span>,
    },
    { key: 'totalCount', label: 'Count' },
    {
      key: 'platforms',
      label: 'Platforms',
      render: (row) => <>{(row.platforms || []).join(', ')}</>,
    },
    {
      key: 'firstSeen',
      label: 'First Seen',
      render: (row) => <>{new Date(row.firstSeen).toLocaleString()}</>,
    },
    {
      key: 'lastSeen',
      label: 'Last Seen',
      render: (row) => <>{new Date(row.lastSeen).toLocaleString()}</>,
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div class="range-selector">
          {['1h', '24h', '7d'].map(r => (
            <button
              key={r}
              class={`range-btn${range === r ? ' active' : ''}`}
              onClick={() => setRange(r)}
            >{r}</button>
          ))}
        </div>
        <span class="auto-refresh-note">Auto-refresh: 30s</span>
      </div>

      <CardGrid>
        <Card title={`Total Errors (${range})`} value={summary.totalErrors} />
        <div class="stat-card">
          <div class="stat-value" style={rateChangeClass}>{rateChangeText}</div>
          <div class="stat-title">vs Previous Period</div>
        </div>
        <Card title="Regression Alerts" value={summary.regressionAlerts} />
        <div class="stat-card">
          <div class={`stat-value severity-${summary.highestSeverity || 'none'}`}>
            {(summary.highestSeverity || 'none').toUpperCase()}
          </div>
          <div class="stat-title">Top Severity</div>
        </div>
      </CardGrid>

      {/* Regression banner */}
      {regressionsData && regressionsData.regressions.length > 0 && (
        <div>
          <div style={{
            background: 'rgba(239,68,68,0.15)', border: '1px solid var(--danger)',
            borderRadius: '0.75rem', padding: '1rem 1.25rem', marginBottom: '1.5rem',
            display: 'flex', alignItems: 'center', gap: '0.75rem'
          }}>
            <span style={{ fontSize: '1.25rem', flexShrink: 0 }}>&#9888;</span>
            <span style={{ flex: 1, fontSize: '0.875rem' }}>
              <strong>{regressionsData.regressions.length} regression(s) detected</strong> --
              Worst: {regressionsData.regressions[0]!.errorSignature.substring(0, 12)}...
              ({regressionsData.regressions[0]!.multiplier}x increase in {regressionsData.regressions[0]!.category})
            </span>
            <button class="danger" style={{ flexShrink: 0, fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
              onClick={() => setShowRegressions(!showRegressions)}
            >
              {showRegressions ? 'Hide' : 'View All'}
            </button>
          </div>

          {showRegressions && (
            <DataTable
              columns={[
                { key: 'errorSignature', label: 'Signature', render: (r: Regression) => <span title={r.sampleMessage}>{r.errorSignature.substring(0, 12)}...</span> },
                { key: 'category', label: 'Category', render: (r: Regression) => <span class={`badge badge-${r.category}`}>{r.category}</span> },
                { key: 'currentTotal', label: `Current (v${regressionsData.currentVersion})`, render: (r: Regression) => <>{r.currentTotal} ({r.currentRate}/hr)</> },
                { key: 'previousTotal', label: `Previous (v${regressionsData.previousVersion})`, render: (r: Regression) => <>{r.previousTotal} ({r.previousRate}/hr)</> },
                { key: 'multiplier', label: 'Multiplier', render: (r: Regression) => <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{r.multiplier}x</span> },
                { key: 'firstDetected', label: 'Detected', render: (r: Regression) => <>{new Date(r.firstDetected).toLocaleString()}</> },
              ]}
              data={regressionsData.regressions as unknown as Record<string, unknown>[]}
            />
          )}
        </div>
      )}

      {/* Trends chart (simple SVG stacked area) */}
      {trendsData && trendsData.timestamps && trendsData.timestamps.length > 0 && (
        <div class="panel">
          <h3>Error Trends</h3>
          <TrendsChart data={trendsData} />
        </div>
      )}

      {errorsData.errors.length === 0 ? (
        <div class="empty-state">
          <h3>No errors found</h3>
          <p>No errors were reported in the selected time range ({range}).</p>
        </div>
      ) : (
        <DataTable
          columns={errColumns}
          data={errorsData.errors as unknown as Record<string, unknown>[]}
          emptyMessage="No errors found"
        />
      )}
    </div>
  );
}

// ── Simple stacked area SVG chart ──

function TrendsChart({ data }: { data: TrendsData }) {
  const categories = Object.keys(data.series);
  if (categories.length === 0) return <div class="empty-state"><p>No trend data</p></div>;

  const width = 800;
  const height = 280;
  const pad = { t: 20, r: 20, b: 40, l: 50 };
  const cw = width - pad.l - pad.r;
  const ch = height - pad.t - pad.b;
  const n = data.timestamps.length;

  // Compute stacked totals
  const stackedMax = data.timestamps.reduce((mx, _, i) => {
    let sum = 0;
    categories.forEach(cat => { sum += (data.series[cat]?.[i] || 0); });
    return Math.max(mx, sum);
  }, 1);

  const scaleX = (i: number) => pad.l + (n === 1 ? cw / 2 : (i / (n - 1)) * cw);
  const scaleY = (v: number) => pad.t + ch - (v / (stackedMax * 1.1)) * ch;

  // Build stacked areas from bottom to top
  const areas: Array<{ d: string; color: string; label: string }> = [];
  // cumulative array tracks stacked baseline per data point

  const cumulative = new Array(n).fill(0);

  categories.forEach((cat) => {
    const series = data.series[cat] || [];
    const topPoints: string[] = [];
    const botPoints: string[] = [];

    for (let i = 0; i < n; i++) {
      const base = cumulative[i]!;
      const val = base + (series[i] || 0);
      topPoints.push(`${scaleX(i).toFixed(1)},${scaleY(val).toFixed(1)}`);
      botPoints.unshift(`${scaleX(i).toFixed(1)},${scaleY(base).toFixed(1)}`);
      cumulative[i] = val;
    }

    const d = `M${topPoints.join(' L')} L${botPoints.join(' L')} Z`;
    areas.push({ d, color: CATEGORY_COLORS[cat] || '#94a3b8', label: cat });
  });

  // X axis labels
  const xStep = Math.max(1, Math.floor(n / 8));
  const xLabels: Array<{ x: number; label: string }> = [];
  for (let i = 0; i < n; i += xStep) {
    const ts = data.timestamps[i]!;
    const date = new Date(ts * 1000);
    xLabels.push({ x: scaleX(i), label: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) });
  }

  // Y axis labels
  const yLabels: Array<{ y: number; label: string }> = [];
  for (let g = 0; g <= 4; g++) {
    const val = (stackedMax * 1.1 * g) / 4;
    yLabels.push({ y: scaleY(val), label: Math.round(val).toString() });
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', maxHeight: '300px' }}>
        {yLabels.map((l, i) => (
          <g key={i}>
            <line x1={pad.l} y1={l.y} x2={width - pad.r} y2={l.y} stroke="rgba(255,255,255,0.06)" stroke-width="1" />
            <text x={pad.l - 8} y={l.y + 4} fill="#94a3b8" font-size="10" text-anchor="end">{l.label}</text>
          </g>
        ))}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={height - 8} fill="#94a3b8" font-size="10" text-anchor="middle">{l.label}</text>
        ))}
        {areas.map((a, i) => (
          <path key={i} d={a.d} fill={a.color + '40'} stroke={a.color} stroke-width="1.5" />
        ))}
      </svg>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        {areas.map((a, i) => (
          <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.color, display: 'inline-block' }} />
            {a.label}
          </span>
        ))}
      </div>
    </div>
  );
}
