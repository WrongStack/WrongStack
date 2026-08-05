/**
 * OAuth login-module coverage — openai-codex-oauth.ts, anthropic-oauth.ts,
 * github-copilot-oauth.ts, and the shared loopback-server.ts.
 *
 * Strategy:
 *  - loopback-server.ts is exercised for REAL (binds 127.0.0.1, drives the
 *    callback with real HTTP requests) — it is the "stubbed local callback
 *    server" the browser flows redirect to.
 *  - The OAuth flows use the REAL loopback server too; only the external
 *    provider endpoints (token exchange, models listing, device code) are
 *    stubbed via a global-fetch router that falls through to real fetch for
 *    loopback URLs. The authorization-code `state` is parsed from the
 *    authorize URL the renderer logs, so the test can fire a valid callback.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthMenuDeps } from '../src/auth-menu/types.js';
import {
  buildAuthorizeUrl as buildCodexAuthorizeUrl,
  exchangeAuthorizationCode as exchangeCodex,
  extractAccountId,
  fallbackCodexModelIds,
  fetchCodexModels,
  filterCurrentCodexModelIds,
  generatePkce as generateCodexPkce,
  isCodexCatalogModel,
  parseAuthorizationInput as parseCodexInput,
  refreshCodexToken,
  resolveCodexModels,
  runCodexOAuthLogin,
} from '../src/auth-menu/openai-codex-oauth.js';
import {
  buildAuthorizeUrl as buildClaudeAuthorizeUrl,
  exchangeAuthorizationCode as exchangeClaude,
  generatePkce as generateClaudePkce,
  parseAuthorizationInput as parseClaudeInput,
  runClaudeOAuthLogin,
} from '../src/auth-menu/anthropic-oauth.js';
import {
  isUsableCopilotChatModel,
  pollForGitHubToken,
  runCopilotOAuthLogin,
  startDeviceFlow,
} from '../src/auth-menu/github-copilot-oauth.js';
import {
  callbackHtml,
  openBrowser,
  startLoopbackServer,
} from '../src/auth-menu/loopback-server.js';

// ── Shared helpers ──────────────────────────────────────────────────────────

async function setup(opts: { registry?: ModelsRegistry; preExisting?: object } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-auth-oauth-'));
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const registry: ModelsRegistry =
    opts.registry ??
    ({
      getProvider: vi.fn(async () => undefined),
      listProviders: vi.fn(async () => []),
      suggestModel: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
    } as never as ModelsRegistry);
  return { configPath, vault, registry, tmpDir };
}

/** AuthMenuDeps with a captured log + scripted reader (shared answer queue). */
function depsFor(
  configPath: string,
  vault: DefaultSecretVault,
  registry: ModelsRegistry,
  answers: Array<string | Error | Promise<string>> = [],
) {
  const logs: string[] = [];
  let i = 0;
  const next = async () => {
    const a = answers[i++];
    if (a instanceof Error) throw a;
    return (await a) ?? '';
  };
  const deps: AuthMenuDeps = {
    renderer: {
      write: (s: string) => logs.push(s),
      writeInfo: (s: string) => logs.push(s),
      writeWarning: (s: string) => logs.push(s),
      writeError: (s: string) => logs.push(s),
    },
    reader: {
      readLine: async () => next(),
      readSecret: async () => next(),
    },
    modelsRegistry: registry,
    vault,
    profileConfigPath: configPath,
  };
  return { deps, logs };
}

/** Poll the renderer log until a URL containing `needle` appears; return it. */
async function waitForUrl(logs: string[], needle: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const line = logs.find((l) => l.includes(needle));
    if (line) {
      const m = line.match(/https?:\/\/[^\s\x1b]+/);
      if (m) return m[0];
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no "${needle}" URL in renderer log`);
}

/** Extract the loopback port + state from the logged authorize URL. */
function callbackTarget(authorizeUrl: string): { port: number; state: string } {
  const url = new URL(authorizeUrl);
  const redirectUri = url.searchParams.get('redirect_uri')!;
  return {
    port: Number(new URL(redirectUri).port),
    state: url.searchParams.get('state')!,
  };
}
function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

const ACCOUNT_JWT = jwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
});

/** Fire a real loopback callback and return the server's HTTP response body. */
async function fireCallback(port: number, callbackPath: string, query: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${callbackPath}?${query}`);
  await res.arrayBuffer(); // drain
  return res.status;
}

