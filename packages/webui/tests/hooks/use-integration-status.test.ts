import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHqStatus, useWrongProxyStatus } from '../../src/hooks/useIntegrationStatus';
import { useLocalPrefs } from '../../src/stores/local-prefs';

describe('useWrongProxyStatus and useHqStatus hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLocalPrefs.setState({
      wrongProxyEnabled: false,
      wrongProxyUrl: 'http://localhost:3444',
      hqEnabled: false,
      hqUrl: 'http://localhost:3499',
      hqToken: '',
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns disabled status when wrongProxyEnabled is false', () => {
    const { result } = renderHook(() => useWrongProxyStatus());
    expect(result.current.status).toBe('disabled');
  });

  it('probes and returns connected status when wrongProxy is enabled and server responds ok', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response);

    useLocalPrefs.setState({ wrongProxyEnabled: true, wrongProxyUrl: 'http://localhost:3444' });

    const { result } = renderHook(() => useWrongProxyStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.status).toBe('connected');
    expect(result.current.url).toBe('http://localhost:3444');
    expect(result.current.latencyMs).not.toBeNull();
  });

  it('returns error status when wrongProxy probe fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection refused'));

    useLocalPrefs.setState({ wrongProxyEnabled: true, wrongProxyUrl: 'http://localhost:3444' });

    const { result } = renderHook(() => useWrongProxyStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('Connection refused');
  });

  it('returns disabled status when hqEnabled is false', () => {
    const { result } = renderHook(() => useHqStatus());
    expect(result.current.status).toBe('disabled');
  });

  it('probes and returns connected status when HQ is enabled and server responds ok', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    } as Response);

    useLocalPrefs.setState({ hqEnabled: true, hqUrl: 'http://localhost:3499', hqToken: 'test-token' });

    const { result } = renderHook(() => useHqStatus());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.status).toBe('connected');
    expect(result.current.url).toBe('http://localhost:3499');
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://localhost:3499/api/auth/status',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
  });
});
