/**
 * Simple SVG chart components: bar, line, donut.
 */

// ── Line Chart (p50/p95/p99 series) ──

interface DataPoint {
  timeBucket: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  [key: string]: unknown;
}

interface LineChartProps {
  dataPoints: DataPoint[];
  unit: string;
  width?: number;
  height?: number;
}

function formatVal(value: number, unit: string): string {
  if (unit === 'ms')
    return value >= 1000 ? (value / 1000).toFixed(1) + 's' : Math.round(value) + 'ms';
  if (unit === 'fps') return Math.round(value) + ' fps';
  if (unit === 'MB') return Math.round(value) + ' MB';
  return String(Math.round(value));
}

export function LineChart({ dataPoints, unit, width = 700, height = 220 }: LineChartProps) {
  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
        No data available for the selected filters and time range.
      </div>
    );
  }

  const padTop = 20, padRight = 20, padBottom = 40, padLeft = 60;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const allValues: number[] = [];
  for (const dp of dataPoints) {
    if (dp.p50 !== null) allValues.push(dp.p50);
    if (dp.p95 !== null) allValues.push(dp.p95);
    if (dp.p99 !== null) allValues.push(dp.p99);
  }
  if (allValues.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
        No data points in the selected range.
      </div>
    );
  }

  const minVal = Math.min(...allValues);
  const maxVal = Math.max(...allValues);
  const yRange = maxVal - minVal || 1;
  const yMin = Math.max(0, minVal - yRange * 0.1);
  const yMax = maxVal + yRange * 0.1;

  const scaleX = (idx: number) =>
    padLeft + (dataPoints.length === 1 ? chartW / 2 : (idx / (dataPoints.length - 1)) * chartW);
  const scaleY = (val: number | null) => {
    if (val === null) return null;
    return padTop + chartH - ((val - yMin) / (yMax - yMin)) * chartH;
  };

  const buildPath = (key: 'p50' | 'p95' | 'p99'): string => {
    let d = '';
    let started = false;
    for (let j = 0; j < dataPoints.length; j++) {
      const val = dataPoints[j]![key];
      if (val === null) continue;
      const x = scaleX(j).toFixed(1);
      const y = scaleY(val)!.toFixed(1);
      if (!started) { d += `M${x},${y}`; started = true; }
      else d += ` L${x},${y}`;
    }
    return d;
  };

  const gridLines: Array<{ y: number; label: string }> = [];
  for (let g = 0; g <= 4; g++) {
    const gy = padTop + (g / 4) * chartH;
    const gVal = yMax - (g / 4) * (yMax - yMin);
    gridLines.push({ y: gy, label: formatVal(gVal, unit) });
  }

  const xLabels: Array<{ x: number; label: string }> = [];
  const xStep = Math.max(1, Math.floor(dataPoints.length / 6));
  for (let xi = 0; xi < dataPoints.length; xi += xStep) {
    const xx = scaleX(xi);
    const lbl = dataPoints[xi]!.timeBucket.slice(11, 16);
    xLabels.push({ x: xx, label: lbl });
  }

  const p50Path = buildPath('p50');
  const p95Path = buildPath('p95');
  const p99Path = buildPath('p99');

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', maxHeight: '250px' }}>
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={padLeft} y1={g.y} x2={width - padRight} y2={g.y} stroke="rgba(255,255,255,0.08)" stroke-width="1" />
            <text x={padLeft - 8} y={g.y + 4} fill="#94a3b8" font-size="10" text-anchor="end">{g.label}</text>
          </g>
        ))}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={height - 8} fill="#94a3b8" font-size="10" text-anchor="middle">{l.label}</text>
        ))}
        {p50Path && <path d={p50Path} fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />}
        {p95Path && <path d={p95Path} fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />}
        {p99Path && <path d={p99Path} fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />}
      </svg>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '0.75rem', justifyContent: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: '#3b82f6' }} /> p50</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: '#eab308' }} /> p95</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}><span style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: '#ef4444' }} /> p99</span>
      </div>
    </div>
  );
}

// ── Mini Line Chart (single series, for small panels) ──

interface MiniLineProps {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}

export function MiniLine({ values, color = '#3b82f6', width = 300, height = 60 }: MiniLineProps) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = width / Math.max(values.length - 1, 1);
  let d = '';
  values.forEach((v, i) => {
    const x = i * step;
    const y = height - (v / max) * (height - 4);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  });
  return (
    <svg viewBox={`0 0 ${width} ${height + 4}`} style={{ width: '100%', height: `${height + 20}px`, marginTop: '0.75rem' }}>
      <path d={d} fill="none" stroke={color} stroke-width="2" />
    </svg>
  );
}

// ── Bar Chart ──

interface BarChartProps {
  items: Array<{ label: string; value: number; color?: string }>;
  maxHeight?: number;
}