// ── Global fetch router (external endpoints only) ──────────────────────────

type Route = { matcher: (url: string) => boolean; response: () => Response };

let realFetch: typeof fetch;
let routes: Route[];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  for (const r of routes) {
    if (r.matcher(url)) return r.response();
  }
  return realFetch(input, init);
}

function route(substr: string, response: () => Response): void {
  routes.push({ matcher: (url) => url.includes(substr), response });
}

function tokenBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: ACCOUNT_JWT,
    refresh_token: 'refresh-1',
    expires_in: 86_400,
    id_token: ACCOUNT_JWT,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  realFetch = globalThis.fetch;
  routes = [];
  vi.stubGlobal('fetch', stubFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── loopback-server.ts (real HTTP) ──────────────────────────────────────────

describe('loopback-server.ts — real loopback callback server', () => {
  it('callbackHtml renders success and failure pages with escaped messages', () => {
    const ok = callbackHtml(true, 'Done <script>alert(1)</script>');
    expect(ok).toContain('Authentication successful');
    expect(ok).toContain('&lt;script&gt;');
    const fail = callbackHtml(false, 'Nope');
    expect(fail).toContain('Authentication failed');
  });

  it('openBrowser is best-effort and never throws', () => {
    expect(() => openBrowser('https://example.com/auth')).not.toThrow();
  });

  it('resolves waitForCode with code+state on a valid callback', async () => {
    const server = await startLoopbackServer('state-1', [0], undefined, '/auth/callback', '127.0.0.1');
    expect(server.bound).toBe(true);
    const status = await fireCallback(server.port, '/auth/callback', 'code=abc123&state=state-1');
    expect(status).toBe(200);
    await expect(server.waitForCode()).resolves.toEqual({ code: 'abc123', state: 'state-1' });
    server.close();
  });

  it('uses the default callback path and host', async () => {
    const server = await startLoopbackServer('s2', [0]);
    expect(server.bound).toBe(true);
    expect(await fireCallback(server.port, '/auth/callback', 'code=c&state=s2')).toBe(200);
    await expect(server.waitForCode()).resolves.toEqual({ code: 'c', state: 's2' });
    server.close();
  });

  it('404s unknown paths with a static error page and keeps waiting', async () => {
    const server = await startLoopbackServer('s3', [0]);
    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Callback route not found.');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    server.close();
  });

  it('resolves null on the provider error param', async () => {
    const server = await startLoopbackServer('s4', [0]);
    expect(await fireCallback(server.port, '/auth/callback', 'error=access_denied')).toBe(400);
    await expect(server.waitForCode()).resolves.toBeNull();
    server.close();
  });

  it('resolves null on a state mismatch', async () => {
    const server = await startLoopbackServer('s5', [0]);
    expect(await fireCallback(server.port, '/auth/callback', 'code=c&state=WRONG')).toBe(400);
    await expect(server.waitForCode()).resolves.toBeNull();
    server.close();
  });

  it('400s a missing code but keeps waiting', async () => {
    const server = await startLoopbackServer('s6', [0]);
    expect(await fireCallback(server.port, '/auth/callback', 'state=s6')).toBe(400);
    server.close();
  });

  it('an already-aborted signal resolves null and closes', async () => {
    const ac = new AbortController();
    ac.abort();
    const server = await startLoopbackServer('s7', [0], ac.signal);
    await expect(server.waitForCode()).resolves.toBeNull();
    server.close();
  });

  it('aborting during the wait resolves null', async () => {
    const ac = new AbortController();
    const server = await startLoopbackServer('s8', [0], ac.signal);
    const pending = server.waitForCode();
    ac.abort();
    await expect(pending).resolves.toBeNull();
    server.close();
  });

  it('falls through to the next port when the first is busy', async () => {
    const blocker = await startLoopbackServer('block', [0]);
    const server = await startLoopbackServer('s9', [blocker.port, 0]);
    expect(server.bound).toBe(true);
    expect(server.port).not.toBe(blocker.port);
    server.close();
    blocker.close();
  });

  it('reports bound=false when every port is busy', async () => {
    const blockerA = await startLoopbackServer('a', [0]);
    const blockerB = await startLoopbackServer('b', [0]);
    const server = await startLoopbackServer('s10', [blockerA.port, blockerB.port]);
    expect(server.bound).toBe(false);
    expect(server.port).toBe(blockerA.port);
    await expect(server.waitForCode()).resolves.toBeNull();
    server.close();
    blockerA.close();
    blockerB.close();
  });

  it('close() unblocks a pending wait with null', async () => {
    const server = await startLoopbackServer('s11', [0]);
    const pending = server.waitForCode();
    server.close();
    await expect(pending).resolves.toBeNull();
  });
});

// ── openai-codex-oauth.ts ───────────────────────────────────────────────────

describe('openai-codex-oauth.ts — pure helpers', () => {
  it('generatePkce returns a verifier with a matching S256 challenge', () => {
    const { verifier, challenge } = generateCodexPkce();
    const expected = Buffer.from(createHash('sha256').update(verifier).digest())
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('buildAuthorizeUrl carries all Codex params and the redirect port', () => {
    const url = new URL(buildCodexAuthorizeUrl('ch', 'st', 9999));
    expect(url.searchParams.get('client_id')).toBeTruthy();
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:9999/auth/callback');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('originator')).toBe('wrongstack');
  });

  it('extractAccountId reads the claim from a JWT and rejects malformed tokens', () => {
    expect(extractAccountId(ACCOUNT_JWT)).toBe('acct-123');
    expect(extractAccountId('not-a-jwt')).toBeNull();
    expect(extractAccountId(jwt({ sub: 'x' }))).toBeNull();
    expect(
      extractAccountId(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } })),
    ).toBeNull();
  });

  it('parseAuthorizationInput handles URLs, query strings, and raw codes', () => {
    expect(parseCodexInput('http://localhost:1455/auth/callback?code=C&state=S')).toEqual({
      code: 'C',
      state: 'S',
    });
    expect(parseCodexInput('code=C&state=S')).toEqual({ code: 'C', state: 'S' });
    expect(parseCodexInput('  raw-code  ')).toEqual({ code: 'raw-code' });
    expect(parseCodexInput('   ')).toEqual({});
  });

  it('fallback model helpers return the canonical Codex list', () => {
    expect(fallbackCodexModelIds().length).toBeGreaterThan(0);
    expect(filterCurrentCodexModelIds(['nope', fallbackCodexModelIds()[0]!])).toEqual([
      fallbackCodexModelIds()[0],
    ]);
    expect(isCodexCatalogModel({ family: 'gpt-codex' })).toBe(true);
    expect(isCodexCatalogModel({ family: 'openai' })).toBe(false);
    expect(isCodexCatalogModel({})).toBe(false);
  });

  it('fetchCodexModels parses data/models shapes and fails soft', async () => {
    route('backend-api/models', () => jsonResponse({ data: [{ id: 'gpt-x' }, { id: '' }] }));
    await expect(fetchCodexModels('t')).resolves.toEqual(['gpt-x']);
    routes = [];
    route('backend-api/models', () => jsonResponse({ models: [{ id: 'gpt-y' }] }));
    await expect(fetchCodexModels('t')).resolves.toEqual(['gpt-y']);
    routes = [];
    route('backend-api/models', () => jsonResponse({ nope: true }));
    await expect(fetchCodexModels('t')).resolves.toEqual([]);
    routes = [];
    route('backend-api/models', () => new Response(null, { status: 500 }));
    await expect(fetchCodexModels('t')).resolves.toEqual([]);
  });

  it('resolveCodexModels tiers: live backend, catalog, then fallback', async () => {
    const current = fallbackCodexModelIds()[0]!;
    const registry: ModelsRegistry = {
      getProvider: vi.fn(async () => undefined),
    } as never as ModelsRegistry;

    route('backend-api/models', () => jsonResponse({ data: [{ id: current }] }));
    await expect(resolveCodexModels(registry, 'tok')).resolves.toEqual([current]);

    routes = [];
    route('backend-api/models', () => jsonResponse({ data: [] }));
    const withCatalog = {
      getProvider: vi.fn(async () => ({
        models: [{ id: current, family: 'gpt-codex' }, { id: 'old', family: 'gpt-codex' }],
      })),
    } as never as ModelsRegistry;
    await expect(resolveCodexModels(withCatalog, Promise.resolve('tok'))).resolves.toEqual([current]);

    routes = [];
    route('backend-api/models', () => new Response(null, { status: 500 }));
    await expect(resolveCodexModels(registry, 'tok')).resolves.toEqual(fallbackCodexModelIds());
  });

  it('exchangeAuthorizationCode parses tokens and raises Fetch/Parse errors', async () => {
    route('auth.openai.com/oauth/token', () => jsonResponse(tokenBody({ access_token: 'plain' })));
    const tokens = await exchangeCodex('code', 'verifier');
    expect(tokens.access).toBe('plain');
    expect(tokens.expires).toBeGreaterThan(0);

    routes = [];
    route('auth.openai.com/oauth/token', () => jsonResponse({ error: 'bad' }, 400));
    await expect(exchangeCodex('c', 'v')).rejects.toThrow(/Codex token exchange failed \(400\)/);

    routes = [];
    route('auth.openai.com/oauth/token', () => jsonResponse({ foo: 1 }));
    await expect(exchangeCodex('c', 'v')).rejects.toThrow(/response missing fields/);
  });

  it('refreshCodexToken returns fresh tokens', async () => {
    route('auth.openai.com/oauth/token', () => jsonResponse(tokenBody()));
    const tokens = await refreshCodexToken('rt');
    expect(tokens.refresh).toBe('refresh-1');
  });
});

