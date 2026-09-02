import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFetchError } from '@wrongstack/core/types';
import { fetchTool, guardedFetch } from '../src/fetch.js';
import { mkSandbox, newSignal } from './fixtures.js';

function mkResponse(opts: {
  body: string;
  status?: number;
  url?: string;
  contentType?: string;
}): Response {
  const enc = new TextEncoder();
  const bytes = enc.encode(opts.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    status: opts.status ?? 200,
    ok: (opts.status ?? 200) < 400,
    url: opts.url ?? 'https://example.com/',
    headers: new Headers({ 'content-type': opts.contentType ?? 'text/plain' }),
    body: stream,
  } as never as Response;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchTool', () => {
  it('has read-only network metadata', () => {
    expect(fetchTool.name).toBe('fetch');
    expect(fetchTool.permission).toBe('auto');
    expect(fetchTool.mutating).toBe(false);
    expect(fetchTool.capabilities).toEqual(['net.outbound']);
  });

  it('rejects non-http(s) protocols', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: 'file:///etc/passwd' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/unsupported protocol/);
    } finally {
      await sb.cleanup();
    }
  });

  it('blocks http:// by default', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: 'http://example.com' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/http.* blocked/);
    } finally {
      await sb.cleanup();
    }
  });

  it('blocks localhost', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: 'https://localhost/foo' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/localhost/);
    } finally {
      await sb.cleanup();
    }
  });

  it('blocks private IPv4 ranges', async () => {
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: 'https://10.0.0.1/' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/private/);
    } finally {
      await sb.cleanup();
    }
  });

  it('returns text content with status', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: 'hello there', contentType: 'text/plain' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: 'https://example.com/page' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.status).toBe(200);
      expect(out.content).toContain('hello');
      expect(out.content_type).toBe('text/plain');
    } finally {
      await sb.cleanup();
    }
  });

  it('pretty-prints JSON when content-type is JSON', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: '{"a":1,"b":2}', contentType: 'application/json' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: 'https://api.example.com/d.json' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.content).toContain('"a": 1');
      expect(out.content).toContain('"b": 2');
    } finally {
      await sb.cleanup();
    }
  });

  it('converts HTML to markdown by default', async () => {
    const html =
      '<html><body><h1>Title</h1><p>Hello <a href="https://x/">link</a></p><script>bad()</script></body></html>';
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: html, contentType: 'text/html; charset=utf-8' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: 'https://example.com/page' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.content).toContain('# Title');
      expect(out.content).toContain('[link](https://x/)');
      expect(out.content).not.toContain('bad()');
    } finally {
      await sb.cleanup();
    }
  });

  it('surfaces the underlying transport cause instead of opaque "fetch failed" (#100)', async () => {
    // undici throws `TypeError: fetch failed` and buries the real reason on
    // `.cause`. The tool must unwrap it so the user sees WHY the request died.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), {
      code: 'ENOTFOUND',
    });
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause });
    }) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const p = fetchTool.execute({ url: 'https://example.com/page' }, sb.ctx, {
        signal: newSignal(),
      });
      await expect(p).rejects.toThrow(/ENOTFOUND/);
      await expect(p).rejects.toThrow(/GET https:\/\/example\.com\/page failed/);
      // The bare wrapper text must not be all the user gets.
      await expect(p).rejects.not.toThrow(/^fetch failed$/);
    } finally {
      await sb.cleanup();
    }
  });

  it('refuses binary content-types', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: 'x', contentType: 'application/octet-stream' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      await expect(
        fetchTool.execute({ url: 'https://example.com/bin' }, sb.ctx, { signal: newSignal() }),
      ).rejects.toThrow(/binary/);
    } finally {
      await sb.cleanup();
    }
  });

  it('respects raw format', async () => {
    const html = '<p>raw</p>';
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: html, contentType: 'text/html' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: 'https://example.com/', format: 'raw' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.content).toBe('<p>raw</p>');
    } finally {
      await sb.cleanup();
    }
  });

  describe('SSRF defenses', () => {
    const blocked = [
      // IPv4 metadata / private / CGNAT / multicast
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/',
      'https://0.0.0.0/',
      'https://10.5.5.5/',
      'https://172.16.1.1/',
      'https://172.31.255.255/',
      'https://192.168.1.1/',
      'https://100.64.0.1/',
      'https://224.0.0.1/',
      'https://240.0.0.1/',
      // IPv6 loopback / link-local / ULA / multicast / IPv4-mapped
      'https://[::1]/',
      'https://[fe80::1]/',
      'https://[fc00::1]/',
      'https://[fd00::1]/',
      'https://[ff00::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:169.254.169.254]/',
    ];

    for (const url of blocked) {
      it(`blocks ${url}`, async () => {
        const sb = await mkSandbox();
        try {
          await expect(fetchTool.execute({ url }, sb.ctx, { signal: newSignal() })).rejects.toThrow(
            /private|localhost|blocked/,
          );
        } finally {
          await sb.cleanup();
        }
      });
    }

    it('re-validates redirect target against private ranges', async () => {
      // Public host returns a 302 redirecting to AWS metadata. The fix
      // requires re-checking each hop; pre-fix this would have fetched it.
      let firstHit = true;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        if (firstHit && u.startsWith('https://public.example')) {
          firstHit = false;
          return {
            status: 302,
            ok: false,
            url: u,
            headers: new Headers({ location: 'https://169.254.169.254/latest/meta-data/' }),
            body: null,
          } as never as Response;
        }
        // Should never reach here — re-validation must throw before we issue
        // the second fetch.
        return mkResponse({ body: 'leaked metadata!', contentType: 'text/plain' });
      }) as never as typeof fetch;

      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://public.example/redirect' }, sb.ctx, {
            signal: newSignal(),
          }),
        ).rejects.toThrow(/private|blocked/);
      } finally {
        await sb.cleanup();
      }
    });

    it('blocks IPv6 with mapped IPv4 private address', async () => {
      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://[::ffff:10.0.0.1]/' }, sb.ctx, {
            signal: newSignal(),
          }),
        ).rejects.toThrow(/private|blocked/);
      } finally {
        await sb.cleanup();
      }
    });

    it('allows public IPs (e.g. 8.8.8.8) — sanity check the gate is not over-broad', async () => {
      globalThis.fetch = vi.fn(async () =>
        mkResponse({ body: 'ok', contentType: 'text/plain' }),
      ) as never as typeof fetch;
      const sb = await mkSandbox();
      try {
        const out = await fetchTool.execute({ url: 'https://8.8.8.8/' }, sb.ctx, {
          signal: newSignal(),
        });
        expect(out.status).toBe(200);
      } finally {
        await sb.cleanup();
      }
    });

    it('allows public IPv6 (e.g. 2606:4700:4700::1111)', async () => {
      globalThis.fetch = vi.fn(async () =>
        mkResponse({ body: 'ok', contentType: 'text/plain' }),
      ) as never as typeof fetch;
      const sb = await mkSandbox();
      try {
        // Cloudflare DNS IPv6 — a clear public address. Confirms the IPv6
        // private-range gate isn't over-broad.
        const out = await fetchTool.execute({ url: 'https://[2606:4700:4700::1111]/' }, sb.ctx, {
          signal: newSignal(),
        });
        expect(out.status).toBe(200);
      } finally {
        await sb.cleanup();
      }
    });

    it('rejects bracketed IPv6 unspecified address (::)', async () => {
      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://[::]/' }, sb.ctx, { signal: newSignal() }),
        ).rejects.toThrow(/private|blocked/);
      } finally {
        await sb.cleanup();
      }
    });

    it('blocks redirect to http:// (downgrade attempt)', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        return {
          status: 302,
          ok: false,
          url: u,
          headers: new Headers({ location: 'http://attacker.example/' }),
          body: null,
        } as never as Response;
      }) as never as typeof fetch;

      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://good.example/' }, sb.ctx, {
            signal: newSignal(),
          }),
        ).rejects.toThrow(/blocked/);
      } finally {
        await sb.cleanup();
      }
    });

    it('rejects after too many redirects', async () => {
      // Always-redirect server — exhausts the 5-redirect budget.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        return {
          status: 302,
          ok: false,
          url: u,
          headers: new Headers({ location: 'https://loop.example/' }),
          body: null,
        } as never as Response;
      }) as never as typeof fetch;

      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://loop.example/' }, sb.ctx, {
            signal: newSignal(),
          }),
        ).rejects.toThrow(/redirects/);
      } finally {
        await sb.cleanup();
      }
    });

    it('rejects a redirect to an unsupported protocol', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        return {
          status: 302,
          ok: false,
          url: u,
          headers: new Headers({ location: 'ftp://files.example/x' }),
          body: null,
        } as never as Response;
      }) as never as typeof fetch;
      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://good.example/' }, sb.ctx, { signal: newSignal() }),
        ).rejects.toThrow(/unsupported protocol/);
      } finally {
        await sb.cleanup();
      }
    });

    it('rejects a redirect with no location header', async () => {
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        return {
          status: 302,
          ok: false,
          url: u,
          headers: new Headers({}), // no location
          body: null,
        } as never as Response;
      }) as never as typeof fetch;
      const sb = await mkSandbox();
      try {
        await expect(
          fetchTool.execute({ url: 'https://good.example/' }, sb.ctx, { signal: newSignal() }),
        ).rejects.toThrow(/no location header/);
      } finally {
        await sb.cleanup();
      }
    });

    it('throws a structured FsError with cause preserved on a transport failure', async () => {
      // Simulate undici's opaque "fetch failed" — a TypeError whose `.cause`
      // carries the real transport reason (ENOTFOUND, ECONNREFUSED, etc.).
      const transportCause = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
        code: 'ENOTFOUND',
      });
      const fetchFailed = new TypeError('fetch failed');
      // Node stores cause via the constructor option; assign manually to
      // keep this test free of TS-strict gymnastics.
      (fetchFailed as { cause?: unknown }).cause = transportCause;
      globalThis.fetch = vi.fn(async () => {
        throw fetchFailed;
      }) as never as typeof fetch;

      const sb = await mkSandbox();
      try {
        let caught: unknown;
        try {
          await fetchTool.execute({ url: 'https://broken.example/' }, sb.ctx, {
            signal: newSignal(),
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect(isFetchError(caught)).toBe(true);
        const fe = caught as ReturnType<typeof isFetchError> & {
          status: number;
          context?: Record<string, unknown>;
        };
        expect(fe.status).toBe(502);
        expect(fe.context?.url).toBe('https://broken.example/');
        expect(fe.context?.timedOut).toBe(false);
        // The cause chain is preserved end-to-end so callers can introspect
        // via `instanceof` / `.code` without parsing message text.
        expect(fe.cause).toBeDefined();
        const rootCause = (fe.cause as { cause?: unknown }).cause;
        expect((rootCause as { code?: string })?.code).toBe('ENOTFOUND');
      } finally {
        await sb.cleanup();
      }
    });

    it('streams a large body (flushes partial output and caps at MAX_BYTES)', async () => {
      const big = 'x'.repeat(200 * 1024); // > MAX_BYTES (128 KB) and > FLUSH_AT
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        return mkResponse({ body: big, contentType: 'text/plain', url: u });
      }) as never as typeof fetch;
      const sb = await mkSandbox();
      try {
        const out = await fetchTool.execute({ url: 'https://big.example/' }, sb.ctx, {
          signal: newSignal(),
        });
        expect(out.status).toBe(200);
        expect(out.content.length).toBeGreaterThan(0);
      } finally {
        await sb.cleanup();
      }
    });

    it('passes redirects to non-private targets through', async () => {
      let hop = 0;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        hop++;
        if (hop === 1 && u.startsWith('https://a.example')) {
          return {
            status: 302,
            ok: false,
            url: u,
            headers: new Headers({ location: 'https://b.example/' }),
            body: null,
          } as never as Response;
        }
        return mkResponse({ body: 'final', contentType: 'text/plain', url: u });
      }) as never as typeof fetch;

      const sb = await mkSandbox();
      try {
        const out = await fetchTool.execute({ url: 'https://a.example/' }, sb.ctx, {
          signal: newSignal(),
        });
        expect(out.status).toBe(200);
        expect(out.content).toContain('final');
      } finally {
        await sb.cleanup();
      }
    });
  });
});

