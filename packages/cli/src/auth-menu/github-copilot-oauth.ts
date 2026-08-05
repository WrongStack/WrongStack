/**
 * GitHub Copilot login — GitHub OAuth **device flow** (no loopback server).
 *
 *   1. POST github.com/login/device/code → user_code + verification_uri.
 *   2. User opens the URL, enters the code; we poll login/oauth/access_token
 *      until GitHub returns a long-lived OAuth token.
 *   3. Exchange that token at api.github.com/copilot_internal/v2/token for a
 *      short-lived Copilot token (the chat access token).
 *
 * Stored under the canonical `github-copilot` provider (family `github-copilot`,
 * an OpenAI chat/completions-compatible wire). The GitHub OAuth token is the
 * refresh token; the provider mints fresh Copilot tokens from it transparently.
 */

import { color } from '@wrongstack/core/utils';
import { FetchError, ParseError, type ProviderApiKey, type ProviderConfig } from '@wrongstack/core/types';
import { copilotBaseUrlFromToken, refreshCopilotToken } from '@wrongstack/providers';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import { openBrowser } from './loopback-server.js';
import type { AuthMenuDeps } from './types.js';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};
const COPILOT_API_VERSION = '2026-06-01';
export const COPILOT_PROVIDER_ID = 'github-copilot';

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}


function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Start the GitHub device flow. */
export async function startDeviceFlow(signal?: AbortSignal): Promise<DeviceCode> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': COPILOT_HEADERS['User-Agent']!,
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new FetchError({
      message: `GitHub device-code request failed (${res.status})`,
      status: res.status,
      context: { provider: 'github-copilot', op: 'device-code', url: DEVICE_CODE_URL },
    });
  }
  const json = (await res.json()) as Partial<DeviceCode> | null;
  if (
    !json?.device_code ||
    !json.user_code ||
    !json.verification_uri ||
    typeof json.expires_in !== 'number'
  ) {
    throw new ParseError({
      message: 'Invalid device-code response',
      source: 'github-copilot-device-code-response',
    });
  }
  return {
    device_code: json.device_code,
    user_code: json.user_code,
    verification_uri: json.verification_uri,
    interval: json.interval ?? 5,
    expires_in: json.expires_in,
  };
}

/** Poll until the user authorizes; returns the GitHub OAuth token. */
export async function pollForGitHubToken(device: DeviceCode, signal: AbortSignal): Promise<string> {
  let intervalMs = device.interval * 1000;
  const expiresAt = Date.now() + device.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await sleep(intervalMs, signal);
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': COPILOT_HEADERS['User-Agent']!,
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
    };
    if (json.access_token) return json.access_token;
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`Device flow failed: ${json.error ?? 'unknown error'}`);
  }
  throw new FetchError({
    message: 'Device code expired — please restart the login.',
    status: 408, // Request Timeout
    context: { provider: 'github-copilot', op: 'device-code-poll', reason: 'expired' },
  });
}

/** Shape of the fields we read from a `/models` entry (everything optional). */
interface CopilotModelEntry {
  id?: unknown;
  model_picker_enabled?: unknown;
  is_chat_default?: unknown;
  is_chat_fallback?: unknown;
  vendor?: unknown;
  supported_endpoints?: unknown;
  policy?: { state?: unknown } | undefined;
  capabilities?: { type?: unknown; supports?: { tool_calls?: unknown } | undefined } | undefined;
}

/**
 * Decide whether a Copilot `/models` entry is a chat model we can actually
 * drive over this provider's wire.
 *
 * The provider POSTs to `…/chat/completions`, so the discriminators are:
 *   - `capabilities.type === 'chat'` — drops embeddings and completion-only ids.
 *   - `capabilities.supports.tool_calls` — the agent loop needs tool calling.
 *   - `supported_endpoints` (when present) must include `/chat/completions`.
 *     This is the key fix: `/responses`-only ids (the `*-picker` router models,
 *     `gpt-5.4-mini-free-auto`, `mai-code-1-flash*`) advertise themselves in the
 *     model picker but 400 on `/chat/completions`. Absent field ⇒ legacy chat
 *     model (gpt-4o, gpt-4.1) ⇒ allowed.
 *   - `policy.state !== 'disabled'` — disabled means the user hasn't enabled the
 *     model in their GitHub Copilot settings; calling it would 403.
 *   - `vendor !== 'Experimental'` — drops internal previews (trajectory-compaction).
 */
export function isUsableCopilotChatModel(item: CopilotModelEntry): boolean {
  if (typeof item.id !== 'string' || item.id.length === 0) return false;
  const cap = item.capabilities;
  if (cap?.type !== 'chat') return false;
  if (cap.supports?.tool_calls !== true) return false;
  const eps = item.supported_endpoints;
  if (Array.isArray(eps) && !eps.includes('/chat/completions')) return false;
  if (item.policy?.state === 'disabled') return false;
  if (item.vendor === 'Experimental') return false;
  return true;
}