describe('openai-codex-oauth.ts — runCodexOAuthLogin flow', () => {
  function codexRoutes(over: Record<string, unknown> = {}): void {
    route('auth.openai.com/oauth/token', () => jsonResponse(tokenBody(over)));
    route('backend-api/models', () =>
      jsonResponse({ data: fallbackCodexModelIds().map((id) => ({ id })) }),
    );
  }

  it('signs in via the real loopback callback and saves OAuth tokens', async () => {
    codexRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { providerId: 'codex-test', signal: ac.signal });
    const { port, state } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    expect(await fireCallback(port, '/auth/callback', `code=cb-1&state=${state}`)).toBe(200);
    expect(await flow).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const p = (raw.providers as Record<string, Record<string, unknown>>)['codex-test']!;
    expect(p.family).toBe('openai-codex');
    expect(p.baseUrl).toBe('https://chatgpt.com/backend-api');
    expect((p.models as string[]).length).toBeGreaterThan(0);
    expect((p.apiKeys as Array<{ label: string; authMethod: string }>)[0]).toMatchObject({
      label: 'oauth-default',
      authMethod: 'oauth',
    });
    expect(logs.some((l) => l.includes('Signed in with ChatGPT'))).toBe(true);
  });

  it('falls back to manual paste when both callback ports are busy', async () => {
    codexRoutes();
    // The flow hardcodes ports [1455, 1457] — occupy both to force bound=false.
    const dummy1455 = await startLoopbackServer('dummy-1455', [1455]);
    const dummy1457 = await startLoopbackServer('dummy-1457', [1457]);
    try {
      const { configPath, vault, registry } = await setup();
      const { deps, logs } = depsFor(configPath, vault, registry);
      const ac = new AbortController();
      const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
      const { port } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
      expect(port).toBe(1455); // both callback ports busy → paste fallback on the default port
      // flow2's state is only known after its URL renders — defer the paste answer.
      let resolvePaste!: (v: string) => void;
      const paste = new Promise<string>((r) => {
        resolvePaste = r;
      });
      const { deps: deps2, logs: logs2 } = depsFor(configPath, vault, registry, [paste]);
      const flow2 = runCodexOAuthLogin(deps2, { signal: ac.signal });
      const url2 = await waitForUrl(logs2, 'auth.openai.com');
      expect(callbackTarget(url2).port).toBe(1455);
      resolvePaste(
        `http://localhost:1455/auth/callback?code=cb-paste&state=${callbackTarget(url2).state}`,
      );
      expect(await flow2).toBe(0);
      expect(await flow).toBe(1); // first flow cancelled at its own paste prompt (no answers)
    } finally {
      dummy1455.close();
      dummy1457.close();
    }
  });

  it('q at the paste prompt cancels', async () => {
    codexRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry, ['q']);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
    const { port } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    // Mismatched state → server resolves null → flow drops to the paste prompt.
    await fireCallback(port, '/auth/callback', 'code=x&state=WRONG');
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('Cancelled.'))).toBe(true);
  });

  it('rejects a pasted URL whose state mismatches', async () => {
    codexRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry, [
      'http://localhost:1455/auth/callback?code=c&state=WRONG',
    ]);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
    const { port } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    await fireCallback(port, '/auth/callback', 'code=x&state=WRONG');
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('State mismatch'))).toBe(true);
  });

  it('reports when no code was received', async () => {
    codexRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry, ['code=']);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
    const { port } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    await fireCallback(port, '/auth/callback', 'code=x&state=WRONG');
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('No authorization code received.'))).toBe(true);
  });

  it('surfaces a token-exchange failure', async () => {
    route('auth.openai.com/oauth/token', () => jsonResponse({ error: 'denied' }, 400));
    route('backend-api/models', () => jsonResponse({ data: [] }));
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
    const { port, state } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    await fireCallback(port, '/auth/callback', `code=c&state=${state}`);
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('Login failed: Codex token exchange failed'))).toBe(true);
  });

  it('fails when the token has no ChatGPT account id', async () => {
    codexRoutes({ access_token: 'plain-token', id_token: undefined });
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
    const { port, state } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    await fireCallback(port, '/auth/callback', `code=c&state=${state}`);
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('no ChatGPT account id'))).toBe(true);
  });

  it('cancels cleanly when the external signal is already aborted', async () => {
    codexRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    ac.abort();
    expect(await runCodexOAuthLogin(deps, { signal: ac.signal })).toBe(1);
    expect(logs.some((l) => l.includes('Cancelled.'))).toBe(true);
  });

  it('reports a token-save failure', async () => {
    codexRoutes();
    // Point the config at a directory so the atomic mutate throws.
    const { tmpDir, vault, registry } = await setup();
    const configPath = path.join(tmpDir, 'not-a-file');
    await fs.mkdir(configPath, { recursive: true });
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runCodexOAuthLogin(deps, { signal: ac.signal });
    const { port, state } = callbackTarget(await waitForUrl(logs, 'auth.openai.com'));
    await fireCallback(port, '/auth/callback', `code=c&state=${state}`);
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('Failed to save tokens'))).toBe(true);
  });
});

