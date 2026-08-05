/**
 * OpenAI Codex — "Sign in with ChatGPT", terminal flow.
 *
 * This module is now only the *terminal* half of the login: the rendered
 * instructions, the SIGINT / TUI-signal cancellation contract, the
 * manual-paste prompt, and writing the resulting tokens into the encrypted
 * profile config.
 *
 * The protocol itself — client id, endpoints, PKCE, the authorize URL, the
 * token exchange and refresh, the JWT account-id claim, and model discovery —
 * lives in `@wrongstack/providers/oauth`. It used to live here AND in
 * `providers/src/oauth/chatgpt.ts` (the headless WebUI flow) AND in
 * `providers/src/openai-codex.ts` (the runtime refresh path), whose header
 * said outright that it was mirroring this file.
 *
 * Three copies is what let the OAuth abort-listener leak sit in two of them
 * while a third flow in this same directory was already correct — nothing
 * forced them to agree, so a fix applied to one silently left the others
 * broken. A rotated client id or a changed token-endpoint contract carries the
 * same risk, with the failure being "one surface stops authenticating" rather
 * than a compile error.
 *
 * The protocol constants live in `providers` (not here) because the dependency
 * edge runs `cli → providers → core`: the runtime provider needs them to
 * refresh a token and must never import from `cli`.
 *
 * Everything the protocol layer defines is re-exported below, so existing
 * importers (`auth-menu/index.ts`, `wiring/provider.ts`, the CLI tests) keep
 * working against this module unchanged.
 */

import { color } from '@wrongstack/core/utils';
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/core/types';
import {
  buildCodexAuthorizeUrl,
  CODEX_BASE_URL,
  CODEX_FALLBACK_REDIRECT_PORT,
  CODEX_PROVIDER_ID,
  CODEX_REDIRECT_HOST,
  CODEX_REDIRECT_PATH,
  CODEX_REDIRECT_PORT,
  CODEX_SCOPE,
  type CodexTokens,
  codexRedirectUri,
  createState,
  exchangeCodexAuthorizationCode,
  extractAccountId,
  generatePkce,
  parseAuthorizationInput,
  refreshCodexTokens,
  resolveCodexModels,
} from '@wrongstack/providers/oauth';
import {
  type LoopbackServer,
  openBrowser,
  startLoopbackServer as startSharedLoopbackServer,
} from './loopback-server.js';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import type { AuthMenuDeps } from './types.js';

// ── Protocol re-exports (canonical definitions: @wrongstack/providers/oauth) ──

export {
  CODEX_BASE_URL,
  CODEX_CATALOG_FAMILIES,
  CODEX_PROVIDER_ID,
  type CodexTokens,
  extractAccountId,
  FALLBACK_CODEX_MODELS,
  fallbackCodexModelIds,
  fallbackCodexProviderModels,
  fetchCodexModels,
  filterCurrentCodexModelIds,
  generatePkce,
  isCodexCatalogModel,
  parseAuthorizationInput,
  type Pkce,
  resolveCodexModels,
} from '@wrongstack/providers/oauth';

/** Build the Codex authorize URL. Alias kept for the historical local name. */
export const buildAuthorizeUrl = buildCodexAuthorizeUrl;

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export const exchangeAuthorizationCode = exchangeCodexAuthorizationCode;

/**
 * Refresh an expired access token. Alias kept for the historical local name;
 * `wiring/provider.ts` and the CLI tests import it from here.
 */
export const refreshCodexToken = refreshCodexTokens;

/**
 * Codex-specific loopback wrapper. Stays CLI-side because this flow pairs it
 * with {@link openBrowser}, which is terminal-only.
 */
export function startLoopbackServer(
  expectedState: string,
  signal?: AbortSignal,
): Promise<LoopbackServer> {
  return startSharedLoopbackServer(
    expectedState,
    [CODEX_REDIRECT_PORT, CODEX_FALLBACK_REDIRECT_PORT],
    signal,
    CODEX_REDIRECT_PATH,
    CODEX_REDIRECT_HOST,
  );
}

/** Local alias so the terminal flow can print the listening URL. */
const redirectUri = codexRedirectUri;

// ── Main login flow ─────────────────────────────────────────────────────────

export interface CodexLoginOptions {
  /** Storage provider id. Defaults to the canonical `openai-codex`. */
  providerId?: string;
  /**
   * External cancellation signal (e.g. the TUI auth panel's Esc). When
   * provided, the flow does NOT install its own SIGINT handler — the
   * caller owns cancellation, and a raw `process.exit` from inside a
   * mounted Ink tree would corrupt the terminal.
   */
  signal?: AbortSignal | undefined;
}

/**
 * Run the "Sign in with ChatGPT" flow and persist the resulting OAuth tokens.
 * Returns 0 on success, 1 on cancel/error.
 */
