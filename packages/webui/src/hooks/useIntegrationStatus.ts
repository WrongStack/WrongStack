import { useEffect, useState } from 'react';
import { useLocalPrefs } from '@/stores/local-prefs';

export type IntegrationHealthStatus = 'disabled' | 'checking' | 'connected' | 'error';

export interface IntegrationProbeState {
  status: IntegrationHealthStatus;
  latencyMs: number | null;
  url: string;
  error?: string | undefined;
}

export function useWrongProxyStatus(): IntegrationProbeState {
  const enabled = useLocalPrefs((s) => s.wrongProxyEnabled);
  const url = useLocalPrefs((s) => s.wrongProxyUrl);

  const [state, setState] = useState<IntegrationProbeState>(() => ({
    status: enabled ? 'checking' : 'disabled',
    latencyMs: null,
    url: url || 'http://localhost:3444',
  }));

  useEffect(() => {
    if (!enabled || !url) {
      setState({
        status: 'disabled',
        latencyMs: null,
        url: url || 'http://localhost:3444',
      });
      return;
    }

    let disposed = false;
    const probe = async () => {
      const trimmed = url.trim().replace(/\/+$/, '');
      const healthUrl = `${trimmed}/api/health`;
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);

      try {
        const res = await fetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        clearTimeout(timer);
        if (disposed) return;
        const ok = res.ok && res.status >= 200 && res.status < 300;
        setState({
          status: ok ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          url: trimmed,
          error: ok ? undefined : `HTTP ${res.status}`,
        });
      } catch (err) {
        clearTimeout(timer);
        if (disposed) return;
        setState({
          status: 'error',
          latencyMs: Date.now() - start,
          url: trimmed,
          error: err instanceof Error ? err.message : 'Unreachable',
        });
      }
    };

    void probe();
    const interval = setInterval(() => void probe(), 10_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [enabled, url]);

  return state;
}

export function useHqStatus(): IntegrationProbeState {
  const enabled = useLocalPrefs((s) => s.hqEnabled);
  const url = useLocalPrefs((s) => s.hqUrl);
  const token = useLocalPrefs((s) => s.hqToken);

  const [state, setState] = useState<IntegrationProbeState>(() => ({
    status: enabled && url ? 'checking' : 'disabled',
    latencyMs: null,
    url: url || '',
  }));

  useEffect(() => {
    if (!enabled || !url) {
      setState({
        status: 'disabled',
        latencyMs: null,
        url: url || '',
      });
      return;
    }

    let disposed = false;
    const probe = async () => {
      const trimmed = url.trim().replace(/\/+$/, '');
      const healthUrl = `${trimmed}/api/auth/status`;
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);

      try {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
          headers,
        });
        clearTimeout(timer);
        if (disposed) return;
        // Even 401 proves the HQ server is alive and responding
        const ok = res.ok || res.status === 401;
        setState({
          status: ok ? 'connected' : 'error',
          latencyMs: Date.now() - start,
          url: trimmed,
          error: ok ? undefined : `HTTP ${res.status}`,
        });
      } catch (err) {
        clearTimeout(timer);
        if (disposed) return;
        setState({
          status: 'error',
          latencyMs: Date.now() - start,
          url: trimmed,
          error: err instanceof Error ? err.message : 'Unreachable',
        });
      }
    };

    void probe();
    const interval = setInterval(() => void probe(), 10_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [enabled, url, token]);

  return state;
}