// ── anthropic-oauth.ts ──────────────────────────────────────────────────────

describe('anthropic-oauth.ts — pure helpers', () => {
  it('builds the Claude authorize URL with code=true and verifier-as-state', () => {
    const url = new URL(buildClaudeAuthorizeUrl('ch', 'ver'));
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('state')).toBe('ver');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback');
  });

  it('parseAuthorizationInput handles URLs, fragments, query strings, raw codes', () => {
    expect(parseClaudeInput('http://localhost:53692/callback?code=C&state=S')).toEqual({
      code: 'C',
      state: 'S',
    });
    expect(parseClaudeInput('code=C#state=S')).toEqual({ code: 'code=C', state: 'state=S' });
    expect(parseClaudeInput('code=C&state=S')).toEqual({ code: 'C', state: 'S' });
    expect(parseClaudeInput('raw')).toEqual({ code: 'raw' });
    expect(parseClaudeInput('')).toEqual({});
  });

  it('exchangeAuthorizationCode posts JSON and parses tokens', async () => {
    route('platform.claude.com/v1/oauth/token', () =>
      jsonResponse({ access_token: 'ac', refresh_token: 'rf', expires_in: 3600 }),
    );
    const tokens = await exchangeClaude('c', 's', 'v');
    expect(tokens.access).toBe('ac');
    expect(tokens.expires).toBeGreaterThan(0);

    routes = [];
    route('platform.claude.com/v1/oauth/token', () => jsonResponse({ error: 1 }, 401));
    await expect(exchangeClaude('c', 's', 'v')).rejects.toThrow(/Claude token exchange failed \(401\)/);
  });
});

