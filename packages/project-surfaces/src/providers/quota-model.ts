/**
 * The quota view model shared by the side-panel section and the Plan Quota
 * page: which vendor a provider is, how its readings group into cards, and
 * which cards concern the models the user is running right now.
 *
 * Pure — no React, no stores — so both surfaces read the same classification
 * and the rules are unit-testable on their own.
 */

import type { QuotaRefreshOutcome, QuotaSnapshot, QuotaWindow } from './provider-quota-store';

export type QuotaVendor =
  | 'codex'
  | 'chatgpt'
  | 'claude'
  | 'wrongforge'
  | 'minimax'
  | 'zai'
  | 'kimi'
  | 'opencode'
  | 'openrouter'
  | 'omniroute'
  | 'deepseek'
  | 'moonshot'
  | 'siliconflow'
  | 'custom';

export const VENDOR_ORDER: readonly QuotaVendor[] = [
  'codex',
  'chatgpt',
  'claude',
  'wrongforge',
  'minimax',
  'zai',
  'kimi',
  'opencode',
  'openrouter',
  'omniroute',
  'deepseek',
  'moonshot',
  'siliconflow',
  'custom',
];

/**
 * Brand names — shown verbatim in every UI language. A `custom` card has no
 * brand: it is titled by the provider id the user gave it.
 */
export const VENDOR_NAME: Record<QuotaVendor, string> = {
  codex: 'ChatGPT / Codex',
  chatgpt: 'ChatGPT',
  // The subscription of a delegated Claude Code worker (ACP), read from it.
  claude: 'Claude Code worker',
  wrongforge: 'WrongForge',
  minimax: 'MiniMax',
  zai: 'Z.AI',
  kimi: 'Kimi Code',
  opencode: 'OpenCode Go',
  openrouter: 'OpenRouter',
  omniroute: 'OmniRoute',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  siliconflow: 'SiliconFlow',
  custom: '',
};

export function isQuotaVendor(value: unknown): value is QuotaVendor {
  return typeof value === 'string' && (VENDOR_ORDER as readonly string[]).includes(value);
}

/**
 * The catalog ids — the card title already names the vendor. Any other id is a
 * user alias (`glm-work`) and is shown so two accounts can be told apart.
 */
export const CATALOG_IDS = new Set([
  'wrongforge',
  'claude-code',
  'openai-codex',
  'openai-chatgpt',
  'minimax',
  'minimax-coding-plan',
  'minimax-cn',
  'minimax-cn-coding-plan',
  'zai-coding-plan',
  'zhipuai-coding-plan',
  'kimi-for-coding',
  'kimi-code-plan-cn',
  'kimi-code-plan-global',
  'opencode-go',
  'openrouter',
  'omniroute',
  'deepseek',
  'moonshotai',
  'moonshotai-cn',
  'siliconflow',
  'siliconflow-cn',
]);

export interface SavedProviderLite {
  id: string;
  type?: string | undefined;
  family?: string | undefined;
  baseUrl?: string | undefined;
}

/** Host and path of a base URL, looking past a WrongProxy mount (`<proxy>/proxy/<host>/…`). */
function upstreamOf(url: string | undefined): { host: string; path: string } {
  if (!url) return { host: '', path: '' };
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    const proxied = /\/proxy\/([^/]+)(\/.*)?$/.exec(pathname);
    if (proxied?.[1]) return { host: proxied[1], path: proxied[2] ?? '/' };
    return { host: parsed.hostname.toLowerCase(), path: pathname };
  } catch {
    return { host: '', path: '' };
  }
}

/** Catalog ids of the key-read vendors, for a provider saved without a base URL. */
const CATALOG_VENDOR: Readonly<Record<string, QuotaVendor>> = {
  wrongforge: 'wrongforge',
  'claude-code': 'claude',
  'kimi-for-coding': 'kimi',
  'kimi-code-plan-cn': 'kimi',
  'kimi-code-plan-global': 'kimi',
  opencode: 'opencode',
  'opencode-go': 'opencode',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  moonshotai: 'moonshot',
  'moonshotai-cn': 'moonshot',
  siliconflow: 'siliconflow',
  'siliconflow-cn': 'siliconflow',
};

