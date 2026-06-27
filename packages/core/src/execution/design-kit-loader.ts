import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESIGN_STACKS,
  type DesignKitEntry,
  type DesignKitLoader,
  type DesignKitManifest,
  type DesignKitTokens,
  type DesignStack,
  isDesignStack,
} from '../types/design-kit.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

const KIT_FILE = 'KIT.md';
const TOKENS_FILE = 'tokens.json';
const FOUNDATIONS_ID = '_foundations';

/** Strip leading YAML frontmatter, returning the markdown body. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return raw;
  let body = raw.slice(end + 4);
  if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

interface KitFrontmatter {
  id?: string;
  name?: string;
  aesthetic?: string;
  bestFor?: string;
  version?: string;
  tags: string[];
  stacks: DesignStack[];
  themes: string[];
}

function parseList(value: string): string[] {
  const trimmed = value.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Minimal frontmatter parser supporting scalar fields and both inline
 * (`tags: [a, b]`) and block (`tags:\n  - a`) list syntax. Kit frontmatter is
 * authored by us (bundled) or trusted project owners, so we keep it small
 * rather than pulling in a full YAML dependency.
 */
function parseKitFrontmatter(raw: string): KitFrontmatter {
  const out: KitFrontmatter = { tags: [], stacks: [], themes: [] };
  if (!raw.startsWith('---')) return out;
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return out;
  const block = raw.slice(4, end);
  const lines = block.split('\n');
  let listKey: 'tags' | 'stacks' | 'themes' | null = null;
  const setScalar = (key: string, value: string) => {
    const v = value.trim().replace(/^["']|["']$/g, '');
    if (key === 'id') out.id = v;
    else if (key === 'name') out.name = v;
    else if (key === 'aesthetic') out.aesthetic = v;
    else if (key === 'bestFor') out.bestFor = v;
    else if (key === 'version') out.version = v;
  };
  const setList = (key: 'tags' | 'stacks' | 'themes', items: string[]) => {
    if (key === 'stacks') out.stacks = items.filter(isDesignStack);
    else out[key] = items;
  };
  for (const line of lines) {
    // Block-list item under an open list key.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (listKey && item) {
      const parsed = parseList(item[1] ?? '');
      if (listKey === 'stacks') out.stacks.push(...parsed.filter(isDesignStack));
      else out[listKey].push(...parsed);
      continue;
    }
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? '';
    const rest = (m[2] ?? '').trim();
    if (key === 'tags' || key === 'stacks' || key === 'themes') {
      if (rest) {
        setList(key, parseList(rest));
        listKey = null;
      } else {
        listKey = key;
      }
      continue;
    }
    listKey = null;
    setScalar(key, rest);
  }
  return out;
}

/**
 * Keep cross-cutting sections plus only the requested stack's `## Stack: <id>`
 * section. When no stack is given, return the body unchanged. Stack sections
 * are delimited by `## Stack: <stack-id>` headings.
 */
function narrowStackSections(body: string, stack?: DesignStack): string {
  if (!stack) return body;
  const re = /^##\s+Stack:\s*([a-z-]+)\s*$/gim;
  const matches: { id: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(body)) !== null) {
    matches.push({ id: (m[1] ?? '').trim(), start: m.index });
  }
  if (matches.length === 0) return body;
  const firstStart = matches[0]?.start ?? body.length;
  let result = body.slice(0, firstStart).trimEnd();
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    if (!cur) continue;
    const next = matches[i + 1];
    const sectionEnd = next ? next.start : body.length;
    if (cur.id === stack) {
      result += `\n\n${body.slice(cur.start, sectionEnd).trimEnd()}`;
    }
  }
  return `${result}\n`;
}

export interface DesignKitLoaderOptions {
  /** <project>/.wrongstack/design-kits */
  inProjectDir: string;
  /** ~/.wrongstack/design-kits */
  globalDir: string;
  /** Bundled kits shipped with @wrongstack/core (packages/core/design-kits). */
  bundledDir?: string | undefined;
}

/**
 * Discovery order (highest priority first; later layers are shadowed by name):
 *   1. Project-committed:  <project>/.wrongstack/design-kits/
 *   2. User-global:        ~/.wrongstack/design-kits/
 *   3. Bundled with build: packages/core/design-kits/
 *
 * The `_foundations` directory is a reserved kit id holding the mandatory
 * cross-cutting baseline; it is excluded from the selectable menu.
 */
export class DefaultDesignKitLoader implements DesignKitLoader {
  private readonly dirs: { dir: string; source: DesignKitManifest['source'] }[];
  private cache?: DesignKitManifest[] | undefined;
  private readonly bodyCache = new Map<string, string>();
  private readonly tokenCache = new Map<string, DesignKitTokens | undefined>();

  constructor(opts: DesignKitLoaderOptions) {
    this.dirs = [
      { dir: opts.inProjectDir, source: 'project' },
      { dir: opts.globalDir, source: 'user' },
    ];
    if (opts.bundledDir) this.dirs.push({ dir: opts.bundledDir, source: 'bundled' });
  }

