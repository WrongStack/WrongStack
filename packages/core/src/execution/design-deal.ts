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
  DesignKitAxes,
  DesignKitEntry,
  DesignKitLoader,
  DesignStack,
} from '@wrongstack/contracts/types/design-kit';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import { formatKitAxesTriple } from './design-material.js';

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
  axes?: DesignKitAxes | undefined;
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

function entryWords(e: DesignKitEntry): Set<string> {
  return words(
    `${e.id.replace(/-/g, ' ')} ${e.name} ${e.aesthetic} ${e.bestFor} ${e.material ?? ''} ${(e.tags ?? []).join(' ')} ${e.posture ?? ''}`,
  );
}

/**
 * IDF-weighted query narrowing: rare domain terms ("editorial", "ceramic",
 * "brutalist", "clinical") outweigh generic words ("apps", "modern", "web").
 */
function narrowPoolByIdf(
  pool: readonly DesignKitEntry[],
  query: string,
  count: number,
): DesignKitEntry[] {
  const want = [...words(query)];
  if (want.length === 0) return [...pool];
  const docs = pool.map((entry) => ({
    entry,
    all: entryWords(entry),
    tags: words(`${entry.id.replace(/-/g, ' ')} ${(entry.tags ?? []).join(' ')}`),
  }));
  const df = new Map<string, number>();
  for (const w of want) {
    let hits = 0;
    for (const d of docs) {
      if (d.all.has(w)) hits++;
    }
    if (hits > 0) df.set(w, hits);
  }
  const scored = docs
    .map((d) => {
      let score = 0;
      for (const w of want) {
        if (!d.all.has(w)) continue;
        const idf = Math.log(1 + pool.length / (df.get(w) ?? 1));
        score += idf * (d.tags.has(w) ? 1.35 : 1);
      }
      return { entry: d.entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  if (scored.length < count) return [...pool];
  const topScore = scored[0]?.score ?? 0;
  const floor = topScore * 0.65;
  const highSignal = scored.filter((s) => s.score >= floor);
  const keepCount = Math.max(count * 2, 6);
  const chosen =
    highSignal.length >= count
      ? highSignal
      : scored.slice(0, Math.min(scored.length, Math.max(count, keepCount)));
  return chosen.map((s) => s.entry);
}

/**
 * Select `count` kits from an already seeded-shuffled pool while maximizing
 * 3D visual coordinate spread (`paper`, `display`, `accent`) and avoiding
 * axis collisions with the most recent history choice when alternatives exist.
 */
function selectAxisDiverse(
  shuffled: readonly DesignKitEntry[],
  count: number,
  recentAxes: readonly DesignKitAxes[] = [],
): DesignKitEntry[] {
  if (shuffled.length <= count || !shuffled.some((e) => e.axes)) {
    return shuffled.slice(0, count);
  }
  const picked: DesignKitEntry[] = [];
  const usedIds = new Set<string>();
  const lastTriple = recentAxes[0] ? formatKitAxesTriple(recentAxes[0]) : undefined;

  // Slot 0: take the first kit in the seeded shuffle that doesn't collide on all
  // 3 axes with the immediately preceding session's pick (fallback to shuffled[0]).
  const first =
    (lastTriple
      ? shuffled.find((e) => !e.axes || formatKitAxesTriple(e.axes) !== lastTriple)
      : undefined) ?? shuffled[0];
  if (!first) return [];
  picked.push(first);
  usedIds.add(first.id);

  while (picked.length < count && picked.length < shuffled.length) {
    const papers = new Set(picked.map((p) => p.axes?.paper).filter(Boolean));
    const displays = new Set(picked.map((p) => p.axes?.display).filter(Boolean));
    const accents = new Set(picked.map((p) => p.axes?.accent).filter(Boolean));
    const triples = new Set(
      picked.map((p) => (p.axes ? formatKitAxesTriple(p.axes) : '')).filter(Boolean),
    );

    let best: DesignKitEntry | undefined;
    let bestDiversity = -1;
    for (const cand of shuffled) {
      if (usedIds.has(cand.id)) continue;
      let diversity = 0;
      if (cand.axes) {
        const triple = formatKitAxesTriple(cand.axes);
        if (!triples.has(triple)) diversity += 2;
        if (!papers.has(cand.axes.paper)) diversity += 3;
        if (!displays.has(cand.axes.display)) diversity += 3;
        if (!accents.has(cand.axes.accent)) diversity += 1;
        if (lastTriple && triple !== lastTriple) diversity += 1;
      }
      if (diversity > bestDiversity) {
        bestDiversity = diversity;
        best = cand;
      }
    }
    if (!best) break;
    picked.push(best);
    usedIds.add(best.id);
  }
  return picked;
}

/**
 * Draw `count` kits: supported on `stack`, not in `exclude`, and — when a
 * `query` is given and at least `count` kits match its words — narrowed by IDF
 * relevance, then spread across `paper/display/accent` axes. Deterministic for a seed.
 */
export function dealKits(
  entries: readonly DesignKitEntry[],
  opts: {
    seed: string;
    count?: number;
    exclude?: readonly string[];
    recentAxes?: readonly DesignKitAxes[];
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
    pool = narrowPoolByIdf(pool, opts.query, count);
  }
  const next = rng(opts.seed);
  const shuffled = [...pool].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j] as DesignKitEntry, shuffled[i] as DesignKitEntry];
  }
  return selectAxisDiverse(shuffled, count, opts.recentAxes);
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
  const history = await readDesignHistory(ctx.projectRoot);
  const excluded = recentDesignKits(history);
  const recentAxes = history
    .slice(-RECENT_EXCLUDE)
    .reverse()
    .map((h) => h.axes)
    .filter((a): a is DesignKitAxes => !!a);
  const picked = dealKits(entries, {
    seed,
    exclude: excluded,
    recentAxes,
    stack: opts?.stack,
    query: opts?.query,
  });
  const kits = picked.map((e) => e.id);
  // A small catalogue falls back to the full pool; a kit dealt anyway was not left out.
  const deal: DesignDeal = { seed, kits, excluded: excluded.filter((id) => !kits.includes(id)) };
  ctx.meta[DEAL_KEY] = deal;
  return { deal, entries: picked };
}

/** The injected-menu / tool rendering of a deal. */
export function renderDesignDeal(deal: DesignDeal, picked: readonly DesignKitEntry[]): string {
  return [
    `Dealt for this session (seed "${deal.seed}"${deal.excluded.length ? `; recently used and left out: ${deal.excluded.join(', ')}` : ''}):`,
    ...picked.map((e) => {
      const coords = e.axes ? ` [${formatKitAxesTriple(e.axes)}]` : '';
      const mat = e.material ? ` Material: ${e.material}` : '';
      return `- **${e.id}**${coords} — ${e.name}: ${e.aesthetic} Best for: ${e.bestFor}${mat}`;
    }),
    'Choose the one that fits the product, say why, and pin it before writing UI: ' +
      '`design {action:"use", kit:"<id>"}` — naming a kit in prose pins nothing, and until one is ' +
      'pinned your UI writes are not checked against its tokens. `design {action:"list"}` shows ' +
      'every kit; choosing one outside this deal needs `reason`, which is recorded.',
  ].join('\n');
}
