/**
 * OmniRoute pool quota — the gateway's own per-account plan limits.
 *
 * OmniRoute already reads the plan quota of every account it routes through
 * (Claude Max, Codex, Antigravity, Copilot, Kimi, MiniMax, Z.AI, …) and caches
 * it. Its management API hands the cache out:
 *
 *   GET /api/usage/provider-limits   { caches: { <connectionId>: {
 *                                        quotas: { <name>: {used, total, remaining,
 *                                          remainingPercentage, resetAt, unlimited,
 *                                          displayName?, windowSeconds?, currency?} },
 *                                        modelQuotas?, plan, message, fetchedAt } } }
 *   GET /api/providers               { connections: [{ id, provider, name?, isActive }] }
 *
 * Both need a management credential — a scoped access token (`oma_…`, `read`
 * is enough); the inference key is refused (403). Verified live 2026-09-30.
 * Reading the cache triggers no upstream call: OmniRoute refreshes it on its
 * own schedule and after its own traffic, and `fetchedAt` says how old it is.
 *
 * Each live connection becomes one meter of the WrongStack provider that
 * points at the gateway, marked `via: 'omniroute'` — a pool account, not the
 * session's plan (see `ProviderQuotaSnapshot.via`). Cache entries of deleted
 * or disabled connections are skipped. The meter id is
 * `omniroute:<omniroute provider>:<connection id>`: the provider segment is
 * what a routed model id starts with (`claude/…`, or its alias `cc/…`), so a
 * surface can tell which pool accounts serve the model in use.
 *
 * @module omniroute-quota
 */

import {
  type ProviderQuotaCredits,
  type ProviderQuotaSnapshot,
  type ProviderQuotaWindow,
  recordProviderQuota,
} from '@wrongstack/core/quota';

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Display names for OmniRoute's provider ids; any other id shows as itself. */
const PROVIDER_NAME: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  claude: 'Claude',
  codex: 'Codex',
  github: 'Copilot',
  antigravity: 'Antigravity',
  agy: 'Antigravity',
  'kimi-coding': 'Kimi Code',
  minimax: 'MiniMax',
  zai: 'Z.AI',
  glm: 'GLM',
  'opencode-go': 'OpenCode Go',
  'command-code': 'Command Code',
  cursor: 'Cursor',
  kiro: 'Kiro',
});

const MAX_LABEL = 60;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** `(5h)` / `(7d)` in a quota's own name is its length; nothing else is guessed. */
function minutesFromName(name: string): number | undefined {
  const match = /\((\d+)\s*([mhd])\)/i.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n;
}

function money(amount: number, currency: unknown): string {
  const rounded = Math.round(amount * 100) / 100;
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded).toFixed(2);
  return currency === 'USD' || currency === undefined
    ? `${sign}$${abs}`
    : `${sign}${abs} ${currency}`;
}

/**
 * One cached quota as a window, or as a credit balance (a currency amount with
 * no reset), or nothing when it carries no usable number or is unlimited.
 */
function toWindowOrCredits(
  name: string,
  raw: unknown,
): { window: ProviderQuotaWindow } | { credits: ProviderQuotaCredits } | undefined {
  const q = record(raw);
  if (!q || q['unlimited'] === true) return undefined;
  const resetMs = typeof q['resetAt'] === 'string' ? Date.parse(q['resetAt']) : Number.NaN;
  const remaining = finite(q['remaining']);
  if (q['currency'] !== undefined && !Number.isFinite(resetMs)) {
    if (remaining === undefined) return undefined;
    return {
      credits: {
        hasCredits: remaining > 0,
        unlimited: false,
        balance: money(remaining, q['currency']),
      },
    };
  }
  const remainingPct = finite(q['remainingPercentage']);
  const used = finite(q['used']);
  const total = finite(q['total']);
  let usedPercent: number | undefined;
  if (remainingPct !== undefined) usedPercent = 100 - remainingPct;
  else if (used !== undefined && total !== undefined && total > 0)
    usedPercent = (used / total) * 100;
  if (usedPercent === undefined) return undefined;
  const label = (typeof q['displayName'] === 'string' && q['displayName']) || name;
  const seconds = finite(q['windowSeconds']);
  const minutes =
    seconds !== undefined && seconds > 0 ? Math.round(seconds / 60) : minutesFromName(label);
  return {
    window: {
      id: name,
      label: label.slice(0, MAX_LABEL),
      usedPercent: clampPercent(usedPercent),
      ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
      ...(Number.isFinite(resetMs) ? { resetsAt: Math.floor(resetMs / 1000) } : {}),
    },
  };
}

/**
 * Per-model buckets that move together (Antigravity reports one per model,
 * most on the same pool) fold into one window: `gemini-3.1-pro-high +7`.
 */
function foldIdenticalWindows(windows: ProviderQuotaWindow[]): ProviderQuotaWindow[] {
  const folded: Array<{ window: ProviderQuotaWindow; extra: number }> = [];
  for (const window of windows) {
    const same = folded.find(
      (f) =>
        f.window.usedPercent === window.usedPercent &&
        f.window.resetsAt === window.resetsAt &&
        f.window.windowMinutes === window.windowMinutes,
    );
    if (same) same.extra += 1;
    else folded.push({ window, extra: 0 });
  }
  return folded.map(({ window, extra }) =>
    extra === 0 ? window : { ...window, label: `${window.label ?? window.id} +${extra}` },
  );
}

