/**
 * Shared hooks for data fetching with auto-refresh.
 */
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { api, type ApiResponse } from './api';

interface UseFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useFetch<T>(
  path: string | null,
  autoRefreshMs: number = 30_000,
): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refetch = useCallback(async () => {
    const currentPath = pathRef.current;
    if (!currentPath) return;
    try {
      const res: ApiResponse<T> = await api<T>(currentPath);
      if (res.success && res.data !== undefined) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error || 'Request failed');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refetch();

    if (autoRefreshMs > 0) {
      const interval = setInterval(() => {
        if (!document.hidden) refetch();
      }, autoRefreshMs);
      return () => clearInterval(interval);
    }
  }, [path, autoRefreshMs, refetch]);

  return { data, loading, error, refetch };
}