/** Hosts whose prepaid balance has an account read. */
const BALANCE_HOSTS: Readonly<Record<string, QuotaVendor>> = {
  'api.deepseek.com': 'deepseek',
  'api.moonshot.ai': 'moonshot',
  'api.moonshot.cn': 'moonshot',
  'api.siliconflow.com': 'siliconflow',
  'api.siliconflow.cn': 'siliconflow',
};

/**
 * Which quota card a provider belongs to, judged from its saved config. Z.AI
 * counts only on a Coding Plan endpoint — the pay-as-you-go `/api/paas/v4`
 * never draws on the plan. An OmniRoute gateway and a `quotaEndpoint`
 * provider are not judged here: their reads need config the browser never
 * sees, so their cards come from the server's read outcome and readings.
 */
export function quotaVendorOf(p: SavedProviderLite): QuotaVendor | undefined {
  const kind = `${p.type ?? ''} ${p.family ?? ''} ${p.id}`.toLowerCase();
  const { host, path } = upstreamOf(p.baseUrl);
  if ((p.type ?? p.id) === 'wrongforge') return 'wrongforge';
  if (kind.includes('openai-codex')) return 'codex';
  if (kind.includes('openai-chatgpt')) return 'chatgpt';
  if (/(^|\s)minimax/.test(kind) || /(^|\.)minimaxi?\.(io|cn|com|chat)$/.test(host)) {
    return 'minimax';
  }
  const zaiHost = host === 'z.ai' || host.endsWith('.z.ai') || host.endsWith('bigmodel.cn');
  const zaiId = /(^|\s)(zai|zhipuai)/.test(kind);
  if (zaiHost || zaiId) {
    const plan =
      /\/api\/coding\/|\/api\/anthropic/.test(path) || (!p.baseUrl && /coding-plan/.test(kind));
    return plan ? 'zai' : undefined;
  }
  if (p.baseUrl) {
    if ((host === 'api.kimi.com' || host === 'api.kimi.ai') && path.startsWith('/coding')) {
      return 'kimi';
    }
    if (host === 'opencode.ai' && path.startsWith('/zen')) return 'opencode';
    if (host === 'openrouter.ai') return 'openrouter';
    return BALANCE_HOSTS[host];
  }
  return CATALOG_VENDOR[p.type ?? p.id] ?? CATALOG_VENDOR[p.id];
}

/**
 * The identity of a card's reading when it can prove an account: one meter
 * whose every window carries a reset clock. Two unrelated accounts can both
 * sit at 0% of a clockless window, never on the same reset second of every
 * window. The same rule as `groupQuotaSnapshots` in `@wrongstack/core/quota`.
 */
function accountReadingKey(vendor: QuotaVendor, meters: QuotaSnapshot[]): string | undefined {
  const [m] = meters;
  if (meters.length !== 1 || !m || m.windows.length === 0) return undefined;
  if (m.windows.some((w) => w.resetsAt === undefined)) return undefined;
  return JSON.stringify([
    vendor,
    m.meterId,
    m.meterLabel ?? null,
    m.planLabel ?? null,
    m.reachedWindowId ?? null,
    m.note ?? null,
    m.credits ?? null,
    m.windows.map((w) => [
      w.id,
      w.label ?? null,
      w.usedPercent,
      w.windowMinutes ?? null,
      w.resetsAt,
    ]),
  ]);
}

export interface QuotaCard {
  providerId: string;
  /** Every saved provider that reads this same account, `providerId` first. */
  aliases: string[];
  vendor: QuotaVendor;
  meters: QuotaSnapshot[];
  /**
   * Pool accounts of this gateway left off the card because they do not serve
   * the models in use (set only by {@link cardsInUse}).
   */
  hiddenPoolAccounts?: number | undefined;
}

/**
 * Every quota card, one per account, in vendor order. `saved` gives a card to
 * a configured vendor before its first reading; `refreshes` names the vendor
 * the server read a provider as, which wins over the guess from config.
 */