export function BarChart({ items, maxHeight = 120 }: BarChartProps) {
  if (!items || items.length === 0) return null;
  const max = Math.max(...items.map(i => i.value), 1);
  const barWidth = Math.min(40, Math.floor(300 / items.length) - 8);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: maxHeight + 30, padding: '0 0.5rem' }}>
      {items.map((item, i) => {
        const h = (item.value / max) * maxHeight;
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginBottom: 2 }}>{item.value}</span>
            <div
              style={{
                width: barWidth,
                height: Math.max(h, 2),
                background: item.color || 'var(--accent)',
                borderRadius: '3px 3px 0 0',
              }}
            />
            <span style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', marginTop: 4, textAlign: 'center', maxWidth: barWidth + 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Donut Chart ──

interface DonutProps {
  segments: Array<{ label: string; value: number; color: string }>;
  size?: number;
  centerLabel?: string;
  centerValue?: string;
}

export function DonutChart({ segments, size = 120, centerLabel, centerValue }: DonutProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={size / 2 - 8} fill="none" stroke="#334155" stroke-width="16" />
        <text x={size / 2} y={size / 2 + 4} text-anchor="middle" fill="#64748b" font-size="14">No data</text>
      </svg>
    );
  }

  const r = size / 2 - 8;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.map((seg, i) => {
          const len = (seg.value / total) * circumference;
          const dashOffset = -offset;
          offset += len;
          return (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              stroke-width="16"
              stroke-dasharray={`${len} ${circumference - len}`}
              stroke-dashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
        })}
        {centerValue && (
          <>
            <text x={size / 2} y={size / 2 - 2} text-anchor="middle" fill="#f8fafc" font-size="16" font-weight="700">{centerValue}</text>
            {centerLabel && <text x={size / 2} y={size / 2 + 14} text-anchor="middle" fill="#94a3b8" font-size="10">{centerLabel}</text>}
          </>
        )}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {segments.map((seg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: seg.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-secondary)' }}>{seg.label}:</span>
            <span style={{ fontWeight: 600 }}>{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Gauge (ring) ──

interface GaugeProps {
  value: number | null;
  size?: number;
  label?: string;
}

export function Gauge({ value, size = 110, label }: GaugeProps) {
  const r = (size - 10) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = value !== null ? value / 100 : 0;
  const offset = circumference * (1 - pct);
  const color = value === null ? '#64748b' : value > 95 ? '#22c55e' : value >= 85 ? '#eab308' : '#ef4444';

  return (
    <div style={{ textAlign: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#334155" stroke-width="8" />
        <circle
          cx={cx} cy={cy} r={r} fill="none" stroke={color} stroke-width="8"
          stroke-dasharray={String(circumference)}
          stroke-dashoffset={String(offset)}
          transform={`rotate(-90 ${cx} ${cy})`}
          stroke-linecap="round"
        />
        <text x={cx} y={cy + 5} text-anchor="middle" fill={color} font-size="18" font-weight="700">
          {value !== null ? value.toFixed(1) + '%' : 'N/A'}
        </text>
      </svg>
      {label && <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{label}</div>}
    </div>
  );
}

// ── Area Chart (for server detail panels with timestamp data) ──

interface AreaChartProps {
  data: Array<{ timestamp: number; value: number }>;
  color?: string;
  maxForced?: number;
  height?: number;
}

export function AreaChart({ data, color = '#3b82f6', maxForced, height = 180 }: AreaChartProps) {
  if (!data || data.length < 2) return <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Insufficient data</div>;

  const w = 600;
  const p = { t: 10, r: 20, b: 25, l: 50 };
  const vals = data.map(d => d.value);
  const mx = maxForced || Math.max(...vals, 1);
  const t0 = data[0]!.timestamp;
  const t1 = data[data.length - 1]!.timestamp;
  const ts = t1 - t0 || 1;

  let pathD = '';
  data.forEach((d, i) => {
    const px = p.l + ((d.timestamp - t0) / ts) * (w - p.l - p.r);
    const py = p.t + (1 - d.value / mx) * (height - p.t - p.b);
    pathD += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1);
  });
  const areaD = pathD + ` L${w - p.r},${height - p.b} L${p.l},${height - p.b} Z`;

  const gridLines: Array<{ y: number; label: string }> = [];
  for (let g = 0; g <= 4; g++) {
    const pct = g / 4;
    const gy = p.t + (1 - pct) * (height - p.t - p.b);
    gridLines.push({ y: gy, label: (mx * pct).toFixed(0) });
  }

  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {gridLines.map((g, i) => (
        <g key={i}>
          <line x1={p.l} y1={g.y} x2={w - p.r} y2={g.y} stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4" />
          <text x={p.l - 5} y={g.y + 4} fill="var(--text-secondary)" font-size="10" text-anchor="end">{g.label}</text>
        </g>
      ))}
      <path d={areaD} fill={color + '22'} />
      <path d={pathD} fill="none" stroke={color} stroke-width="2" />
    </svg>
  );
}
