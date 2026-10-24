import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isBuiltinCategory,
  PROMPT_CATEGORY_LABELS,
  type PromptCategoryCount,
  type PromptEntry,
  type PromptLoader,
  type PromptSearchOptions,
} from '@wrongstack/contracts/types/prompt';
import { DefaultPromptStore, migratePromptEntry } from '../storage/prompt-store.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

export interface PromptLoaderOptions {
  paths: WstackPaths;
  /** Directory containing the bundled dataset (`data/prompts`), if shipped. */
  bundledDir?: string | undefined;
}

/**
 * DefaultPromptLoader — read-side view over the three prompt layers, merged and
 * de-duplicated by `slug`. Mirrors `DefaultSkillLoader`.
 *
 * Discovery order (higher priority shadows lower by slug):
 *   1. Project-committed:  <project>/.wrongstack/prompts/   (writable, source 'project')
 *   2. User profile:       ~/.wrongstack/profiles/<name>/prompts/ (writable, source 'user'/'synced')
 *   3. Bundled with build:  <core>/data/prompts/prompts/**  (read-only, source 'builtin')
 *
 * Writes go to the user layer by default (or the project layer when
 * `scope:'project'`). Favoriting/editing a builtin copies it down into the user
 * layer (copy-on-write) so the read-only dataset is never mutated.
 */
export class DefaultPromptLoader implements PromptLoader {
  private readonly projectStore?: DefaultPromptStore | undefined;
  private readonly userStore?: DefaultPromptStore | undefined;
  private readonly builtinDir?: string | undefined;
  private cache?: PromptEntry[] | undefined;
  private builtinCache?: PromptEntry[] | undefined;

  constructor(opts: PromptLoaderOptions) {
    // Guard each layer dir: a partial WstackPaths (or a globalRoot-only test
    // setup) may omit one. A missing dir just means that layer is empty.
    this.projectStore =
      typeof opts.paths.inProjectPrompts === 'string'
        ? new DefaultPromptStore(opts.paths.inProjectPrompts)
        : undefined;
    this.userStore =
      typeof opts.paths.globalPrompts === 'string'
        ? new DefaultPromptStore(opts.paths.globalPrompts)
        : undefined;
    this.builtinDir = opts.bundledDir ? path.join(opts.bundledDir, 'prompts') : undefined;
  }

  async list(): Promise<PromptEntry[]> {
    if (this.cache) return this.cache;
    const seen = new Set<string>();
    const out: PromptEntry[] = [];
    const layers: PromptEntry[][] = [
      (await (this.projectStore?.list() ?? Promise.resolve([]))).map((e) => ({
        ...e,
        source: 'project' as const,
      })),
      await (this.userStore?.list() ?? Promise.resolve([])), // keeps stored source ('user' or 'synced')
      await this.readBuiltin(),
    ];
    for (const layer of layers) {
      for (const e of layer) {
        if (seen.has(e.slug)) continue;
        seen.add(e.slug);
        out.push(e);
      }
    }
    this.cache = out;
    return out;
  }

  async find(slugOrId: string): Promise<PromptEntry | undefined> {
    const all = await this.list();
    return all.find((e) => e.slug === slugOrId) ?? all.find((e) => e.id === slugOrId);
  }

  async search(query: string, opts: PromptSearchOptions = {}): Promise<PromptEntry[]> {
    let pool = await this.list();
    if (opts.category) pool = pool.filter((e) => e.category === opts.category);

    const q = query.trim().toLowerCase();
    let results: PromptEntry[];
    if (!q) {
      results = pool;
    } else {
      const tokens = q.split(/\s+/).filter(Boolean);
      results = pool
        .map((e) => ({ e, score: scorePrompt(e, tokens) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.e);
    }
    return typeof opts.limit === 'number' ? results.slice(0, opts.limit) : results;
  }

  async categories(): Promise<PromptCategoryCount[]> {
    const all = await this.list();
    const counts = new Map<string, number>();
    for (const e of all) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({
        id,
        label: isBuiltinCategory(id) ? PROMPT_CATEGORY_LABELS[id] : id,
        count,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  async save(entry: PromptEntry, opts: { scope?: 'user' | 'project' } = {}): Promise<void> {
    const store = opts.scope === 'project' ? this.projectStore : this.userStore;
    if (!store)
      throw new Error(`Prompt ${opts.scope ?? 'user'} layer is not writable (no directory).`);
    // Never persist `source:'builtin'` into a writable layer — that would let a
    // user copy masquerade as read-only. Demote to the layer it's written to.
    const normalized: PromptEntry =
      entry.source === 'builtin'
        ? {
            ...entry,
            source: opts.scope === 'project' ? 'project' : 'user',
            forkedFrom: entry.forkedFrom ?? entry.slug,
          }
        : entry;
    await store.save(normalized);
    this.invalidateCache();
  }

  async delete(slugOrId: string): Promise<boolean> {
    const entry = await this.find(slugOrId);
    if (!entry) return false;
    if (entry.source === 'builtin') return false; // read-only
    const store = entry.source === 'project' ? this.projectStore : this.userStore;
    if (!store) return false;
    const ok = await store.delete(entry.id);
    if (ok) this.invalidateCache();
    return ok;
  }

  async setFavorite(slugOrId: string, favorite: boolean): Promise<PromptEntry | undefined> {
    const entry = await this.find(slugOrId);
    if (!entry) return undefined;
    const now = new Date().toISOString();

    if (entry.source === 'builtin') {
      // Copy-on-write: materialize a user-layer copy that shadows the builtin.
      if (!this.userStore) return undefined;
      const copy: PromptEntry = {
        ...entry,
        favorite,
        source: 'user',
        forkedFrom: entry.slug,
        updatedAt: now,
      };
      await this.userStore.save(copy);
      this.invalidateCache();
      return copy;
    }

    const updated: PromptEntry = { ...entry, favorite, updatedAt: now };
    const store = entry.source === 'project' ? this.projectStore : this.userStore;
    if (!store) return undefined;
    await store.save(updated);
    this.invalidateCache();
    return updated;
  }

  invalidateCache(): void {
    this.cache = undefined;
    this.builtinCache = undefined;
  }

  private async readBuiltin(): Promise<PromptEntry[]> {
    if (this.builtinCache) return this.builtinCache;
    const dir = this.builtinDir;
    if (!dir) {
      this.builtinCache = [];
      return [];
    }
    const out: PromptEntry[] = [];
    const files = await walkJson(dir);
    for (const file of files) {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        // Builtin files store a bare PromptEntry (no { version, entry } wrapper).
        const migrated = migratePromptEntry(parsed);
        if (migrated) out.push({ ...migrated, source: 'builtin' });
      } catch {
        // skip malformed builtin file
      }
    }
    this.builtinCache = out;
    return out;
  }
}

/** Recursively collect `*.json` paths under `dir` (skips `index.json`/`schema.json`). */
async function walkJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkJson(full)));
    } else if (e.name.endsWith('.json') && e.name !== 'index.json' && e.name !== 'schema.json') {
      out.push(full);
    }
  }
  return out;
}

