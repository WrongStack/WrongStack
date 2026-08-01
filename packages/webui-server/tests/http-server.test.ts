/**
 * Tests for the static-serve HTTP server. Two concerns:
 *
 *   1. **MIME matching + path traversal guard.** The server must reject
 *      `../../../etc/passwd` style escapes and serve a real .html file
 *      with the correct Content-Type and CSP header.
 *
 *   2. **SPA fallback.** Unknown paths serve `index.html` (with the same
 *      CSP as the direct .html branch) so client-side routing still
 *      works for deep-linked URLs.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCspHeader,
  createHttpServer,
  decodeSessionId,
  injectWsConfig,
  isInsideDist,
} from '../src/index.js';

let distDir: string;
let server: import('node:http').Server;
let baseUrl: string;

beforeAll(async () => {
  // Build a tiny distDir with one .html, one .js, and one .json file.
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-http-'));
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>root</title>');
  await fs.writeFile(path.join(distDir, 'app.js'), 'console.log(1);');
  await fs.mkdir(path.join(distDir, 'assets'));
  await fs.writeFile(path.join(distDir, 'assets', 'app-deadbeef.js'), 'console.log(2);');
  await fs.writeFile(path.join(distDir, 'manifest.json'), '{"name":"test"}');

  server = createHttpServer({ host: '127.0.0.1', distDir });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad listen address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(distDir, { recursive: true, force: true });
});

describe('buildCspHeader', () => {
  it("covers same-origin WS via 'self' in connect-src", () => {
    const csp = buildCspHeader();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('[::1]');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("ignores requestHost — 'self' covers same-origin upgrades", () => {
    const csp = buildCspHeader('wrongstack.example.com');
    // 'self' in connect-src covers same-origin WS upgrades regardless of host header.
    expect(csp).toContain("connect-src 'self'");
  });

  it('allows an explicit public WebSocket URL for tunnel access', () => {
    const csp = buildCspHeader('wss://wrongstack-ws.example.com/ws');
    expect(csp).toContain('wss://wrongstack-ws.example.com');
  });

  it('adds explicit ws:// entries for loopback hosts', () => {
    const csp = buildCspHeader(undefined, '127.0.0.1', 3466);
    expect(csp).toContain('ws://127.0.0.1:3466');
    expect(csp).toContain('wss://127.0.0.1:3466');
    expect(csp).toContain('ws://localhost:3466');
    expect(csp).toContain('wss://localhost:3466');
  });

  it('adds explicit ws:// entries for localhost bind', () => {
    const csp = buildCspHeader(undefined, '127.0.0.1', 3456);
    expect(csp).toContain('ws://127.0.0.1:3456');
    expect(csp).toContain('ws://localhost:3456');
  });

  it('does not add ws:// entries for non-loopback hosts', () => {
    const csp = buildCspHeader(undefined, '192.168.1.100', 3466);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ws://');
  });

  it('falls back to 3456 when port is omitted for loopback', () => {
    const csp = buildCspHeader(undefined, '127.0.0.1');
    expect(csp).toContain('ws://127.0.0.1:3456');
    expect(csp).toContain('wss://127.0.0.1:3456');
    expect(csp).toContain('ws://localhost:3456');
    expect(csp).toContain('wss://localhost:3456');
  });

  // WS-061 (inverted). This asserted that `script-src` CONTAINS
  // `'unsafe-inline'`, justified as browser-extension console-noise
  // suppression. The justification does not survive: a `content.js:…`
  // violation is the extension's own injection being blocked, which is the
  // policy working, and it never affected the app. `'unsafe-inline'` disables
  // inline-script defence for every visitor to quiet one developer's console,
  // and it is strictly BROADER than the per-extension `'sha256-…'` allowlist
  // this project already rejected on 2026-07-15.
  //
  // Verified rather than assumed before flipping: the Vite builds for webui,
  // simpleui and webui-hq contain zero inline `<script>` without `src`.
  it('keeps script-src strict — no unsafe-inline, no per-extension hashes', () => {
    const csp = buildCspHeader();
    // The rejected narrow workaround must not creep back either.
    expect(csp).not.toMatch(/'sha256-/);
    // `style-src` keeps `'unsafe-inline'` for React's runtime style mutations,
    // so assert against the script directive only.
    const scriptSrc = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src'));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
    // Shiki's WASM grammar engine requires `'wasm-unsafe-eval'` —
    // without it, every code-block in chat throws
    //   CompileError: call to WebAssembly.instantiate() blocked by CSP
    expect(scriptSrc).toMatch(/'wasm-unsafe-eval'/);
    expect(scriptSrc).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });

  it('still allows inline STYLE — inline style is not script execution', () => {
    const styleSrc = buildCspHeader()
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('style-src'));
    expect(styleSrc).toBe("style-src 'self' 'unsafe-inline'");
  });
});

describe('buildCspHeader — loopback edge cases', () => {
  it('emits bracketed IPv6 loopback entries for ::1 bind', () => {
    const csp = buildCspHeader(undefined, '::1', 3466);
    // Bracketed IPv6 literals are valid CSP host-source syntax per CSP Level 3.
    expect(csp).toContain('ws://[::1]:3466');
    expect(csp).toContain('wss://[::1]:3466');
    expect(csp).toContain('ws://127.0.0.1:3466');
    expect(csp).toContain('wss://127.0.0.1:3466');
    expect(csp).toContain('ws://localhost:3466');
    expect(csp).toContain('wss://localhost:3466');
  });

  it('emits bracketed IPv6 loopback entries for [::1] bracketed bind', () => {
    const csp = buildCspHeader(undefined, '[::1]', 3466);
    expect(csp).toContain('ws://[::1]:3466');
    expect(csp).toContain('wss://[::1]:3466');
    expect(csp).toContain('ws://127.0.0.1:3466');
    expect(csp).toContain('wss://127.0.0.1:3466');
    expect(csp).toContain('ws://localhost:3466');
    expect(csp).toContain('wss://localhost:3466');
  });

  it('does not add ws:// entries for wildcard (0.0.0.0) bind', () => {
    const csp = buildCspHeader(undefined, '0.0.0.0', 3466);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ws://');
  });

  it('skips ws:// entries when port is out of valid range (<= 0)', () => {
    const csp = buildCspHeader(undefined, '127.0.0.1', 0);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ws://');
  });

  it('skips ws:// entries when port is out of valid range (> 65535)', () => {
    const csp = buildCspHeader(undefined, '127.0.0.1', 99999);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ws://');
  });
});

describe('decodeSessionId', () => {
  it('decodes the %2F-encoded slash in a session id (regression for Fleet HQ 404s)', () => {
    // Session ids carry a literal slash (`YYYY-MM-DD/sess_<ULID>`); the frontend
    // sends it as `%2F` via encodeURIComponent. The registry is keyed by the
    // decoded id, so the route must decode before lookup — otherwise every
    // /api/sessions/:id/{events,message,agents} request 404s.
    const encoded = '2026-06-19%2Fsess_01JX2S9V7T5M6N7P8Q9R0STXVW';
    expect(decodeSessionId(encoded)).toBe('2026-06-19/sess_01JX2S9V7T5M6N7P8Q9R0STXVW');
  });

  it('passes through an already-decoded id unchanged', () => {
    expect(decodeSessionId('plain-id')).toBe('plain-id');
  });

  it('falls back to the raw segment on malformed percent-encoding (no throw)', () => {
    // A lone `%` makes decodeURIComponent throw; the helper must swallow it so
    // the caller still produces a clean 404 instead of a 500.
    expect(decodeSessionId('bad%')).toBe('bad%');
  });
});

describe('injectWsConfig', () => {
  it('injects the explicit public WS URL meta tag', () => {
    const out = injectWsConfig('<html><head><title>x</title></head><body></body></html>', {
      publicWsUrl: 'wss://wrongstack-ws.example.com/socket?x=1&y="2"',
    });
    expect(out).toContain(
      '<meta name="wrongstack-ws-url" content="wss://wrongstack-ws.example.com/socket?x=1&amp;y=&quot;2&quot;" />',
    );
  });
});

describe('createHttpServer', () => {
  it('reports the current WebUI server process memory', async () => {
    const res = await fetch(`${baseUrl}/debug/system`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const body = (await res.json()) as {
      pid: number;
      memoryUsage: { rss: number; heapUsed: number };
      heapLimit: number;
      uptime: number;
      codebaseIndexServer: { status: string; connected: boolean };
      processes: unknown[];
      timestamp: number;
    };
    expect(body.pid).toBe(process.pid);
    expect(body.memoryUsage.rss).toBeGreaterThan(0);
    expect(body.memoryUsage.heapUsed).toBeGreaterThan(0);
    expect(body.heapLimit).toBeGreaterThan(body.memoryUsage.heapUsed);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.codebaseIndexServer.status).toBeTypeOf('string');
    expect(body.codebaseIndexServer.connected).toBeTypeOf('boolean');
    expect(body.processes).toEqual([]);
    expect(body.timestamp).toBeGreaterThan(0);
  });

  it('serves index.html for / with the live WS port stamped in', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
    const html = await res.text();
    expect(html).toContain('<title>root</title>');
  });

  it('serves .js with the right MIME type', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe('console.log(1);');
  });

  it('serves Vite assets with immutable caching', async () => {
    const res = await fetch(`${baseUrl}/assets/app-deadbeef.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log(2);');
  });

  it('serves .json with application/json', async () => {
    const res = await fetch(`${baseUrl}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('rejects path-traversal attempts with 403', async () => {
    // The traversal guard is exported as `isInsideDist` so we can test
    // it directly. A black-box test via fetch or http.request is not
    // possible: WHATWG URL normalises `/../escape.txt` → `/escape.txt`
    // before the request even leaves the client, so the `..` never
    // reaches the server. The unit test below asserts the guard's
    // *contract* (the thing that actually runs in production).
    expect(isInsideDist(path.join(distDir, 'index.html'), distDir)).toBe(true);
    expect(isInsideDist(path.join(distDir, '..', 'escape.txt'), distDir)).toBe(false);
    // Also: a sibling directory with a name that *starts with* distDir's
    // name (e.g. distDir = /tmp/foo, sibling = /tmp/foo-other) must NOT
    // be accepted. The `+ path.sep` boundary check rejects that.
    const sibling = distDir + '-other';
    expect(isInsideDist(path.join(sibling, 'leak.txt'), distDir)).toBe(false);
  });

  it('falls back to index.html for SPA routes (unknown path)', async () => {
    const res = await fetch(`${baseUrl}/some/deep/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    // SPA fallback must also include the CSP — the audit found an
    // unprotected deep-link window otherwise.
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });

  it('requires token access on non-loopback binds and sets the auth cookie from ?token=', async () => {
    const token = 'test-token-123';
    const protectedServer = createHttpServer({
      host: '0.0.0.0',
      distDir,
      apiToken: token,
    });
    await new Promise<void>((resolve) => protectedServer.listen(0, '127.0.0.1', resolve));
    const addr = protectedServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    const protectedBase = `http://127.0.0.1:${addr.port}`;
    try {
      const denied = await fetch(`${protectedBase}/`);
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${protectedBase}/?token=${encodeURIComponent(token)}`);
      expect(allowed.status).toBe(200);
      const cookie = allowed.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('ws_token=');

      const api = await fetch(`${protectedBase}/api/sessions`, {
        headers: { cookie },
      });
      expect(api.status).not.toBe(401);
    } finally {
      await new Promise<void>((resolve) => protectedServer.close(() => resolve()));
    }
  });

  it('can require token access on loopback binds for public tunnels', async () => {
    const token = 'loopback-tunnel-token';
    const protectedServer = createHttpServer({
      host: '127.0.0.1',
      distDir,
      apiToken: token,
      requireToken: true,
    });
    await new Promise<void>((resolve) => protectedServer.listen(0, '127.0.0.1', resolve));
    const addr = protectedServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    const protectedBase = `http://127.0.0.1:${addr.port}`;
    try {
      const denied = await fetch(`${protectedBase}/`);
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${protectedBase}/?token=${encodeURIComponent(token)}`);
      expect(allowed.status).toBe(200);
      const html = await allowed.text();
      expect(html).toContain('<title>root</title>');
    } finally {
      await new Promise<void>((resolve) => protectedServer.close(() => resolve()));
    }
  });

  it('always sets X-Content-Type-Options=nosniff and X-Frame-Options=DENY', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});

describe('GET /api/sessions/:id/events (watch stream)', () => {
  let gRoot: string;
  let projectDir: string;
  let evServer: import('node:http').Server;
  let evBase: string;
  const sessionId = 'test-watch-1';
  const projectRoot = path.join(os.tmpdir(), 'watch-proj-fixture');

  beforeAll(async () => {
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    gRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-watch-'));

    // One live session in the registry pointing at our fixture project.
    const entry = {
      sessionId,
      projectSlug: 'fixture',
      projectName: 'Fixture',
      projectRoot,
      workingDir: projectRoot,
      status: 'active',
      clientType: 'tui',
      pid: 1234,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      agentCount: 0,
      agents: [],
    };
    await fs.writeFile(
      path.join(gRoot, 'session-registry.json'),
      JSON.stringify({ [sessionId]: entry }),
    );

    // The session's JSONL, written to the same path the handler resolves.
    const paths = resolveWstackPaths({ projectRoot, globalRoot: gRoot });
    projectDir = paths.projectDir;
    await fs.mkdir(paths.projectSessions, { recursive: true });
    const lines =
      [
        {
          type: 'session_start',
          ts: '2026-06-18T00:00:00Z',
          id: sessionId,
          model: 'm',
          provider: 'p',
        },
        { type: 'user_input', ts: '2026-06-18T00:00:01Z', content: 'hello there' },
        { type: 'tool_use', ts: '2026-06-18T00:00:02Z', name: 'read_file', id: 't1', input: {} },
        {
          type: 'llm_response',
          ts: '2026-06-18T00:00:03Z',
          content: [{ type: 'text', text: 'hi back' }],
          stopReason: 'end',
          usage: {},
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n';
    await fs.writeFile(path.join(paths.projectSessions, `${sessionId}.jsonl`), lines);

    evServer = createHttpServer({ host: '127.0.0.1', distDir, globalRoot: gRoot });
    await new Promise<void>((resolve) => evServer.listen(0, '127.0.0.1', resolve));
    const addr = evServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    evBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => evServer.close(() => resolve()));
    // Posting a message starts the project's detached mailbox owner, which
    // keeps `<gRoot>/projects/<slug>/_mailbox.sqlite` open; leave it running
    // and the rm below blocks on EBUSY past the hook timeout.
    const { disposeProjectMailbox, removeMailboxTempRoot } = await import(
      './helpers/mailbox-daemon.js'
    );
    await disposeProjectMailbox(projectDir);
    await removeMailboxTempRoot(gRoot);
  });

  it('replays a session into compact watch entries (user / tool / assistant)', async () => {
    const res = await fetch(`${evBase}/api/sessions/${sessionId}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      clientType?: string;
      entries: Array<{ role: string; text: string; tool?: string }>;
    };
    expect(body.sessionId).toBe(sessionId);
    expect(body.clientType).toBe('tui');
    const roles = body.entries.map((e) => e.role);
    expect(roles).toContain('user');
    expect(roles).toContain('tool');
    expect(roles).toContain('assistant');
    expect(body.entries.find((e) => e.role === 'user')?.text).toContain('hello there');
    expect(body.entries.find((e) => e.role === 'tool')?.tool).toBe('read_file');
    expect(body.entries.find((e) => e.role === 'assistant')?.text).toContain('hi back');
  });

  it('404s an unknown session', async () => {
    const res = await fetch(`${evBase}/api/sessions/does-not-exist/events`);
    expect(res.status).toBe(404);
  });

  it('POST .../message delivers a steer message to the session mailbox', async () => {
    const { mailboxSessionTag, createProjectMailbox } = await import(
      '@wrongstack/core/coordination'
    );
    const { resolveWstackPaths } = await import('@wrongstack/core/utils');
    const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'please run the tests' }),
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { to: string };
    const tag = mailboxSessionTag(sessionId);
    expect(out.to).toBe(`leader@${tag}`);

    // It must actually land in the project mailbox the target session reads.
    const paths = resolveWstackPaths({ projectRoot, globalRoot: gRoot });
    const mailbox = createProjectMailbox({
      projectDir: paths.projectDir,
      isolatedConnection: true,
    });
    const msgs = await mailbox.query({ to: `leader@${tag}` });
    expect(msgs.some((m) => m.body === 'please run the tests' && m.type === 'steer')).toBe(true);
  });

  it('POST .../message 400s on empty text', async () => {
    const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST .../message 404s an unknown session', async () => {
    const res = await fetch(`${evBase}/api/sessions/nope/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  // ── WS-001: CSRF / drive-by boundary ────────────────────────────────
  // The HTTP surface had no Origin, Host, or Content-Type check and needs no
  // token on the loopback default, so a `text/plain` POST from any website the
  // user was browsing reached /api/* as a CORS simple request.
  describe('cross-origin request guard', () => {
    it('rejects a POST carrying a foreign Origin', async () => {
      const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ text: 'attacker steer' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects a POST from another loopback port', async () => {
      const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:9999' },
        body: JSON.stringify({ text: 'attacker steer' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects the opaque "null" Origin', async () => {
      const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'null' },
        body: JSON.stringify({ text: 'attacker steer' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects a GET carrying a foreign Origin', async () => {
      const res = await fetch(`${evBase}/api/sessions`, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
    });

    it('accepts a same-origin POST', async () => {
      const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: evBase },
        body: JSON.stringify({ text: 'legitimate steer' }),
      });
      expect(res.status).toBe(200);
    });

    it('rejects a text/plain body — the CORS simple-request content type', async () => {
      const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ text: 'simple request' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a form-encoded body', async () => {
      const res = await fetch(`${evBase}/api/sessions/${sessionId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'text=simple',
      });
      expect(res.status).toBe(400);
    });
  });
});
