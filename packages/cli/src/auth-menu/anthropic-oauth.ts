/**
 * Anthropic "Sign in with Claude" OAuth (Authorization Code + PKCE) — Claude
 * Pro/Max subscription login. Parallel to the Codex flow but with Anthropic's
 * endpoints and quirks:
 *   - authorize at claude.ai/oauth/authorize (params include `code=true`),
 *   - the OAuth `state` is the PKCE verifier (Anthropic's convention),
 *   - JSON (not form) token exchange at platform.claude.com/v1/oauth/token,
 *   - loopback callback on http://localhost:53692/callback.
 *
 * Stored under the canonical `anthropic-oauth` provider (family `anthropic-oauth`)
 * so it never clobbers an API-key `anthropic` provider. The provider adapter
 * adds the Bearer + beta headers and the required Claude Code system block.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { color, FetchError, ParseError, type ProviderApiKey, type ProviderConfig } from '@wrongstack/core';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import type { AuthMenuDeps } from './types.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const REDIRECT_PORT = 53692;
const REDIRECT_HOST = '127.0.0.1';
const REDIRECT_PATH = '/callback';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const CLAUDE_PROVIDER_ID = 'anthropic-oauth';
const CLAUDE_BASE_URL = 'https://api.anthropic.com';

export interface ClaudeTokens {
  access: string;
  refresh: string;
  expires: number;
}

// ── PKCE ────────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Build the Claude authorize URL. Anthropic uses the PKCE verifier as `state`. */
export function buildAuthorizeUrl(challenge: string, verifier: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export function parseAuthorizationInput(input: string): {
  code?: string | undefined;
  state?: string | undefined;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
}

// ── Token exchange / refresh (JSON) ──────────────────────────────────────────

interface TokenJson {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function readTokens(res: Response, op: string, url: string): Promise<ClaudeTokens> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new FetchError({
      message: `Claude token ${op} failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: 'anthropic-oauth', op, url },
    });
  }
  const json = (await res.json()) as TokenJson | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new ParseError({
      message: `Claude token ${op} response missing fields`,
      source: 'anthropic-oauth-token-response',
      context: { op },
    });
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

/** Exchange an authorization code (+ verifier, reused as state) for tokens. */
export async function exchangeAuthorizationCode(
  code: string,
  state: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<ClaudeTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  return readTokens(res, 'exchange', TOKEN_URL);
}

/**
 * Fetch the account's available Claude model ids live from
 * `api.anthropic.com/v1/models` using the OAuth token. Best-effort: returns []
 * on any failure so login still succeeds with a sensible fallback list.
 */
async function fetchClaudeModels(accessToken: string, signal: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${CLAUDE_BASE_URL}/v1/models?limit=100`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> } | null;
    const ids = (json?.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('claude-'));
    return ids;
  } catch {
    return [];
  }
}

// ── Loopback server ──────────────────────────────────────────────────────────

function callbackHtml(ok: boolean, message: string): string {
  const heading = ok ? 'Authentication successful' : 'Authentication failed';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>` +
    `<title>${heading}</title><style>body{margin:0;min-height:100vh;display:flex;` +
    `align-items:center;justify-content:center;background:#09090b;color:#fafafa;` +
    `font-family:ui-sans-serif,system-ui,sans-serif;text-align:center}` +
    `h1{font-size:26px;margin:0 0 8px}p{color:#a1a1aa}</style></head><body><main>` +
    `<h1>${heading}</h1><p>${message}</p></main></body></html>`
  );
}

interface LoopbackServer {
  waitForCode(): Promise<{ code: string; state: string } | null>;
  close(): void;
  readonly bound: boolean;
}

function startLoopbackServer(
  expectedState: string,
  signal?: AbortSignal,
): Promise<LoopbackServer> {
  let resolveCode: (v: { code: string; state: string } | null) => void = () => {};
  const codePromise = new Promise<{ code: string; state: string } | null>((resolve) => {
    let settled = false;
    resolveCode = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
  });

  const server: Server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', `http://${REDIRECT_HOST}`);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (url.pathname !== REDIRECT_PATH) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(callbackHtml(false, 'Callback route not found.'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const err = url.searchParams.get('error');
    if (err) {
      res.statusCode = 400;
      res.end(callbackHtml(false, `Authorization error: ${err}`));
      resolveCode(null);
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'Missing code or state.'));
      return;
    }
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'State mismatch — please restart the login.'));
      resolveCode(null);
      return;
    }
    res.statusCode = 200;
    res.end(callbackHtml(true, 'You can close this window and return to the terminal.'));
    resolveCode({ code, state });
  });

  // Abort (Ctrl+C / TUI Esc) → unblock the pending wait and close the server
  // so the login flow returns promptly instead of hanging on the loopback.
  const onAbort = (): void => {
    resolveCode(null);
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise<LoopbackServer>((resolve) => {
    server.on('error', () => {
      resolveCode(null);
      resolve({
        bound: false,
        waitForCode: () => Promise.resolve(null),
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
    server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
      resolve({
        bound: true,
        waitForCode: () => codePromise,
        close: () => {
          resolveCode(null);
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const { command, args } =
      platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : platform === 'darwin'
          ? { command: 'open', args: [url] }
          : { command: 'xdg-open', args: [url] };
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort */
  }
}

// ── Main flow ─────────────────────────────────────────────────────────────

export interface ClaudeLoginOptions {
  providerId?: string;
  /**
   * External cancellation signal (e.g. the TUI auth panel's Esc). When
   * provided, the flow does NOT install its own SIGINT handler — the
   * caller owns cancellation.
   */
  signal?: AbortSignal | undefined;
}

export async function runClaudeOAuthLogin(
  deps: AuthMenuDeps,
  opts: ClaudeLoginOptions = {},
): Promise<number> {
  const providerId = opts.providerId ?? CLAUDE_PROVIDER_ID;
  const { verifier, challenge } = generatePkce();
  // Anthropic reuses the PKCE verifier as the OAuth state.
  const state = verifier;
  const authorizeUrl = buildAuthorizeUrl(challenge, verifier);

  const ac = new AbortController();
  const onSig = () => ac.abort();
  const external = opts.signal;
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener('abort', () => ac.abort(), { once: true });
  } else {
    process.on('SIGINT', onSig);
  }

  const server = await startLoopbackServer(state, ac.signal);

  deps.renderer.write(
    color.bold(`\n  Sign in with Claude — ${color.cyan(providerId)}\n`) +
      color.dim('  Uses your Claude Pro/Max subscription (not an API key).\n') +
      color.amber('  ⚠ Using a subscription outside the official Claude Code client is against\n') +
      color.amber('    Anthropic’s Terms — your account could be rate-limited or banned.\n') +
      color.dim('    Sanctioned programmatic use = an API key: ') +
      color.bold('wstack auth anthropic') +
      color.dim('\n\n') +
      color.bold(`  ${'─'.repeat(56)}\n`) +
      color.bold('  Open this URL in your browser to sign in:\n') +
      color.cyan(`  ${authorizeUrl}\n`) +
      color.bold(`  ${'─'.repeat(56)}\n\n`),
  );

  if (server.bound) {
    openBrowser(authorizeUrl);
    deps.renderer.write(
      color.dim('  A browser window should open. Waiting for you to finish signing in...\n') +
        color.dim('  (Listening on http://localhost:53692 — press Ctrl+C to cancel.)\n'),
    );
  } else {
    deps.renderer.write(
      color.amber('  ⚠ Could not start the local callback listener (port 53692 in use).\n') +
        color.dim('  After signing in, paste the full redirect URL (or the code) below.\n'),
    );
  }

  let code: string | undefined;
  try {
    if (server.bound) {
      const got = await server.waitForCode();
      // Cancelled while waiting on the loopback → return now rather than
      // dropping into the manual-paste prompt (which would block again).
      if (ac.signal.aborted) {
        deps.renderer.write(color.dim('  Cancelled.\n'));
        return 1;
      }
      if (got) code = got.code;
    }

    if (!code) {
      const input = (
        await deps.reader.readLine(
          `\n  ${color.amber('?')} Paste the redirect URL or code ${color.dim('(or q to cancel)')}: `,
        )
      ).trim();
      if (input.toLowerCase() === 'q' || input === '') {
        deps.renderer.write(color.dim('  Cancelled.\n'));
        return 1;
      }
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== state) {
        deps.renderer.writeError('  State mismatch — please restart the login flow.');
        return 1;
      }
      code = parsed.code;
    }

    if (!code) {
      deps.renderer.writeError('  No authorization code received.');
      return 1;
    }

    deps.renderer.write(color.dim('\n  Exchanging authorization code for tokens...\n'));
    const tokens = await exchangeAuthorizationCode(code, state, verifier, ac.signal);
    const models = await fetchClaudeModels(tokens.access, ac.signal);

    const saved = await saveClaudeTokens(deps, providerId, tokens, models);
    if (!saved) return 1;

    deps.renderer.write(color.green('\n  ✓ Signed in with Claude!\n'));
    const modelHint = models[0];
    deps.renderer.writeInfo(
      `  Saved as provider ${color.bold(providerId)}${models.length ? ` (${models.length} models)` : ''}.\n` +
        (modelHint
          ? `  Use: ${color.bold(`wstack --provider ${providerId} --model ${modelHint}`)} "<task>"\n`
          : `  No model list was discovered; choose a model before starting a run.\n`) +
        color.dim('  Tokens refresh automatically before they expire.\n'),
    );
    return 0;
  } catch (err) {
    const msg =
      err instanceof DOMException && err.name === 'AbortError'
        ? 'Login cancelled.'
        : (err as Error).message;
    deps.renderer.writeError(`  Login failed: ${msg}`);
    return 1;
  } finally {
    server.close();
    if (!external) process.off('SIGINT', onSig);
  }
}

async function saveClaudeTokens(
  deps: AuthMenuDeps,
  providerId: string,
  tokens: ClaudeTokens,
  models: string[],
): Promise<boolean> {
  const entry: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: tokens.access,
    createdAt: nowIso(),
    authMethod: 'oauth',
    expiresAt: new Date(tokens.expires).toISOString(),
    refreshToken: tokens.refresh,
    tokenType: 'bearer',
    scope: SCOPES,
  };
  try {
    await mutateConfigProviders(deps.globalConfigPath, deps.vault, (all) => {
      const existing = all[providerId];
      const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
      p.family = 'anthropic-oauth';
      if (!p.baseUrl) p.baseUrl = CLAUDE_BASE_URL;
      if (models.length > 0) p.models = models;
      const keys = normalizeKeys(p).filter((k) => k.label !== entry.label);
      keys.push(entry);
      writeKeysBack(p, keys);
      p.activeKey = entry.label;
      all[providerId] = p;
    });
    return true;
  } catch (err) {
    deps.renderer.writeError(`  Failed to save tokens: ${(err as Error).message}`);
    return false;
  }
}