function scorePrompt(e: PromptEntry, tokens: string[]): number {
  const title = e.title.toLowerCase();
  const slug = e.slug.toLowerCase();
  const desc = e.description.toLowerCase();
  const cat = e.category.toLowerCase();
  const tags = e.tags.map((t) => t.toLowerCase());
  const content = e.content.toLowerCase();

  let score = 0;
  for (const tok of tokens) {
    let hit = 0;
    if (title.includes(tok)) hit += 5;
    if (slug.includes(tok)) hit += 4;
    if (tags.some((t) => t.includes(tok))) hit += 3;
    if (desc.includes(tok)) hit += 2;
    if (cat.includes(tok)) hit += 2;
    if (content.includes(tok)) hit += 1;
    // Fuzzy fallback: a typo / abbreviation ("dpl" → "deploy") still matches if
    // the token's characters appear in order in the most relevant fields. Scored
    // low so exact substring hits always rank above fuzzy ones.
    if (hit === 0 && tok.length >= 3) {
      if (isSubsequence(tok, title)) hit += 2;
      else if (isSubsequence(tok, slug)) hit += 2;
      else if (tags.some((t) => isSubsequence(tok, t))) hit += 1;
    }
    if (hit === 0) return 0; // every token must match somewhere (AND semantics)
    score += hit;
  }
  if (e.favorite) score += 1; // gentle tiebreak toward favorites
  return score;
}

/** True when every char of `needle` appears in `hay`, in order (subsequence). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Fill a prompt's `{{variable}}` placeholders with `values`. Unknown
 * placeholders are left intact unless a declared variable supplies a `default`.
 * Returns the rendered string, any required variables left unfilled
 * (`missing`), and any supplied values outside a variable's declared `enum`
 * (`invalid`).
 */
export function renderPrompt(
  entry: PromptEntry,
  values: Record<string, string> = {},
  level?: 'simple' | 'detailed' | 'advanced',
): { text: string; missing: string[]; invalid: string[] } {
  const declared = new Map((entry.variables ?? []).map((v) => [v.name, v]));
  const missing: string[] = [];
  const invalid: string[] = [];

  const content = (level && entry.variants?.[level]) || entry.content;
  const text = content.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, rawName: string) => {
    const name = rawName.trim();
    if (Object.hasOwn(values, name) && values[name] !== undefined && values[name] !== '') {
      return values[name] as string;
    }
    const decl = declared.get(name);
    if (decl?.default !== undefined) return decl.default;
    if (decl?.required && !missing.includes(name)) missing.push(name);
    return whole; // leave the placeholder untouched
  });

  // Surface declared-but-never-referenced required vars too.
  for (const v of entry.variables ?? []) {
    const supplied =
      Object.hasOwn(values, v.name) && values[v.name] !== undefined && values[v.name] !== '';
    if (v.required && !supplied && v.default === undefined && !missing.includes(v.name)) {
      // Only report if the placeholder actually exists in content; otherwise ignore.
      if (new RegExp(`\\{\\{\\s*${escapeRegExp(v.name)}\\s*\\}\\}`).test(content)) {
        missing.push(v.name);
      }
    }
    // Reject a supplied value that isn't one of the declared enum options.
    if (
      v.enum &&
      v.enum.length > 0 &&
      Object.hasOwn(values, v.name) &&
      values[v.name] !== undefined &&
      values[v.name] !== '' &&
      !v.enum.includes(values[v.name] as string)
    ) {
      invalid.push(v.name);
    }
  }

  return { text, missing, invalid };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
