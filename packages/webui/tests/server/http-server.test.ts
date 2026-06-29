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
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCspHeader,
  createHttpServer,
  decodeSessionId,
  injectWsConfig,
  injectWsPort,
  isInsideDist,
} from '../../src/server/http-server.js';

let distDir: string;
let server: import('node:http').Server;
let baseUrl: string;

beforeAll(async () => {
  // Build a tiny distDir with one .html, one .js, and one .json file.
  distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-http-'));
  await fs.writeFile(
    path.join(distDir, 'index.html'),
    '<!doctype html><title>root</title>',
  );
  await fs.writeFile(path.join(distDir, 'app.js'), 'console.log(1);');
  await fs.writeFile(
    path.join(distDir, 'manifest.json'),
    '{"name":"test"}',
  );

  server = createHttpServer({ host: '127.0.0.1', distDir, wsPort: 9999 });
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
  it('embeds the WS port in connect-src and pins the policy', () => {
    const csp = buildCspHeader(3457);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('ws://127.0.0.1:3457');
    expect(csp).toContain('wss://127.0.0.1:3457');
    expect(csp).not.toContain('[::1]');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('allows the request host for remote/tunnel access', () => {
    const csp = buildCspHeader(3457, 'wrongstack.example.com');
    expect(csp).toContain('ws://wrongstack.example.com:3457');
    expect(csp).toContain('wss://wrongstack.example.com:3457');
  });

  it('allows an explicit public WebSocket URL for tunnel access', () => {
    const csp = buildCspHeader(3457, undefined, 'wss://wrongstack-ws.example.com/ws');
    expect(csp).toContain('wss://wrongstack-ws.example.com');
  });

  it('allow-lists inline-script hashes so browser-extension content scripts can run', () => {
    // Regression: a strict `script-src 'self'` blocks Chrome extension
    // content-script bootstraps (the browser reports them from `content.js:74:196`
    // with the sha256 of the offending inline bytes). Without these hashes
    // allow-listed, extensions that page-inject scripts (password managers,
    // dark-mode readers, dev helpers) silently fail — which in turn breaks
    // unrelated UI flows and was reported as a "WebSocket won't connect"
    // symptom because the extension's bootstrap is what wires up the WS.
    const csp = buildCspHeader(3457);
    expect(csp).toContain("'sha256-6PXDy0zrpXa6mvYOl11bZ8nubNUL7ushPUhGDZtaexg='");
    expect(csp).toContain("'sha256-6sIdwbEBx7jj0drqSHHm7MqvmoYD3CQ4lp8Zp8blcb0='");
    // The WrongStack app itself ships no inline scripts, so `script-src`
    // must NOT regress to `'unsafe-inline'` (which would re-open XSS for
    // any future first-party code that ever needs an inline script).
    // `style-src` is allowed to keep `'unsafe-inline'` for React's runtime
    // style mutations — assert against the script directive only.
    const scriptSrc = csp
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('script-src'));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toMatch(/'unsafe-inline'/);
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

describe('injectWsPort', () => {
  it('injects a meta tag before </head> when present', () => {
    const out = injectWsPort('<html><head><title>x</title></head><body></body></html>', 3557);
    expect(out).toContain('<meta name="wrongstack-ws-port" content="3557" />');
    // Must land inside the head, before the closing tag.
    expect(out.indexOf('wrongstack-ws-port')).toBeLessThan(out.indexOf('</head>'));
  });

  it('prepends the meta tag when there is no </head>', () => {
    const out = injectWsPort('<!doctype html><title>x</title>', 3557);
    expect(out).toContain('<meta name="wrongstack-ws-port" content="3557" />');
    expect(out).toContain('<title>x</title>');
  });

  it('is idempotent — never injects twice', () => {
    const once = injectWsPort('<head></head>', 3557);
    const twice = injectWsPort(once, 9999);
    expect(twice).toBe(once);
    expect(twice.match(/wrongstack-ws-port/g)).toHaveLength(1);
  });
});

describe('injectWsConfig', () => {
  it('injects the live WS port and explicit public WS URL', () => {
    const out = injectWsConfig('<html><head><title>x</title></head><body></body></html>', {
      wsPort: 3557,
      publicWsUrl: 'wss://wrongstack-ws.example.com/socket?x=1&y="2"',
    });
    expect(out).toContain('<meta name="wrongstack-ws-port" content="3557" />');
    expect(out).toContain(
      '<meta name="wrongstack-ws-url" content="wss://wrongstack-ws.example.com/socket?x=1&amp;y=&quot;2&quot;" />',
    );
  });
});

describe('createHttpServer', () => {
  it('serves index.html for / with the live WS port stamped in', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('content-security-policy')).toContain('ws://127.0.0.1:9999');
    const html = await res.text();
    expect(html).toContain('<title>root</title>');
    // The frontend reads this to dial THIS instance's backend (multi-instance).
    expect(html).toContain('<meta name="wrongstack-ws-port" content="9999" />');
  });

  it('serves .js with the right MIME type', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(await res.text()).toBe('console.log(1);');
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
    expect(isInsideDist(path.join(distDir, '..', 'escape.txt'), distDir)).toBe(
      false,
    );
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
    expect(res.headers.get('content-security-policy')).toContain('ws://127.0.0.1:9999');
  });

  it('requires token access on non-loopback binds and sets the auth cookie from ?token=', async () => {
    const token = 'test-token-123';
    const protectedServer = createHttpServer({
      host: '0.0.0.0',
      distDir,
      wsPort: 9997,
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
      wsPort: 9996,
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
      expect(await allowed.text()).toContain('<meta name="wrongstack-ws-port" content="9996" />');
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
  let evServer: import('node:http').Server;
  let evBase: string;
  const sessionId = 'test-watch-1';
  const projectRoot = path.join(os.tmpdir(), 'watch-proj-fixture');

  beforeAll(async () => {
    const { resolveWstackPaths } = await import('@wrongstack/core');
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
    await fs.mkdir(paths.projectSessions, { recursive: true });
    const lines =
      [
        { type: 'session_start', ts: '2026-06-18T00:00:00Z', id: sessionId, model: 'm', provider: 'p' },
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

    evServer = createHttpServer({ host: '127.0.0.1', distDir, wsPort: 9998, globalRoot: gRoot });
    await new Promise<void>((resolve) => evServer.listen(0, '127.0.0.1', resolve));
    const addr = evServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad listen address');
    evBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => evServer.close(() => resolve()));
    await fs.rm(gRoot, { recursive: true, force: true });
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
    const { mailboxSessionTag, GlobalMailbox, resolveWstackPaths } = await import(
      '@wrongstack/core'
    );
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
    const mailbox = new GlobalMailbox(paths.projectDir);
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
});