  async list(): Promise<DesignKitManifest[]> {
    if (this.cache) return this.cache;
    const found: DesignKitManifest[] = [];
    const seen = new Set<string>();
    for (const { dir, source } of this.dirs) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // directory may not exist
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const kitFile = path.join(dir, e.name, KIT_FILE);
        try {
          const raw = await fs.readFile(kitFile, 'utf8');
          const fm = parseKitFrontmatter(raw);
          const id = fm.id ?? e.name;
          if (!fm.name) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          found.push({
            id,
            name: fm.name,
            aesthetic: fm.aesthetic ?? '',
            tags: fm.tags,
            stacks: fm.stacks.length > 0 ? fm.stacks : [...DESIGN_STACKS],
            themes: fm.themes.length > 0 ? fm.themes : ['light', 'dark'],
            bestFor: fm.bestFor ?? '',
            version: fm.version,
            path: kitFile,
            source,
          });
        } catch {
          // skip malformed kit
        }
      }
    }
    this.cache = found;
    return found;
  }

  /** Selectable kits only (excludes the reserved `_foundations` entry). */
  private async selectable(): Promise<DesignKitManifest[]> {
    return (await this.list()).filter((k) => k.id !== FOUNDATIONS_ID);
  }

  async listEntries(): Promise<DesignKitEntry[]> {
    return (await this.selectable()).map((k) => ({
      id: k.id,
      name: k.name,
      aesthetic: k.aesthetic,
      bestFor: k.bestFor,
      stacks: k.stacks,
      source: k.source,
    }));
  }

  async find(id: string): Promise<DesignKitManifest | undefined> {
    const all = await this.list();
    const lower = id.toLowerCase();
    return all.find((k) => k.id.toLowerCase() === lower);
  }

  async menuText(): Promise<string> {
    const entries = await this.listEntries();
    if (entries.length === 0) return '';
    const lines = ['## Design kits (pick ONE)'];
    for (const e of entries) {
      const stacks = e.stacks.join('/');
      lines.push(`- **${e.id}** — ${e.aesthetic}`);
      lines.push(`  Best for: ${e.bestFor} · Stacks: ${stacks}`);
    }
    return lines.join('\n');
  }

  async readBody(id: string, stack?: DesignStack): Promise<string> {
    const key = `${id.toLowerCase()}:${stack ?? '*'}`;
    const cached = this.bodyCache.get(key);
    if (cached !== undefined) return cached;
    const m = await this.find(id);
    if (!m) throw new Error(`Design kit "${id}" not found`);
    const raw = await fs.readFile(m.path, 'utf8');
    const body = narrowStackSections(stripFrontmatter(raw), stack);
    this.bodyCache.set(key, body);
    return body;
  }

  async readTokens(id: string): Promise<DesignKitTokens | undefined> {
    const key = id.toLowerCase();
    if (this.tokenCache.has(key)) return this.tokenCache.get(key);
    const m = await this.find(id);
    let tokens: DesignKitTokens | undefined;
    if (m) {
      const tokensPath = path.join(path.dirname(m.path), TOKENS_FILE);
      try {
        const raw = await fs.readFile(tokensPath, 'utf8');
        const parsed = JSON.parse(raw) as DesignKitTokens;
        tokens = parsed;
      } catch {
        tokens = undefined;
      }
    }
    this.tokenCache.set(key, tokens);
    return tokens;
  }

  async foundationsText(stack?: DesignStack): Promise<string> {
    try {
      return await this.readBody(FOUNDATIONS_ID, stack);
    } catch {
      return '';
    }
  }

  invalidateCache(): void {
    this.cache = undefined;
    this.bodyCache.clear();
    this.tokenCache.clear();
  }
}

/**
 * Resolve the bundled `design-kits/` directory shipped alongside this module.
 * The directory is a sibling of `src/` (dev) and `dist/` (built), so we probe a
 * few candidate depths relative to the compiled module location and return the
 * first that exists. Returns `undefined` if none is found (treated as "no
 * bundled kits this run").
 */
export function resolveBundledDesignKitsDir(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, 'design-kits'),
      path.join(here, '..', 'design-kits'),
      path.join(here, '..', '..', 'design-kits'),
      path.join(here, '..', '..', '..', 'design-kits'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    // ignore
  }
  return undefined;
}

const loaderMemo = new Map<string, DefaultDesignKitLoader>();

/**
 * Memoized per-project loader. Used by the `design` tool and the Design Studio
 * middleware/slash-command so they share one cached instance without threading
 * the loader through every boot path. The loader is a pure disk reader (no
 * injected services), so a module-level memo is safe.
 */
export function getDesignKitLoader(projectRoot: string): DefaultDesignKitLoader {
  const existing = loaderMemo.get(projectRoot);
  if (existing) return existing;
  const paths = resolveWstackPaths({ projectRoot });
  const loader = new DefaultDesignKitLoader({
    inProjectDir: paths.inProjectDesignKits,
    globalDir: paths.globalDesignKits,
    bundledDir: resolveBundledDesignKitsDir(),
  });
  loaderMemo.set(projectRoot, loader);
  return loader;
}

/** Test helper — clears the per-project loader memo. */
export function _resetDesignKitLoaderMemo(): void {
  loaderMemo.clear();
}