interface Connection {
  provider: string;
  name?: string | undefined;
}

/** Live connections by id; a disabled one is left out like a deleted one. */
function liveConnections(body: unknown): Map<string, Connection> {
  const out = new Map<string, Connection>();
  const list = record(body)?.['connections'];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    const c = record(raw);
    const id = c?.['id'];
    const provider = c?.['provider'];
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof provider !== 'string')
      continue;
    if (c?.['isActive'] === false) continue;
    const name = typeof c?.['name'] === 'string' && c['name'].trim() ? c['name'].trim() : undefined;
    out.set(String(id), { provider, name });
  }
  return out;
}

/** Parse the two management reads into one snapshot per live connection. */
function parseOmniRouteLimits(
  providerId: string,
  limitsBody: unknown,
  connectionsBody: unknown,
  now: number,
): ProviderQuotaSnapshot[] {
  const caches = record(record(limitsBody)?.['caches']);
  if (!caches) return [];
  const connections = liveConnections(connectionsBody);
  const snapshots: ProviderQuotaSnapshot[] = [];
  for (const [connectionId, rawEntry] of Object.entries(caches)) {
    const connection = connections.get(connectionId);
    const entry = record(rawEntry);
    if (!connection || !entry) continue;
    const capturedAt =
      typeof entry['fetchedAt'] === 'string' ? Date.parse(entry['fetchedAt']) : Number.NaN;
    if (!Number.isFinite(capturedAt)) continue;

    const windows: ProviderQuotaWindow[] = [];
    let credits: ProviderQuotaCredits | undefined;
    const sources = [record(entry['quotas']), record(entry['modelQuotas'])];
    for (const source of sources) {
      for (const [name, raw] of Object.entries(source ?? {})) {
        const parsed = toWindowOrCredits(name, raw);
        if (!parsed) continue;
        // The cache can be older than a window: once its reset has passed,
        // the cached percentage describes a window that no longer exists.
        if (
          'window' in parsed &&
          (parsed.window.resetsAt ?? Number.POSITIVE_INFINITY) * 1000 <= now
        ) {
          continue;
        }
        if ('credits' in parsed) credits ??= parsed.credits;
        else if (!windows.some((w) => w.id === parsed.window.id)) windows.push(parsed.window);
      }
    }
    const shown = foldIdenticalWindows(windows);
    const message = typeof entry['message'] === 'string' ? entry['message'].trim() : '';
    if (shown.length === 0 && !credits && !message) continue;

    // Of the exhausted windows, the one that reopens last is what blocks it.
    let reached: ProviderQuotaWindow | undefined;
    for (const w of shown) {
      if (
        w.usedPercent >= 100 &&
        (reached === undefined || (w.resetsAt ?? 0) > (reached.resetsAt ?? 0))
      ) {
        reached = w;
      }
    }
    const vendor = PROVIDER_NAME[connection.provider] ?? connection.provider;
    const label = connection.name ? `${vendor} · ${connection.name}` : vendor;
    const plan =
      typeof entry['plan'] === 'string' && entry['plan'].trim() ? entry['plan'].trim() : undefined;
    snapshots.push({
      providerId,
      meterId: `omniroute:${connection.provider}:${connectionId}`,
      meterLabel: label.slice(0, MAX_LABEL),
      ...(plan ? { planLabel: plan.slice(0, MAX_LABEL) } : {}),
      windows: shown,
      ...(credits ? { credits } : {}),
      ...(reached ? { reachedWindowId: reached.id } : {}),
      // Always restated, empty when OmniRoute has nothing to say: the store
      // carries an omitted note forward, and a recovered account must not keep
      // showing the error it recovered from.
      note: message.slice(0, 200),
      via: 'omniroute',
      capturedAt,
    });
  }
  return snapshots;
}

/** The gateway root for a configured base URL: its origin plus any mount path, minus `/v1`. */
export function omniRouteRoot(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

export interface OmniRouteQuotaReportOptions {
  /** The management access token (`oma_…`), never the inference key. */
  managementToken: string;
  /** The gateway root (`http://localhost:20128`). */
  root: string;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
}

/**
 * Read OmniRoute's cached pool limits and record one meter per live account
 * under `providerId`. Resolves to the snapshots recorded; silent on every
 * failure, leaving the previous readings standing.
 */
export async function reportOmniRouteQuota(
  providerId: string,
  opts: OmniRouteQuotaReportOptions,
): Promise<ProviderQuotaSnapshot[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 10_000;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const get = async (path: string): Promise<unknown> => {
      const res = await doFetch(`${opts.root}${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${opts.managementToken}` },
        // The management token must not follow a redirect anywhere.
        redirect: 'error',
        signal,
      });
      return res.ok ? res.json() : undefined;
    };
    const [limits, connections] = await Promise.all([
      get('/api/usage/provider-limits'),
      get('/api/providers'),
    ]);
    if (limits === undefined || connections === undefined) return [];
    const snapshots = parseOmniRouteLimits(providerId, limits, connections, opts.now ?? Date.now());
    if (snapshots.length > 0) recordProviderQuota(providerId, snapshots);
    return snapshots;
  } catch {
    return [];
  }
}
