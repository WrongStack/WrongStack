/**
 * Dealt design direction — variety from a seeded draw, not from model taste.
 *
 * Shown the whole catalogue, a model keeps choosing the same few kits (the
 * survey's "everything converges on one look" failure, admitted even in the
 * vendors' own prompting guides). Here the choice set is dealt: a seeded
 * shuffle draws three kits for the session, skipping kits used recently
 * across projects (`design-history.json` in the profile directory). Picking a
 * kit outside the deal stays possible but needs a stated reason, which is
 * recorded with the choice. Same seed, same deal — the draw is reproducible
 * and printed. No network, no telemetry.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  DesignKitEntry,
  DesignKitLoader,
  DesignStack,
} from '@wrongstack/contracts/types/design-kit';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

export interface DesignDeal {
  seed: string;
  kits: string[];
  /** Recently used kits left out of the draw. */
  excluded: string[];
}

export interface DesignHistoryEntry {
  kit: string;
  project: string;
  at: string;
  dealt: boolean;
  reason?: string | undefined;
}

const DEAL_KEY = 'designDeal';
const HISTORY_LIMIT = 50;
const RECENT_EXCLUDE = 5;

/** FNV-1a → mulberry32: a small deterministic PRNG keyed by a string. */
function rng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/**
 * Draw `count` kits: supported on `stack`, not in `exclude`, and — when a
 * `query` is given and at least `count` kits match its words in their
 * name/aesthetic/best-for text — only from those. Deterministic for a seed.
 */
function dealKits(
  entries: readonly DesignKitEntry[],
  opts: {
    seed: string;
    count?: number;
    exclude?: readonly string[];
    stack?: DesignStack | undefined;
    query?: string | undefined;
  },
): DesignKitEntry[] {
  const count = opts.count ?? 3;
  const excluded = new Set(opts.exclude ?? []);
  let pool = entries.filter(
    (e) => !excluded.has(e.id) && (!opts.stack || e.stacks.includes(opts.stack)),
  );
  // Too few left after exclusion: fall back to the stack filter alone.
  if (pool.length < count)
    pool = entries.filter((e) => !opts.stack || e.stacks.includes(opts.stack));
  if (opts.query) {
    const want = words(opts.query);
    const matching = pool.filter((e) => {
      const have = words(`${e.name} ${e.aesthetic} ${e.bestFor}`);
      return [...want].some((w) => have.has(w));
    });
    if (matching.length >= count) pool = matching;
  }
  const next = rng(opts.seed);
  const shuffled = [...pool].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as DesignKitEntry, shuffled[i] as DesignKitEntry];
  }
  return shuffled.slice(0, count);
}

function historyFile(projectRoot: string): string {
  return path.join(resolveWstackPaths({ projectRoot }).configDir, 'design-history.json');
}

async function readDesignHistory(projectRoot: string): Promise<DesignHistoryEntry[]> {
  try {
    const raw = JSON.parse(
      (await fs.readFile(historyFile(projectRoot), 'utf8')).replace(/^﻿/, ''),
    ) as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (e): e is DesignHistoryEntry => !!e && typeof (e as DesignHistoryEntry).kit === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** Append a kit choice; the file keeps the latest {@link HISTORY_LIMIT}. Best-effort. */
export async function recordDesignChoice(
  projectRoot: string,
  entry: Omit<DesignHistoryEntry, 'project' | 'at'>,
): Promise<void> {
  try {
    const history = await readDesignHistory(projectRoot);
    history.push({
      ...entry,
      project: path.basename(path.resolve(projectRoot)),
      at: new Date().toISOString(),
    });
    const file = historyFile(projectRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(history.slice(-HISTORY_LIMIT), null, 2)}\n`);
  } catch {
    // History is advisory; a read-only profile must not block a kit choice.
  }
}

/** Distinct kits chosen most recently, newest first. */
function recentDesignKits(history: readonly DesignHistoryEntry[], n = RECENT_EXCLUDE): string[] {
  const out: string[] = [];
  for (let i = history.length - 1; i >= 0 && out.length < n; i--) {
    const kit = history[i]?.kit;
    if (kit && !out.includes(kit)) out.push(kit);
  }
  return out;
}

type DealCtx = { meta: Record<string, unknown>; projectRoot: string };

export function getDesignDeal(ctx: Pick<DealCtx, 'meta'>): DesignDeal | undefined {
  return ctx.meta[DEAL_KEY] as DesignDeal | undefined;
}

/**
 * The session's deal, drawn once and kept on ctx.meta so the injected menu
 * and the `use` check agree. A new draw (`redeal`) uses a fresh,
 * printed seed; passing that seed back reproduces the deal.
 */
export async function ensureDesignDeal(
  ctx: DealCtx,
  loader: DesignKitLoader,
  opts?: {
    stack?: DesignStack | undefined;
    query?: string | undefined;
    seed?: string | undefined;
    redeal?: boolean;
  },
): Promise<{ deal: DesignDeal; entries: DesignKitEntry[] }> {
  const entries = await loader.listEntries();
  const existing = getDesignDeal(ctx);
  if (existing && !opts?.redeal && !opts?.seed && !opts?.query) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return {
      deal: existing,
      entries: existing.kits.map((id) => byId.get(id)).filter((e): e is DesignKitEntry => !!e),
    };
  }
  const draws = (Number(ctx.meta[`${DEAL_KEY}Count`]) || 0) + 1;
  ctx.meta[`${DEAL_KEY}Count`] = draws;
  const seed =
    opts?.seed ??
    `${path.basename(path.resolve(ctx.projectRoot))}-${Date.now().toString(36)}-${draws}`;
  const excluded = recentDesignKits(await readDesignHistory(ctx.projectRoot));
  const picked = dealKits(entries, {
    seed,
    exclude: excluded,
    stack: opts?.stack,
    query: opts?.query,
  });
  const deal: DesignDeal = { seed, kits: picked.map((e) => e.id), excluded };
  ctx.meta[DEAL_KEY] = deal;
  return { deal, entries: picked };
}

/** The injected-menu / tool rendering of a deal. */
export function renderDesignDeal(deal: DesignDeal, picked: readonly DesignKitEntry[]): string {
  return [
    `Dealt for this session (seed "${deal.seed}"${deal.excluded.length ? `; recently used and left out: ${deal.excluded.join(', ')}` : ''}):`,
    ...picked.map((e) => `- **${e.id}** — ${e.name}: ${e.aesthetic} Best for: ${e.bestFor}`),
    'Choose the one that fits the product, say why, and pin it before writing UI: ' +
      '`design {action:"use", kit:"<id>"}` — naming a kit in prose pins nothing, and until one is ' +
      'pinned your UI writes are not checked against its tokens. `design {action:"list"}` shows ' +
      'every kit; choosing one outside this deal needs `reason`, which is recorded.',
  ].join('\n');
}
