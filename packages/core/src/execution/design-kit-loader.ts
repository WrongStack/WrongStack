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
import { stripFrontmatter } from '../skills/frontmatter.js';
import { resolveWstackPaths } from '../utils/wstack-paths.js';

const KIT_FILE = 'KIT.md';
const TOKENS_FILE = 'tokens.json';
const FOUNDATIONS_ID = '_foundations';

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
    const bulletMatch = /^\s*-\s+(.*)$/.exec(line);
    if (listKey && bulletMatch) {
      const parsed = parseList(bulletMatch[1] ?? '');
      if (listKey === 'stacks') out.stacks.push(...parsed.filter(isDesignStack));
      else out[listKey].push(...parsed);
      continue;
    }
    const kvMatch = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1] ?? '';
    const rest = (kvMatch[2] ?? '').trim();
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
  const stackHeading = /^##\s+Stack:\s*([a-z-]+)\s*$/gim;
  const sections: { id: string; start: number }[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = stackHeading.exec(body)) !== null) {
    sections.push({ id: (match[1] ?? '').trim(), start: match.index });
  }
  if (sections.length === 0) return body;

  // Everything before the first `## Stack:` heading is cross-cutting content.
  const preambleEnd = sections[0]!.start;
  let result = body.slice(0, preambleEnd).trimEnd();

  let sectionEnd: number;
  for (let i = 0; i < sections.length; i++) {
    const current = sections[i]!;
    // Each section runs from its heading to the next heading (or end-of-body).
    sectionEnd = i + 1 < sections.length ? sections[i + 1]!.start : body.length;
    if (current.id === stack) {
      result += `\n\n${body.slice(current.start, sectionEnd).trimEnd()}`;
    }
  }
  return `${result}\n`;
}

export interface DesignKitLoaderOptions {
  /** <project>/.wrongstack/design-kits */
  inProjectDir: string;
  /** ~/.wrongstack/profiles/<name>/design-kits */
  globalDir: string;
  /** Bundled kits shipped with @wrongstack/core (packages/core/design-kits). */
  bundledDir?: string | undefined;
}

/**
 * Discovery order (highest priority first; later layers are shadowed by name):
 *   1. Project-committed:  <project>/.wrongstack/design-kits/
 *   2. User profile:       ~/.wrongstack/profiles/<name>/design-kits/
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
  private readonly rawTokenCache = new Map<string, DesignKitTokens | undefined>();

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

  /** Read a kit's OWN tokens.json (no foundations merge). Cached per id. */
  private async readRawTokens(id: string): Promise<DesignKitTokens | undefined> {
    const key = id.toLowerCase();
    if (this.rawTokenCache.has(key)) return this.rawTokenCache.get(key);
    const m = await this.find(id);
    let tokens: DesignKitTokens | undefined;
    if (m) {
      const tokensPath = path.join(path.dirname(m.path), TOKENS_FILE);
      try {
        const raw = await fs.readFile(tokensPath, 'utf8');
        tokens = JSON.parse(raw) as DesignKitTokens;
      } catch {
        tokens = undefined;
      }
    }
    this.rawTokenCache.set(key, tokens);
    return tokens;
  }

  /**
   * Read a kit's tokens with the `_foundations` base scales merged UNDER them
   * (kit values win, per theme). This is why every kit resolves a full
   * radius/space/type/motion scale even though its tokens.json only lists the
   * axes it changes. `_foundations` itself is returned raw (no self-merge).
   */
  async readTokens(id: string): Promise<DesignKitTokens | undefined> {
    const key = id.toLowerCase();
    if (this.tokenCache.has(key)) return this.tokenCache.get(key);
    let tokens: DesignKitTokens | undefined;
    if (key === FOUNDATIONS_ID) {
      tokens = await this.readRawTokens(FOUNDATIONS_ID);
    } else {
      const own = await this.readRawTokens(id);
      const base = await this.readRawTokens(FOUNDATIONS_ID);
      tokens = mergeKitTokens(base, own);
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
    this.rawTokenCache.clear();
  }
}

/**
 * Merge foundations base scales UNDER a kit's own tokens, per theme (kit wins).
 * Returns undefined only when neither side has tokens. When a kit ships a single
 * theme, the other theme still resolves from the foundations base — so every
 * kit has a complete light AND dark scale set.
 */
function mergeKitTokens(
  base: DesignKitTokens | undefined,
  own: DesignKitTokens | undefined,
): DesignKitTokens | undefined {
  if (!base && !own) return undefined;
  if (!base) return own;
  if (!own) return base;
  const mergeTheme = (
    b: Record<string, string> | undefined,
    o: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!b && !o) return undefined;
    return { ...(b ?? {}), ...(o ?? {}) };
  };
  const light = mergeTheme(base.light, own.light);
  const dark = mergeTheme(base.dark, own.dark);
  const out: DesignKitTokens = {};
  if (light) out.light = light;
  if (dark) out.dark = dark;
  return out;
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
const LOADER_MEMO_MAX_PROJECTS = 32;

/**
 * Memoized per-project loader. Used by the `design` tool and the Design Studio
 * middleware/slash-command so they share one cached instance without threading
 * the loader through every boot path. The loader is a pure disk reader (no
 * injected services), so a module-level memo is safe.
 */
export function getDesignKitLoader(projectRoot: string): DefaultDesignKitLoader {
  const existing = loaderMemo.get(projectRoot);
  if (existing) {
    loaderMemo.delete(projectRoot);
    loaderMemo.set(projectRoot, existing);
    return existing;
  }
  const paths = resolveWstackPaths({ projectRoot });
  const loader = new DefaultDesignKitLoader({
    inProjectDir: paths.inProjectDesignKits,
    globalDir: paths.globalDesignKits,
    bundledDir: resolveBundledDesignKitsDir(),
  });
  while (loaderMemo.size >= LOADER_MEMO_MAX_PROJECTS) {
    const oldest = loaderMemo.keys().next().value;
    if (oldest === undefined) break;
    loaderMemo.delete(oldest);
  }
  loaderMemo.set(projectRoot, loader);
  return loader;
}

/** Test helper — clears the per-project loader memo. */
export function _resetDesignKitLoaderMemo(): void {
  loaderMemo.clear();
}