/** Fetch the user's usable Copilot chat-model ids (best-effort, never throws). */
async function fetchCopilotModels(copilotToken: string, signal: AbortSignal): Promise<string[]> {
  try {
    const base = copilotBaseUrlFromToken(copilotToken);
    const res = await fetch(`${base}/models`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${copilotToken}`,
        'X-GitHub-Api-Version': COPILOT_API_VERSION,
        ...COPILOT_HEADERS,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: CopilotModelEntry[] } | null;
    const data = json?.data;
    if (!Array.isArray(data)) return [];
    const usable = data.filter(isUsableCopilotChatModel);
    // Float the provider's own default/fallback chat model to the front so the
    // saved list's first entry is a sane `--model` default.
    usable.sort((a, b) => copilotModelRank(a) - copilotModelRank(b));
    return usable.map((m) => m.id as string);
  } catch {
    return [];
  }
}

/** Lower rank sorts first: chat default, then fallback, then everything else. */
function copilotModelRank(item: CopilotModelEntry): number {
  if (item.is_chat_default === true) return 0;
  if (item.is_chat_fallback === true) return 1;
  return 2;
}

export interface CopilotLoginOptions {
  providerId?: string;
  /**
   * External cancellation signal (e.g. the TUI auth panel's Esc). When
   * provided, the flow does NOT install its own SIGINT handler — the
   * caller owns cancellation.
   */
  signal?: AbortSignal | undefined;
}

export async function runCopilotOAuthLogin(
  deps: AuthMenuDeps,
  opts: CopilotLoginOptions = {},
): Promise<number> {
  const providerId = opts.providerId ?? COPILOT_PROVIDER_ID;
  const ac = new AbortController();
  const onSig = () => ac.abort();
  const onExternalAbort = () => ac.abort();
  const external = opts.signal;
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  } else {
    process.on('SIGINT', onSig);
  }

  try {
    deps.renderer.write(
      color.bold(`\n  Sign in with GitHub Copilot — ${color.cyan(providerId)}\n`) +
        color.dim('  Uses your GitHub Copilot subscription (not an API key).\n') +
        color.amber('  ⚠ Using Copilot outside its official editor integrations may violate\n') +
        color.amber('    GitHub’s Terms — your account could be rate-limited or banned.\n\n'),
    );

    const device = await startDeviceFlow(ac.signal);
    deps.renderer.write(
      color.bold(`  ${'─'.repeat(56)}\n`) +
        color.bold('  Open this URL and enter the code:\n') +
        color.cyan(`  ${device.verification_uri}\n`) +
        color.bold('  Code: ') +
        color.green(color.bold(device.user_code)) +
        '\n' +
        color.bold(`  ${'─'.repeat(56)}\n\n`),
    );
    openBrowser(device.verification_uri);
    deps.renderer.write(color.dim('  Waiting for you to authorize in the browser...\n'));

    const githubToken = await pollForGitHubToken(device, ac.signal);
    deps.renderer.write(color.dim('  Authorized. Fetching your Copilot token...\n'));
    const copilot = await refreshCopilotToken(githubToken, ac.signal);
    const models = await fetchCopilotModels(copilot.token, ac.signal);

    const saved = await saveCopilotTokens(
      deps,
      providerId,
      copilot.token,
      githubToken,
      copilot.expires,
      models,
    );
    if (!saved) return 1;

    deps.renderer.write(color.green('\n  ✓ Signed in with GitHub Copilot!\n'));
    const modelHint = models[0] ?? 'gpt-4o';
    deps.renderer.writeInfo(
      `  Saved as provider ${color.bold(providerId)}${models.length ? ` (${models.length} models)` : ''}.\n` +
        `  Use: ${color.bold(`wstack --provider ${providerId} --model ${modelHint}`)} "<task>"\n` +
        color.dim('  The Copilot token refreshes automatically.\n'),
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
    if (external) {
      external.removeEventListener('abort', onExternalAbort);
    } else {
      process.off('SIGINT', onSig);
    }
  }
}

async function saveCopilotTokens(
  deps: AuthMenuDeps,
  providerId: string,
  copilotToken: string,
  githubToken: string,
  expires: number,
  models: string[],
): Promise<boolean> {
  const entry: ProviderApiKey = {
    label: 'oauth-default',
    apiKey: copilotToken,
    createdAt: nowIso(),
    authMethod: 'oauth',
    expiresAt: new Date(expires).toISOString(),
    refreshToken: githubToken,
    tokenType: 'bearer',
  };
  try {
    await mutateConfigProviders(deps.profileConfigPath, deps.vault, (all) => {
      const existing = all[providerId];
      const p: ProviderConfig = existing ? { ...existing } : { type: providerId };
      p.family = 'github-copilot';
      if (!p.baseUrl) p.baseUrl = copilotBaseUrlFromToken(copilotToken);
      if (models.length > 0) p.models = models;
      else if (!p.models || p.models.length === 0) p.models = ['gpt-4o'];
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
