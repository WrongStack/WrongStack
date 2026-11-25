import {
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';
import type { CodexAccountCatalogHost } from './codex-account-catalog.js';
import { codexUsageUrl } from './oauth/codex-protocol.js';
import { parseCodexUsagePayload } from './openai-codex-rate-limits.js';
import { upstreamUrl } from './proxy-upstream.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';

/** Match the issued registration, never the app name or first account's quota. */
export function parseChatGPTAppQuota(
  providerId: string,
  clientId: string,
  payload: unknown,
): ProviderQuotaSnapshot[] {
  if (!clientId || !payload || typeof payload !== 'object') return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const matches = items.filter((item) => item && typeof item === 'object' && item.id === clientId);
  if (matches.length !== 1 || !Array.isArray(matches[0].windows)) return [];
  const windows: ProviderQuotaWindow[] = [];
  for (const [index, raw] of matches[0].windows.entries()) {
    if (!raw || typeof raw !== 'object') return [];
    const {
      used_percent: used,
      limit_window_seconds: seconds,
      reset_at: reset,
      reset_after_seconds: after,
    } = raw;
    if (
      typeof used !== 'number' ||
      !Number.isFinite(used) ||
      used < 0 ||
      used > 100 ||
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds <= 0
    )
      return [];
    const resetsAt =
      typeof reset === 'number' && Number.isFinite(reset) && reset > 0
        ? Math.floor(reset)
        : typeof after === 'number' && Number.isFinite(after) && after > 0
          ? Math.floor(Date.now() / 1000) + Math.floor(after)
          : undefined;
    windows.push({
      id: `window-${index}`,
      usedPercent: used,
      windowMinutes: seconds / 60,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length
    ? [
        {
          providerId,
          meterId: 'chatgpt-app',
          meterLabel: 'App limit',
          windows,
          capturedAt: Date.now(),
        },
      ]
    : [];
}

/** The direct token cannot read WHAM. A Codex credential must find this exact registration. */
export async function readChatGPTQuota(
  this: Pick<
    CodexAccountCatalogHost,
    'baseUrl' | 'fetchImpl' | 'access' | 'accountId' | 'ensureFreshToken' | 'doRefresh'
  >,
  providerId: string,
  clientId: string,
  opts: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<ProviderQuotaSnapshot[]> {
  const root = upstreamUrl(codexUsageUrl(this.baseUrl));
  if (root !== 'https://chatgpt.com/backend-api/wham/usage') return [];
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 10_000;
  try {
    const signal = AbortSignal.any([
      ...(opts.signal ? [opts.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    const read = async (url: string): Promise<unknown> => {
      const request = () =>
        redirectSafeFetch(this.fetchImpl, url, {
          method: 'GET',
          signal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.access}`,
            'OAI-App-Brand': 'chatgpt',
            ...(this.accountId ? { 'chatgpt-account-id': this.accountId } : {}),
          },
        });
      let response = await request();
      if (response.status === 401) {
        await this.doRefresh(signal);
        response = await request();
      }
      return response.ok ? response.json() : undefined;
    };
    await this.ensureFreshToken(signal);
    const app = parseChatGPTAppQuota(providerId, clientId, await read(`${root}/chatpass/apps`));
    if (!app.length) return [];
    // Account-wide windows are distinct from the app's weekly cap. Additional
    // Codex model buckets do not describe this app and must not be copied.
    let plan: ProviderQuotaSnapshot[] = [];
    try {
      const payload = (await read(root)) as Record<string, unknown> | undefined;
      if (payload)
        plan = parseCodexUsagePayload(providerId, {
          plan_type: payload.plan_type,
          rate_limit: payload.rate_limit,
          credits: payload.credits,
        }).map((snapshot) => ({ ...snapshot, meterId: 'chatgpt-plan', meterLabel: 'Plan limits' }));
    } catch {
      /* A failed optional plan read must not hide the verified app windows. */
    }
    const snapshots = [...plan, ...app];
    recordProviderQuota(providerId, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}