describe('anthropic-oauth.ts — runClaudeOAuthLogin flow', () => {
  function claudeRoutes(models: unknown = { data: [{ id: 'claude-sonnet-4-6' }, { id: 'gpt-4o' }] }): void {
    route('platform.claude.com/v1/oauth/token', () =>
      jsonResponse({ access_token: 'ac', refresh_token: 'rf', expires_in: 3600 }),
    );
    route('/v1/models', () => jsonResponse(models));
  }

  it('signs in via the real loopback callback and saves OAuth tokens', async () => {
    claudeRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runClaudeOAuthLogin(deps, { providerId: 'claude-oauth-test', signal: ac.signal });
    const { port, state } = callbackTarget(await waitForUrl(logs, 'claude.ai'));
    expect(await fireCallback(port, '/callback', `code=cb&state=${state}`)).toBe(200);
    expect(await flow).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const p = (raw.providers as Record<string, Record<string, unknown>>)['claude-oauth-test']!;
    expect(p.family).toBe('anthropic-oauth');
    expect(p.baseUrl).toBe('https://api.anthropic.com');
    // Only claude-* ids survive the filter.
    expect(p.models).toEqual(['claude-sonnet-4-6']);
    expect((p.apiKeys as Array<{ label: string; authMethod: string }>)[0]).toMatchObject({
      label: 'oauth-default',
      authMethod: 'oauth',
    });
  });

  it('saves without a model list when the models fetch fails', async () => {
    claudeRoutes(new Response(null, { status: 500 }));
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runClaudeOAuthLogin(deps, { signal: ac.signal });
    const { port, state } = callbackTarget(await waitForUrl(logs, 'claude.ai'));
    await fireCallback(port, '/callback', `code=cb&state=${state}`);
    expect(await flow).toBe(0);
    expect(logs.some((l) => l.includes('No model list was discovered'))).toBe(true);
  });

  it('cancels at the paste prompt with q', async () => {
    claudeRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry, ['q']);
    const ac = new AbortController();
    const flow = runClaudeOAuthLogin(deps, { signal: ac.signal });
    const { port } = callbackTarget(await waitForUrl(logs, 'claude.ai'));
    await fireCallback(port, '/callback', 'code=x&state=WRONG');
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('Cancelled.'))).toBe(true);
  });

  it('rejects a pasted URL whose state mismatches', async () => {
    claudeRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry, [
      'http://localhost:53692/callback?code=c&state=WRONG',
    ]);
    const ac = new AbortController();
    const flow = runClaudeOAuthLogin(deps, { signal: ac.signal });
    const { port } = callbackTarget(await waitForUrl(logs, 'claude.ai'));
    await fireCallback(port, '/callback', 'code=x&state=WRONG');
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('State mismatch'))).toBe(true);
  });
});