// ─── Coverage: prettyJson error handling ──────────────────────────────────────
describe('fetch prettyJson error handling', () => {
  it('returns original string when JSON.parse fails', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse({
        body: 'not valid json { broken',
        contentType: 'application/json',
      }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute(
        { url: 'https://example.com/bad.json', format: 'text' },
        sb.ctx,
        { signal: newSignal() },
      );
      // prettyJson should return the raw input when parsing fails
      expect(out.content).toBe('not valid json { broken');
    } finally {
      await sb.cleanup();
    }
  });

  it('prettyPrints valid JSON when content-type is JSON', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: '{"a":1,"b":2}', contentType: 'application/json' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: 'https://api.example.com/d.json' }, sb.ctx, {
        signal: newSignal(),
      });
      expect(out.content).toContain('"a": 1');
      expect(out.content).toContain('"b": 2');
    } finally {
      await sb.cleanup();
    }
  });

  it('safely executes without opts and falls back to ctx.signal or default signal', async () => {
    globalThis.fetch = vi.fn(async () =>
      mkResponse({ body: 'no-opts content', contentType: 'text/plain' }),
    ) as never as typeof fetch;
    const sb = await mkSandbox();
    try {
      const out = await fetchTool.execute({ url: 'https://api.example.com/data' }, sb.ctx);
      expect(out.status).toBe(200);
      expect(out.content).toBe('no-opts content');

      const ac = new AbortController();
      const ctxWithSignal = { ...sb.ctx, signal: ac.signal };
      const outWithSignal = await fetchTool.execute(
        { url: 'https://api.example.com/data' },
        ctxWithSignal,
      );
      expect(outWithSignal.status).toBe(200);
    } finally {
      await sb.cleanup();
    }
  });
});

// F-05: the exported guardedFetch (now used by the `search` tool) must carry
// the same SSRF guard as the `fetch` tool — private/loopback targets rejected
// before any socket is opened.
describe('guardedFetch (shared SSRF-guarded fetch)', () => {
  it('rejects a loopback target', async () => {
    await expect(guardedFetch('https://127.0.0.1/', 5, newSignal())).rejects.toThrow(
      /private|blocked|loopback/,
    );
  });

  it('rejects the cloud metadata (IMDS) address', async () => {
    await expect(
      guardedFetch('https://169.254.169.254/latest/meta-data/', 5, newSignal()),
    ).rejects.toThrow(/private|blocked/);
  });
});