export function buildQuotaCards(
  metersByKey: Readonly<Record<string, QuotaSnapshot>>,
  saved: readonly SavedProviderLite[],
  refreshes: Readonly<Record<string, QuotaRefreshOutcome>>,
): QuotaCard[] {
  const readAs = (providerId: string): QuotaVendor | undefined => {
    const vendor = refreshes[providerId]?.vendor;
    return isQuotaVendor(vendor) ? vendor : undefined;
  };
  const byProvider = new Map<string, { vendor: QuotaVendor; meters: QuotaSnapshot[] }>();
  for (const p of saved) {
    const vendor = readAs(p.id) ?? quotaVendorOf(p);
    if (vendor) byProvider.set(p.id, { vendor, meters: [] });
  }
  for (const meter of Object.values(metersByKey)) {
    let entry = byProvider.get(meter.providerId);
    if (!entry) {
      // A reading from a provider the saved list does not name as a quota
      // vendor (a gateway pool, a configured endpoint, one built from env):
      // classify it by how it was read, then by id.
      const vendor =
        readAs(meter.providerId) ??
        (meter.via === 'omniroute' ? 'omniroute' : undefined) ??
        quotaVendorOf({ id: meter.providerId, type: meter.providerId });
      if (!vendor) continue;
      entry = { vendor, meters: [] };
      byProvider.set(meter.providerId, entry);
    }
    entry.meters.push(meter);
  }
  for (const entry of byProvider.values()) {
    entry.meters.sort(
      (a, b) =>
        b.windows.length - a.windows.length ||
        (a.meterLabel ?? a.meterId).localeCompare(b.meterLabel ?? b.meterId),
    );
  }
  // One card per account: every OpenCode key of an account, Zen and Go
  // alike, reads the same usage, and identical cards say nothing more.
  const folded: QuotaCard[] = [];
  const byAccount = new Map<string, string[]>();
  const ordered = [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [providerId, entry] of ordered) {
    // A Zen-only OpenCode account has no Go plan to read: once its read has
    // failed with nothing standing, the card could only ever say so.
    const unread = entry.meters.length === 0 && refreshes[providerId]?.ok === false;
    if (entry.vendor === 'opencode' && unread) continue;
    const key = accountReadingKey(entry.vendor, entry.meters);
    const aliases = key === undefined ? undefined : byAccount.get(key);
    if (aliases) {
      aliases.push(providerId);
      continue;
    }
    const card: QuotaCard = { providerId, aliases: [providerId], ...entry };
    if (key !== undefined) byAccount.set(key, card.aliases);
    folded.push(card);
  }
  return folded.sort(
    (a, b) =>
      VENDOR_ORDER.indexOf(a.vendor) - VENDOR_ORDER.indexOf(b.vendor) ||
      a.providerId.localeCompare(b.providerId),
  );
}

// ── Models in use ───────────────────────────────────────────────────────────

/** A provider/model pair something is running on right now. */
export interface ModelInUse {
  provider: string;
  model: string;
}

/**
 * OmniRoute's short aliases for the providers whose accounts carry a plan
 * (from its provider registry): a routed model is `claude/…` or `cc/…`.
 */
const OMNIROUTE_ALIAS: Readonly<Record<string, string>> = {
  cc: 'claude',
  cx: 'codex',
  gh: 'github',
  kmc: 'kimi-coding',
  cmd: 'command-code',
  agy: 'antigravity',
};

/**
 * The OmniRoute provider a routed model id draws on: its first path segment
 * (after a `no-think/` wrapper), alias resolved. Undefined for a bare id or a
 * combo (`auto/…`), whose account is picked per request.
 */