// ── github-copilot-oauth.ts ─────────────────────────────────────────────────

describe('github-copilot-oauth.ts — pure helpers', () => {
  const CHAT = {
    id: 'gpt-4o',
    capabilities: { type: 'chat', supports: { tool_calls: true } },
  };
  const pick = (over: Record<string, unknown>) => ({ ...CHAT, ...over });

  it('isUsableCopilotChatModel accepts a real chat model and rejects every edge', () => {
    expect(isUsableCopilotChatModel(CHAT)).toBe(true);
    expect(isUsableCopilotChatModel({ id: '' })).toBe(false);
    expect(isUsableCopilotChatModel(pick({ capabilities: { type: 'embeddings' } }))).toBe(false);
    expect(
      isUsableCopilotChatModel(pick({ capabilities: { type: 'chat', supports: { tool_calls: false } } })),
    ).toBe(false);
    expect(
      isUsableCopilotChatModel(pick({ supported_endpoints: ['/responses'] })),
    ).toBe(false);
    expect(isUsableCopilotChatModel(pick({ policy: { state: 'disabled' } }))).toBe(false);
    expect(isUsableCopilotChatModel(pick({ vendor: 'Experimental' }))).toBe(false);
  });

  it('startDeviceFlow validates the device-code response', async () => {
    const device = {
      device_code: 'dc',
      user_code: 'UC-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
    };
    route('github.com/login/device/code', () => jsonResponse(device));
    const got = await startDeviceFlow();
    expect(got).toMatchObject(device);
    expect(got.interval).toBe(5); // default

    routes = [];
    route('github.com/login/device/code', () => new Response(null, { status: 403 }));
    await expect(startDeviceFlow()).rejects.toThrow(/device-code request failed \(403\)/);

    routes = [];
    route('github.com/login/device/code', () => jsonResponse({ nope: true }));
    await expect(startDeviceFlow()).rejects.toThrow(/Invalid device-code response/);
  });

  it('pollForGitHubToken handles pending, slow_down, error, and expiry', async () => {
    const device = { device_code: 'dc', interval: 0, expires_in: 900 } as never;
    let poll = 0;
    routes = [];
    route('github.com/login/oauth/access_token', () => {
      poll += 1;
      if (poll === 1) return jsonResponse({ error: 'authorization_pending' });
      if (poll === 2) return jsonResponse({ error: 'slow_down' });
      return jsonResponse({ access_token: 'gh-tok' });
    });
    await expect(pollForGitHubToken(device, new AbortController().signal)).resolves.toBe('gh-tok');
    expect(poll).toBe(3);

    routes = [];
    route('github.com/login/oauth/access_token', () => jsonResponse({ error: 'invalid_grant' }));
    await expect(pollForGitHubToken(device, new AbortController().signal)).rejects.toThrow(
      /Device flow failed: invalid_grant/,
    );

    routes = [];
    // Keep the loop busy until the (1ms) expiry window passes.
    route('github.com/login/oauth/access_token', () =>
      jsonResponse({ error: 'authorization_pending' }),
    );
    const expired = { device_code: 'dc', interval: 0, expires_in: 1 } as never;
    await expect(pollForGitHubToken(expired, new AbortController().signal)).rejects.toThrow(
      /Device code expired/,
    );
  });
});

