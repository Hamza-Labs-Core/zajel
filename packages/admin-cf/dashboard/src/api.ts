/**
 * API client wrapper with JWT auth header injection.
 */

let _token: string | null = null;

export function getToken(): string | null {
  if (_token) return _token;
  _token = localStorage.getItem('zajel_admin_token');
  return _token;
}

export function setToken(token: string | null): void {
  _token = token;
  if (token) {
    localStorage.setItem('zajel_admin_token', token);
  } else {
    localStorage.removeItem('zajel_admin_token');
  }
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...options, headers });
  const data: ApiResponse<T> = await res.json();
  return data;
}

export function escapeHtml(str: string | undefined | null): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatUptime(secs: number): string {
  if (secs < 60) return secs + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400)
    return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
  return Math.floor(secs / 86400) + 'd ' + Math.floor((secs % 86400) / 3600) + 'h';
}

export function formatMetricValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined) return '--';
  if (unit === 'ms')
    return value >= 1000
      ? (value / 1000).toFixed(1) + 's'
      : Math.round(value) + 'ms';
  if (unit === 'fps') return Math.round(value) + ' fps';
  if (unit === 'MB') return Math.round(value) + ' MB';
  return String(value);
}

export function fmtMs(v: number | null | undefined): string {
  return v !== null && v !== undefined ? v.toFixed(1) + ' ms' : 'N/A';
}