export async function runCodexOAuthLogin(
  deps: AuthMenuDeps,
  opts: CodexLoginOptions = {},
): Promise<number> {
  const providerId = opts.providerId ?? CODEX_PROVIDER_ID;
  const pkce = generatePkce();
  const state = createState();

  const ac = new AbortController();
  // First Ctrl+C cancels cleanly (aborts the controller, which unblocks the
  // loopback wait below); a second Ctrl+C is a hard escape hatch in case
  // anything downstream is still wedged. Skipped entirely when the caller
  // supplied an external signal (TUI) — the caller owns cancellation then.
  let sigintCount = 0;
  const onSig = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      deps.renderer.write(color.dim('\n  Cancelling sign-in… (press Ctrl+C again to force-quit)\n'));
      ac.abort();
    } else {
      process.exit(130);
    }
  };
  const external = opts.signal;
  const onExternalAbort = () => ac.abort();
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  } else {
    process.on('SIGINT', onSig);
  }

  const server = await startLoopbackServer(state, ac.signal);
  const authorizeUrl = buildAuthorizeUrl(pkce.challenge, state, server.port);
  // Wrap URL in OSC 8 terminal hyperlink sequences — makes it a clickable
  // link in modern terminals (Windows Terminal, iTerm2, Kitty, WezTerm, etc.).
  // The hyperlink is region-based: clicking any wrapped segment opens the URL.
  const osc8 = (url: string) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

  deps.renderer.write(
    color.bold(`\n  Sign in with ChatGPT — ${color.cyan(providerId)}\n`) +
      color.dim('  Uses your ChatGPT Plus/Pro/Team subscription (not an API key).\n') +
      color.amber('  ⚠ Using a subscription outside the official Codex client may violate\n') +
      color.amber('    OpenAI’s Terms — your account could be rate-limited or banned.\n') +
      color.dim('    Sanctioned programmatic use = an API key: ') +
      color.bold('wstack auth openai') +
      color.dim('\n\n') +
      color.bold(`  ${'─'.repeat(56)}\n`) +
      color.bold('  Open this URL in your browser to sign in:\n') +
      color.cyan(`  ${osc8(authorizeUrl)}\n`) +
      color.bold(`  ${'─'.repeat(56)}\n\n`),
  );

  if (server.bound) {
    openBrowser(authorizeUrl);
    deps.renderer.write(
      color.dim('  A browser window should open. Waiting for you to finish signing in...\n') +
        color.dim(`  (Listening on ${redirectUri(server.port)} — press Ctrl+C to cancel.)\n`),
    );
  } else {
    deps.renderer.write(
      color.amber('  ⚠ Could not start the local callback listener (ports 1455 and 1457 in use).\n') +
        color.dim('  After signing in, copy the full redirect URL from your browser\n') +
        color.dim('  (it starts with http://localhost:1455/auth/callback or :1457) and paste it below.\n'),
    );
  }

  let code: string | undefined;
  try {
    if (server.bound) {
      const callback = await server.waitForCode();
      // Ctrl+C while waiting on the loopback → cancel now rather than dropping
      // into the manual-paste prompt (which would block again).
      if (ac.signal.aborted) {
        deps.renderer.write(color.dim('  Cancelled.\n'));
        return 1;
      }
      if (callback) code = callback.code;
    }

    // Manual paste fallback (port busy, or browser couldn't redirect back).
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
    const tokens = await exchangeAuthorizationCode(code, pkce.verifier, ac.signal, server.port);
    const accountId = extractAccountId(tokens.access) ?? (tokens.idToken ? extractAccountId(tokens.idToken) : null);
    if (!accountId) {
      deps.renderer.writeError(
        '  Signed in, but the token has no ChatGPT account id.\n' +
          '  This account may not have Codex/ChatGPT subscription access.',
      );
      return 1;
    }

    // Fetch available models from the Codex backend (best-effort).
    deps.renderer.write(color.dim('  Fetching available models...\n'));
    const models = await resolveCodexModels(
      deps.modelsRegistry,
      tokens.access,
      CODEX_BASE_URL,
      ac.signal,
    );

    const saved = await saveCodexTokens(deps, providerId, tokens, accountId, models);
    if (!saved) return 1;

    const modelHint = models[0] ?? 'gpt-5.5';
    deps.renderer.write(color.green('\n  ✓ Signed in with ChatGPT!\n'));
    deps.renderer.writeInfo(
      `  Saved as provider ${color.bold(providerId)}${models.length > 0 ? ` (${models.length} models)` : ''}.\n` +
        `  Use: ${color.bold(`wstack --provider ${providerId} --model ${modelHint}`)} "<task>"\n` +
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
    // `{ once: true }` does not unregister on the normal completion path, and
    // the TUI reuses one signal across attempts — so this has to be explicit.
    // The Copilot flow in this same directory already did it; these two did not.
    if (external) external.removeEventListener('abort', onExternalAbort);
    else process.off('SIGINT', onSig);
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function saveCodexTokens(
  deps: AuthMenuDeps,
  providerId: string,
  tokens: CodexTokens,
  accountId: string,
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
    scope: CODEX_SCOPE,
    accountId,
  };

  try {
    await mutateConfigProviders(deps.profileConfigPath, deps.vault, (all) => {
      const existing = all[providerId];
      const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
      p.family = 'openai-codex';
      if (!p.baseUrl) p.baseUrl = CODEX_BASE_URL;
      // The caller populates `models` from the live backend or the fallback
      // constant. Always overwrite — the backend is authoritative.
      p.models = [...models];

      const keys = normalizeKeys(p).filter((k) => k.label !== entry.label);
      keys.push(entry);
      writeKeysBack(p, keys);
      p.activeKey = entry.label;
      all[providerId] = p;
    }, deps.profileConfigPath);
    return true;
  } catch (err) {
    deps.renderer.writeError(`  Failed to save tokens: ${(err as Error).message}`);
    return false;
  }
}