function omniRouteProviderOfModel(model: string): string | undefined {
  const id = model.replace(/^no-think\//, '');
  const slash = id.indexOf('/');
  if (slash <= 0) return undefined;
  const prefix = id.slice(0, slash).toLowerCase();
  if (prefix === 'auto') return undefined;
  return OMNIROUTE_ALIAS[prefix] ?? prefix;
}

/** The OmniRoute provider of a pool meter (`omniroute:<provider>:<connection>`). */
export function omniRouteProviderOfMeter(meter: QuotaSnapshot): string | undefined {
  if (meter.via !== 'omniroute') return undefined;
  const provider = meter.meterId.split(':')[1];
  return provider === 'agy' ? 'antigravity' : provider || undefined;
}

/**
 * The cards that concern what is running right now: the providers of the open
 * sessions and running subagents. A gateway pool card keeps only the accounts
 * that serve the routed models in use; the rest are counted, not shown.
 */
export function cardsInUse(cards: readonly QuotaCard[], inUse: readonly ModelInUse[]): QuotaCard[] {
  const out: QuotaCard[] = [];
  for (const card of cards) {
    const uses = inUse.filter((u) => card.aliases.includes(u.provider));
    if (uses.length === 0) continue;
    const pool = card.meters.filter((m) => m.via !== undefined);
    if (pool.length === 0) {
      out.push(card);
      continue;
    }
    const wanted = new Set(
      uses
        .map((u) => omniRouteProviderOfModel(u.model))
        .filter((p): p is string => p !== undefined),
    );
    const own = card.meters.filter((m) => m.via === undefined);
    const serving = pool.filter((m) => wanted.has(omniRouteProviderOfMeter(m) ?? ''));
    out.push({
      ...card,
      meters: [...own, ...serving],
      hiddenPoolAccounts: pool.length - serving.length,
    });
  }
  return out;
}

// ── Reading summaries ───────────────────────────────────────────────────────

/** The most-consumed window of a set of meters, and whether it is cut off. */
export function worstWindow(
  meters: readonly QuotaSnapshot[],
): { meter: QuotaSnapshot; window: QuotaWindow; reached: boolean } | undefined {
  let best: { meter: QuotaSnapshot; window: QuotaWindow; reached: boolean } | undefined;
  for (const meter of meters) {
    for (const window of meter.windows) {
      if (!best || window.usedPercent > best.window.usedPercent) {
        best = { meter, window, reached: meter.reachedWindowId === window.id };
      }
    }
  }
  return best;
}

export type QuotaLevel = 'ok' | 'warn' | 'critical';

/** Advisory thresholds, not the provider's: amber at 70%, red at 90% or cut off. */
export function quotaLevel(usedPercent: number, reached: boolean): QuotaLevel {
  if (reached || usedPercent >= 90) return 'critical';
  if (usedPercent >= 70) return 'warn';
  return 'ok';
}

/** The display title of a card: its brand, else (a `custom` endpoint) its ids. */
export function cardTitle(card: Pick<QuotaCard, 'vendor' | 'aliases'>): string {
  return VENDOR_NAME[card.vendor] || card.aliases.join(', ');
}

/** The provider ids worth showing beside the brand: an alias, or several. */
export function cardSubtitle(card: Pick<QuotaCard, 'vendor' | 'aliases' | 'providerId'>): string {
  if (!VENDOR_NAME[card.vendor]) return '';
  return card.aliases.length > 1 || !CATALOG_IDS.has(card.providerId)
    ? card.aliases.join(', ')
    : '';
}

/** Accounts behind the cards: a gateway card counts each of its pool accounts. */
export function countAccounts(cards: readonly QuotaCard[]): number {
  let n = 0;
  for (const card of cards) {
    const pool = card.meters.filter((m) => m.via !== undefined).length;
    n += pool > 0 ? pool + (card.meters.length > pool ? 1 : 0) : 1;
  }
  return n;
}

// ── The Plan Quota page ─────────────────────────────────────────────────────

/** One card on the page: a provider's own plan, or one gateway pool account. */
export interface QuotaPageEntry {
  key: string;
  card: QuotaCard;
  /** Set for a pool account: its account name replaces the brand. */
  title?: string | undefined;
  subtitle?: string | undefined;
  inUse: boolean;
  /** The entry's most-consumed window, for ordering and the summary. */
  worst?: { window: QuotaWindow; reached: boolean } | undefined;
}

export interface QuotaPageSections {
  inUse: QuotaPageEntry[];
  plans: QuotaPageEntry[];
  pool: QuotaPageEntry[];
  balances: QuotaPageEntry[];
  summary: {
    accounts: number;
    warn: number;
    critical: number;
    /** The soonest reset among the windows at or past the warning line. */
    nextRelief?: { entry: QuotaPageEntry; resetsAt: number } | undefined;
  };
}

const BALANCE_VENDORS: ReadonlySet<QuotaVendor> = new Set(['deepseek', 'moonshot', 'siliconflow']);

function isBalanceOnly(card: QuotaCard): boolean {
  if (card.meters.length === 0) return BALANCE_VENDORS.has(card.vendor);
  return card.meters.every((m) => m.windows.length === 0) && card.meters.some((m) => m.credits);
}

function entryText(entry: QuotaPageEntry): string {
  return [
    entry.title ?? cardTitle(entry.card),
    entry.subtitle ?? '',
    ...entry.card.aliases,
    ...entry.card.meters.flatMap((m) => [m.meterLabel ?? '', m.planLabel ?? '']),
  ]
    .join(' ')
    .toLowerCase();
}

function severity(entry: QuotaPageEntry): number {
  if (!entry.worst) return -1;
  return entry.worst.reached ? 101 : entry.worst.window.usedPercent;
}

function byConcern(a: QuotaPageEntry, b: QuotaPageEntry): number {
  return (
    severity(b) - severity(a) ||
    (a.title ?? cardTitle(a.card)).localeCompare(b.title ?? cardTitle(b.card))
  );
}

/**
 * Lay the cards out for the page: what is in use first, then the plans, the
 * gateway pool one account per card, and the prepaid balances — each entry in
 * exactly one section, most consumed first. The summary counts every entry;
 * `filter` narrows only the sections.
 */
export function quotaPageSections(
  cards: readonly QuotaCard[],
  inUse: readonly ModelInUse[],
  filter: { query?: string | undefined; attentionOnly?: boolean | undefined } = {},
): QuotaPageSections {
  const entries: Array<{ entry: QuotaPageEntry; section: 'plans' | 'pool' | 'balances' }> = [];
  for (const card of cards) {
    const uses = inUse.filter((u) => card.aliases.includes(u.provider));
    const wanted = new Set(
      uses
        .map((u) => omniRouteProviderOfModel(u.model))
        .filter((p): p is string => p !== undefined),
    );
    const own = card.meters.filter((m) => m.via === undefined);
    const pool = card.meters.filter((m) => m.via !== undefined);
    if (own.length > 0 || pool.length === 0) {
      const ownCard: QuotaCard = { ...card, meters: own };
      const worst = worstWindow(own);
      entries.push({
        section: isBalanceOnly(ownCard) ? 'balances' : 'plans',
        entry: {
          key: card.providerId,
          card: ownCard,
          inUse: uses.length > 0,
          ...(worst ? { worst: { window: worst.window, reached: worst.reached } } : {}),
        },
      });
    }
    for (const meter of pool) {
      const worst = worstWindow([meter]);
      entries.push({
        section: 'pool',
        entry: {
          key: `${card.providerId}\u0000${meter.meterId}`,
          card: { ...card, meters: [meter] },
          title: meter.meterLabel ?? meter.meterId,
          // The gateway's name, plus its id when that is a user alias.
          subtitle: CATALOG_IDS.has(card.providerId)
            ? cardTitle(card)
            : `${cardTitle(card)} · ${card.providerId}`,
          inUse: wanted.has(omniRouteProviderOfMeter(meter) ?? ''),
          ...(worst ? { worst: { window: worst.window, reached: worst.reached } } : {}),
        },
      });
    }
  }

  let warn = 0;
  let critical = 0;
  let nextRelief: QuotaPageSections['summary']['nextRelief'];
  for (const { entry } of entries) {
    if (!entry.worst) continue;
    const level = quotaLevel(entry.worst.window.usedPercent, entry.worst.reached);
    if (level === 'ok') continue;
    if (level === 'warn') warn += 1;
    else critical += 1;
    const resetsAt = entry.worst.window.resetsAt;
    if (resetsAt !== undefined && (!nextRelief || resetsAt < nextRelief.resetsAt)) {
      nextRelief = { entry, resetsAt };
    }
  }

  const query = filter.query?.trim().toLowerCase() ?? '';
  const visible = entries.filter(({ entry }) => {
    if (query && !entryText(entry).includes(query)) return false;
    if (filter.attentionOnly) {
      return (
        entry.worst !== undefined &&
        quotaLevel(entry.worst.window.usedPercent, entry.worst.reached) !== 'ok'
      );
    }
    return true;
  });
  const pick = (section: 'plans' | 'pool' | 'balances') =>
    visible
      .filter((e) => e.section === section && !e.entry.inUse)
      .map((e) => e.entry)
      .sort(byConcern);
  return {
    inUse: visible
      .filter((e) => e.entry.inUse)
      .map((e) => e.entry)
      .sort(byConcern),
    plans: pick('plans'),
    pool: pick('pool'),
    balances: pick('balances'),
    summary: {
      accounts: entries.length,
      warn,
      critical,
      ...(nextRelief ? { nextRelief } : {}),
    },
  };
}
