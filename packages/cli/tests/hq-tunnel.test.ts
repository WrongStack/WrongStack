import { describe, expect, it } from 'vitest';
import {
  buildPublicHqUrl,
  extractQuickTunnelUrl,
  hasRegisteredQuickTunnelConnection,
  startHqQuickTunnel,
} from '../src/hq-tunnel.js';

describe('HQ Cloudflare Quick Tunnel helpers', () => {
  it('extracts the generated URL from cloudflared output', () => {
    expect(
      extractQuickTunnelUrl(
        'INF Your quick Tunnel has been created! Visit it at https://quiet-river-42.trycloudflare.com',
      ),
    ).toBe('https://quiet-river-42.trycloudflare.com');
  });

  it('does not accept lookalike domains', () => {
    expect(extractQuickTunnelUrl('https://trycloudflare.com.evil.example')).toBeUndefined();
  });

  it('waits for the edge connection instead of treating the early URL banner as ready', () => {
    expect(
      hasRegisteredQuickTunnelConnection(
        'Your quick Tunnel has been created at https://quiet-river.trycloudflare.com',
      ),
    ).toBe(false);
    expect(
      hasRegisteredQuickTunnelConnection(
        'INF Registered tunnel connection connIndex=0 location=hel02 protocol=quic',
      ),
    ).toBe(true);
  });

  it('forwards the bootstrap fragment only when requested', () => {
    const local = 'http://127.0.0.1:3499/#bootstrap=abc123';
    expect(buildPublicHqUrl('https://quiet-river.trycloudflare.com', local, true)).toBe(
      'https://quiet-river.trycloudflare.com/#bootstrap=abc123',
    );
    expect(buildPublicHqUrl('https://quiet-river.trycloudflare.com', local, false)).toBe(
      'https://quiet-river.trycloudflare.com/',
    );
  });

  it('never forwards query-string tokens', () => {
    const local = 'http://127.0.0.1:3499/?token=secret-token';
    expect(buildPublicHqUrl('https://quiet-river.trycloudflare.com', local, true)).toBe(
      'https://quiet-river.trycloudflare.com/',
    );
  });

  it('reports a clear installation error when cloudflared is unavailable', async () => {
    await expect(
      startHqQuickTunnel('http://127.0.0.1:3499', {
        executable: '__wrongstack_missing_cloudflared__',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('cloudflared` was not found in PATH');
  });
});