describe('github-copilot-oauth.ts — runCopilotOAuthLogin flow', () => {
  function copilotRoutes(models: unknown = { data: [{ id: 'gpt-4o', capabilities: { type: 'chat', supports: { tool_calls: true } } }] }): void {
    route('github.com/login/device/code', () =>
      jsonResponse({
        device_code: 'dc',
        user_code: 'UC-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 900,
      }),
    );
    route('github.com/login/oauth/access_token', () => jsonResponse({ access_token: 'gh-tok' }));
    route('api.github.com/copilot_internal/v2/token', () =>
      jsonResponse({ token: 'copilot-tok', expires_at: 9_999_999_999 }),
    );
    route('/models', () => jsonResponse(models));
  }

  it('signs in via the device flow and saves OAuth tokens + models', async () => {
    copilotRoutes();
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    expect(await runCopilotOAuthLogin(deps, { providerId: 'copilot-test', signal: ac.signal })).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const p = (raw.providers as Record<string, Record<string, unknown>>)['copilot-test']!;
    expect(p.family).toBe('github-copilot');
    expect(p.baseUrl).toBe('https://api.individual.githubcopilot.com');
    expect(p.models).toEqual(['gpt-4o']);
    const entry = (p.apiKeys as Array<{ label: string; refreshToken: string }>)[0]!;
    expect(entry.label).toBe('oauth-default');
    expect(entry.refreshToken).toMatch(/^enc:v1:/); // encrypted at rest
    expect(logs.some((l) => l.includes('Signed in with GitHub Copilot'))).toBe(true);
  });

  it('falls back to gpt-4o when no usable models are discovered', async () => {
    copilotRoutes({ data: [{ id: 'embed-x', capabilities: { type: 'embeddings' } }] });
    const { configPath, vault, registry } = await setup();
    const { deps } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    expect(await runCopilotOAuthLogin(deps, { signal: ac.signal })).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(
      (raw.providers as Record<string, Record<string, unknown>>)['github-copilot'].models,
    ).toEqual(['gpt-4o']);
  });

  it('surfaces a device-code failure', async () => {
    route('github.com/login/device/code', () => new Response(null, { status: 503 }));
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    expect(await runCopilotOAuthLogin(deps, { signal: ac.signal })).toBe(1);
    expect(logs.some((l) => l.includes('Login failed: GitHub device-code request failed (503)'))).toBe(true);
  });

  it('surfaces a copilot-token failure', async () => {
    route('github.com/login/device/code', () =>
      jsonResponse({
        device_code: 'dc',
        user_code: 'UC',
        verification_uri: 'https://github.com/login/device',
        interval: 0,
        expires_in: 900,
      }),
    );
    route('github.com/login/oauth/access_token', () => jsonResponse({ access_token: 'gh-tok' }));
    route('api.github.com/copilot_internal/v2/token', () => new Response(null, { status: 401 }));
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    expect(await runCopilotOAuthLogin(deps, { signal: ac.signal })).toBe(1);
    expect(logs.some((l) => l.includes('Login failed: Copilot token request failed (401)'))).toBe(true);
  });

  it('cancels with "Login cancelled." when aborted during polling', async () => {
    route('github.com/login/device/code', () =>
      jsonResponse({
        device_code: 'dc',
        user_code: 'UC',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      }),
    );
    const { configPath, vault, registry } = await setup();
    const { deps, logs } = depsFor(configPath, vault, registry);
    const ac = new AbortController();
    const flow = runCopilotOAuthLogin(deps, { signal: ac.signal });
    await waitForUrl(logs, 'github.com/login/device');
    ac.abort();
    expect(await flow).toBe(1);
    expect(logs.some((l) => l.includes('Login cancelled.'))).toBe(true);
  });
});
