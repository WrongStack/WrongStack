/**
 * GitHub Copilot login — GitHub OAuth **device flow** (no loopback server).
 * Headless port of the CLI's `github-copilot-oauth.ts`.
 *
 *   1. POST github.com/login/device/code → user_code + verification_uri.
 *   2. Poll login/oauth/access_token until GitHub returns an OAuth token.
 *   3. Exchange it at api.github.com/copilot_internal/v2/token for a
 *      short-lived Copilot token. The GitHub OAuth token is the refresh token.
 */

import { FetchError, ParseError, type ProviderApiKey } from '@wrongstack/core';
import { copilotBaseUrlFromToken, refreshCopilotToken } from '../github-copilot.js';
import type { BeginOAuthDeps, OAuthLoginOutcome, OAuthSession } from './types.js';

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
const DEFAULT_COPILOT_MODELS = ['gpt-4o'];

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

async function startDeviceFlow(signal?: AbortSignal): Promise<DeviceCode> {
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

async function pollForGitHubToken(device: DeviceCode, signal: AbortSignal): Promise<string> {
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
    status: 408,
    context: { provider: 'github-copilot', op: 'device-code-poll', reason: 'expired' },
  });
}

interface CopilotModelEntry {
  id?: unknown;
  is_chat_default?: unknown;
  is_chat_fallback?: unknown;
  vendor?: unknown;
  supported_endpoints?: unknown;
  policy?: { state?: unknown } | undefined;
  capabilities?: { type?: unknown; supports?: { tool_calls?: unknown } | undefined } | undefined;
}

/** Whether a Copilot `/models` entry is a chat model drivable over this wire. */
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

function copilotModelRank(item: CopilotModelEntry): number {
  if (item.is_chat_default === true) return 0;
  if (item.is_chat_fallback === true) return 1;
  return 2;
}

async function fetchCopilotModels(copilotToken: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const base = copilotBaseUrlFromToken(copilotToken);
    const res = await fetch(`${base}/models`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${copilotToken}`,
        'X-GitHub-Api-Version': COPILOT_API_VERSION,
        ...COPILOT_HEADERS,
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8_000)])
        : AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: CopilotModelEntry[] } | null;
    const data = json?.data;
    if (!Array.isArray(data)) return [];
    const usable = data.filter(isUsableCopilotChatModel);
    usable.sort((a, b) => copilotModelRank(a) - copilotModelRank(b));
    return usable.map((m) => m.id as string);
  } catch {
    return [];
  }
}

export async function beginCopilotLogin(
  _deps: BeginOAuthDeps | undefined,
  signal?: AbortSignal,
): Promise<OAuthSession> {
  const device = await startDeviceFlow(signal);

  return {
    kind: 'copilot',
    providerId: COPILOT_PROVIDER_ID,
    bound: false,
    verificationUri: device.verification_uri,
    userCode: device.user_code,
    async waitForCompletion(waitSignal?: AbortSignal): Promise<OAuthLoginOutcome | null> {
      const ac = new AbortController();
      const upstream = waitSignal ?? signal;
      if (upstream) {
        if (upstream.aborted) ac.abort();
        else upstream.addEventListener('abort', () => ac.abort(), { once: true });
      }
      let githubToken: string;
      try {
        githubToken = await pollForGitHubToken(device, ac.signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return null;
        throw err;
      }
      const copilot = await refreshCopilotToken(githubToken, ac.signal);
      const fetched = await fetchCopilotModels(copilot.token, ac.signal);
      const models = fetched.length > 0 ? fetched : DEFAULT_COPILOT_MODELS;
      const apiKey: ProviderApiKey = {
        label: 'oauth-default',
        apiKey: copilot.token,
        createdAt: new Date().toISOString(),
        authMethod: 'oauth',
        expiresAt: new Date(copilot.expires).toISOString(),
        refreshToken: githubToken,
        tokenType: 'bearer',
      };
      return {
        providerId: COPILOT_PROVIDER_ID,
        family: 'github-copilot',
        baseUrl: copilotBaseUrlFromToken(copilot.token),
        models,
        apiKey,
      };
    },
    completeWithCode(): Promise<OAuthLoginOutcome> {
      return Promise.reject(
        new Error('GitHub Copilot uses a device-code flow — no redirect URL to paste.'),
      );
    },
    close(): void {
      /* device flow has no loopback to tear down */
    },
  };
}
