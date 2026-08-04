import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';

// High base ports so the test never collides with a real WebUI / dev server.
const ports = { next: 45_700 };
const nextPort = () => ports.next++;

let serverDone: Promise<void> | null = null;

afterEach(async () => {
  if (serverDone) {
    process.emit('SIGTERM');
    await serverDone;
    serverDone = null;
  }
});

describe('runWebUI frontend serving', () => {
  it('serves the React frontend over HTTP with the live WS port injected', async () => {
    const events = new EventBus();
    // `url` is the tokenized access URL `runWebUI` announces (see
    // `WebUIServerOptions.onListening`). Needed since H3 — the HTTP surface
    // requires a token on every bind, so the test fetches the announced URL
    // rather than a bare origin.
    let info: { httpPort: number; wsPort: number; host: string; url: string } | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });

    serverDone = runWebUI({
      port: nextPort(),
      httpPort: nextPort(),
      profileConfigPath: '/tmp/test-profile.json',
  onListening: (i) => {
        info = i;
        signalReady?.();
      },
      events,
      session: { id: 'test-session' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' } },
        run: vi.fn(),
      } as never,
    });

    await listening;
    expect(info).toBeDefined();

    // The HTTP server should serve index.html with this instance's WS port
    // stamped in — that's what lets the browser connect back to THIS backend.
    // onListening fires on the WS server; the HTTP server listens separately and
    // can lag well past a tick under full-suite + coverage-instrumentation load,
    // so poll with vi.waitFor (retries on ECONNREFUSED) rather than a fixed
    // attempt budget that flakes when the machine is saturated.
    // Use the announced access URL, not a bare origin: since H3 the HTTP
    // surface requires a token on every bind, and `accessUrl` is exactly the
    // tokenized first-load URL the CLI prints and a browser opens. Fetching a
    // bare `/` here would assert the pre-H3 behavior.
    const url = info!.url;
    let res: Response | undefined;
    await vi.waitFor(
      async () => {
        res = await fetch(url);
      },
      { timeout: 8000, interval: 50 },
    );
    if (!res) throw new Error(`HTTP server never became reachable at ${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const html = await res.text();
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });
});
