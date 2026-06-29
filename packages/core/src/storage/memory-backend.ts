import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { MemoryEntry, MemoryScope } from '../types/memory.js';
import { MEMORY_TYPE_LABELS, type MemoryPriority, type MemoryType } from '../types/memory.js';
import { atomicWrite, ensureDir, withFileLock } from '../utils/atomic-write.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

// ── Backend interface ──────────────────────────────────────────────────

export interface MemoryBackend {
  readonly kind: string;
  remember(scope: MemoryScope, entry: MemoryEntry, filePath: string): Promise<void>;
  forget(scope: MemoryScope, query: string, filePath: string): Promise<number>;
  readAll(scope: MemoryScope, filePath: string): Promise<string>;
  list(scope: MemoryScope, filePath: string, limit?: number | undefined): Promise<MemoryEntry[]>;
  search(scope: MemoryScope, query: string, filePath: string, limit?: number | undefined): Promise<MemoryEntry[]>;
  /** Find memories related to the given text via graph traversal. Optional — falls back to search. */
  findRelated?(scope: MemoryScope, filePath: string, text: string, limit: number): Promise<MemoryEntry[]>;
  clear(scope: MemoryScope, filePath: string): Promise<void>;
  consolidate(scope: MemoryScope, filePath: string): Promise<number>;
}

// ── Entry serialization format ─────────────────────────────────────────
//
// Full format:
//   - [ISO] [TYPE|PRIORITY] mem_<id> text content #tag1 #tag2
//
// Examples:
//   - [2026-06-07T...] mem_1234_abcd Project uses pnpm #pnpm #build
//   - [2026-06-07T...] [convention|high] mem_5678_ef01 Use conventional commits #git #commit
//
// Old format (backward compatible):
//   - [ISO] mem_<id> text content

const TYPE_PRIORITY_RE = /^\[(\w+)\|(\w+)\]\s+/;
const TAG_RE = /#([\w-]+)/g;
const MAX_MEMORY_CONSOLIDATE_BACKUPS = 5;

function formatMetadata(entry: MemoryEntry): string {
  const parts: string[] = [];
  if (entry.type && entry.priority) {
    parts.push(`[${entry.type}|${entry.priority}]`);
  } else if (entry.type) {
    parts.push(`[${entry.type}]`);
  } else if (entry.priority) {
    parts.push(`[${entry.priority}]`);
  }
  if (entry.tags && entry.tags.length > 0) {
    parts.push(entry.tags.map((t) => `#${t}`).join(' '));
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function lineToEntry(line: string, scope: MemoryScope): MemoryEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('- [')) return null;

  // Parse timestamp: `- [ISO] ...`
  const tsMatch = trimmed.match(/^-\s*\[([^\]]+)\]/);
  if (!tsMatch) return null;
  const ts = tsMatch[1] ?? '';

  let rest = trimmed.slice(tsMatch[0].length).trim();

  // Parse optional type|priority: `[convention|high]` or `[fact]`
  let type: MemoryType | undefined;
  let priority: MemoryPriority | undefined;
  const tpMatch = rest.match(TYPE_PRIORITY_RE);
  if (tpMatch) {
    const a = tpMatch[1] ?? '';
    const b = tpMatch[2] ?? '';
    if (isMemoryType(a)) {
      type = a;
      priority = isPriority(b) ? b : undefined;
    } else if (isPriority(a)) {
      priority = a;
    }
    rest = rest.slice(tpMatch[0].length).trim();
  }

  // Parse optional entry ID: `mem_<ts>_<rand>`
  const idMatch = rest.match(/^mem_\d+_\w+\s+/);
  let text: string;
  if (idMatch) {
    text = rest.slice(idMatch[0].length).trim();
  } else {
    text = rest.trim();
  }

  // Extract #tags from text
  const tags: string[] = [];
  let tagMatch: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((tagMatch = TAG_RE.exec(text)) !== null) {
    tags.push(tagMatch[1] ?? '');
  }
  // Remove tags from display text
  const cleanText = text.replace(TAG_RE, '').replace(/\s{2,}/g, ' ').trim();

  if (!cleanText) return null;

  return {
    scope,
    text: cleanText,
    ts,
    type,
    priority,
    tags: tags.length > 0 ? tags : undefined,
  };
}

function isMemoryType(s: string): s is MemoryType {
  return s in MEMORY_TYPE_LABELS;
}

function isPriority(s: string): s is MemoryPriority {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

// ── Inverted index for fast search ─────────────────────────────────────

interface IndexedEntry {
  entry: MemoryEntry;
  /** Lower-cased words extracted from text. */
  words: string[];
  /** Lower-cased tags. */
  tags: string[];
}

interface InvertedIndex {
  /** word -> entry indices */
  wordMap: Map<string, number[]>;
  /** tag -> entry indices */
  tagMap: Map<string, number[]>;
  entries: IndexedEntry[];
  /** Last known file mtime for cache invalidation. */
  mtimeMs: number;
}

function buildInvertedIndex(entries: MemoryEntry[]): InvertedIndex {
  const wordMap = new Map<string, number[]>();
  const tagMap = new Map<string, number[]>();
  const indexed: IndexedEntry[] = new Array(entries.length);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const words = e.text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    const tags = (e.tags ?? []).map((t) => t.toLowerCase());
    indexed[i] = { entry: e, words, tags };

    for (const w of words) {
      const arr = wordMap.get(w);
      if (arr) arr.push(i);
      else wordMap.set(w, [i]);
    }
    for (const t of tags) {
      const arr = tagMap.get(t);
      if (arr) arr.push(i);
      else tagMap.set(t, [i]);
    }
  }

  return { wordMap, tagMap, entries: indexed, mtimeMs: 0 };
}

function searchIndex(
  index: InvertedIndex,
  query: string,
  limit?: number,
): MemoryEntry[] {
  const needles = query.toLowerCase().split(/\s+/).filter((n) => n.length > 0);
  if (needles.length === 0) return [];

  const scores = new Map<number, number>();

  for (const n of needles) {
    // Word prefix matches
    for (const [word, indices] of index.wordMap) {
      if (word.includes(n) || n.includes(word)) {
        for (const idx of indices) {
          scores.set(idx, (scores.get(idx) ?? 0) + 1);
        }
      }
    }
    // Tag matches (weighted higher)
    for (const [tag, indices] of index.tagMap) {
      if (tag.includes(n) || n.includes(tag)) {
        for (const idx of indices) {
          scores.set(idx, (scores.get(idx) ?? 0) + 2);
        }
      }
    }
  }

  if (scores.size === 0) return [];

  const scored = Array.from(scores.entries());
  scored.sort((a, b) => b[1] - a[1]);

  const result: MemoryEntry[] = [];
  const max = limit ? Math.min(limit, scored.length) : scored.length;
  for (let i = 0; i < max; i++) {
    result.push(index.entries[scored[i]![0]]!.entry);
  }
  return result;
}

// ── File-based backend ─────────────────────────────────────────────────

export interface FileMemoryBackendOptions {
  paths: WstackPaths;
}

export class FileMemoryBackend implements MemoryBackend {
  readonly kind = 'file';
  private readonly files: Record<MemoryScope, string>;
  /** Cache of parsed entries per file path. */
  private readonly entryCache = new Map<string, MemoryEntry[]>();
  /** Inverted index per file path. */
  private readonly indexCache = new Map<string, InvertedIndex>();
  /** File mtime cache for invalidation. */
  private readonly mtimeCache = new Map<string, number>();

  constructor(opts: FileMemoryBackendOptions) {
    this.files = {
      'project-agents': opts.paths.inProjectAgentsFile,
      'project-memory': opts.paths.projectMemory,
      'user-memory': opts.paths.globalMemory,
    };
  }

  private resolveFile(filePath: string, scope: MemoryScope): string {
    return filePath || this.files[scope];
  }

  private async getMtime(file: string): Promise<number> {
    try {
      const stat = await fs.stat(file);
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }

  private invalidateCache(file: string): void {
    this.entryCache.delete(file);
    this.indexCache.delete(file);
    this.mtimeCache.delete(file);
  }

  private async loadEntries(file: string, scope: MemoryScope): Promise<MemoryEntry[]> {
    const mtime = await this.getMtime(file);
    const cachedMtime = this.mtimeCache.get(file);
    if (cachedMtime === mtime && this.entryCache.has(file)) {
      return this.entryCache.get(file)!;
    }

    const raw = await this.readAll(scope, file);
    if (!raw.trim()) {
      this.entryCache.set(file, []);
      this.mtimeCache.set(file, mtime);
      return [];
    }

    const entries = parseEntries(raw, scope);
    this.entryCache.set(file, entries);
    this.mtimeCache.set(file, mtime);
    return entries;
  }

  private async getIndex(file: string, scope: MemoryScope): Promise<InvertedIndex> {
    const mtime = await this.getMtime(file);
    const cached = this.indexCache.get(file);
    if (cached && cached.mtimeMs === mtime) {
      return cached;
    }

    const entries = await this.loadEntries(file, scope);
    const index = buildInvertedIndex(entries);
    index.mtimeMs = mtime;
    this.indexCache.set(file, index);
    return index;
  }

  async remember(scope: MemoryScope, entry: MemoryEntry, filePath: string): Promise<void> {
    const file = this.resolveFile(filePath, scope);
    await ensureDir(path.dirname(file));
    let existing = '';
    try { existing = await fs.readFile(file, 'utf8'); } catch { /* new file */ }

    const id = `mem_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const meta = formatMetadata(entry);
    const line = `\n- [${entry.ts}] ${id}${meta} ${entry.text.replace(/\n/g, ' ')}\n`;
    const next = existing.trim()
      ? existing.replace(/\n+$/, '') + line
      : `# Agent Memory\n${line}`;
    await atomicWrite(file, next);
    this.invalidateCache(file);
  }

  async forget(scope: MemoryScope, query: string, filePath: string): Promise<number> {
    const file = this.resolveFile(filePath, scope);
    return withFileLock(file, async () => {
      let existing: string;
      try { existing = await fs.readFile(file, 'utf8'); } catch { return 0; /* best-effort */ }

      const needle = query.toLowerCase();
      const idMatcher = /mem_\d+_\w+/;
      let removed = 0;
      const lines = existing.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('- ')) return true;
        if (idMatcher.test(query)) {
          const entryIdMatch = /mem_\d+_\w+/.exec(trimmed);
          if (entryIdMatch && entryIdMatch[0] === query) { removed++; return false; }
        }
        if (trimmed.toLowerCase().includes(needle)) { removed++; return false; }
        return true;
      });
      if (removed > 0) {
        if (lines.length === 0 || (lines.length === 1 && !lines[0]?.trim())) {
          await atomicWrite(file, '');
        } else {
          await atomicWrite(file, lines.join('\n'));
        }
      }
      this.invalidateCache(file);
      return removed;
    });
  }

  async readAll(scope: MemoryScope, filePath: string): Promise<string> {
    const file = this.resolveFile(filePath, scope);
    try { return await fs.readFile(file, 'utf8'); } catch { return ''; /* best-effort */ }
  }

  async list(scope: MemoryScope, filePath: string, limit?: number): Promise<MemoryEntry[]> {
    const file = this.resolveFile(filePath, scope);
    const entries = await this.loadEntries(file, scope);
    return limit ? entries.slice(0, limit) : entries;
  }

  async search(scope: MemoryScope, query: string, filePath: string, limit?: number): Promise<MemoryEntry[]> {
    const file = this.resolveFile(filePath, scope);
    const index = await this.getIndex(file, scope);
    return searchIndex(index, query, limit);
  }

  async clear(scope: MemoryScope, filePath: string): Promise<void> {
    const file = this.resolveFile(filePath, scope);
    await atomicWrite(file, '');
    this.invalidateCache(file);
  }

  async consolidate(scope: MemoryScope, filePath: string): Promise<number> {
    const file = this.resolveFile(filePath, scope);
    let existing: string;
    try { existing = await fs.readFile(file, 'utf8'); } catch { return 0; /* best-effort */ }

    const seen = new Set<string>();
    let removed = 0;
    const lines = existing.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) return true;
      // Normalize: strip timestamp, ID, type|priority, tags
      const norm = trimmed
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\bmem_\d+_\w+\s*/, '')
        .replace(/#[\w-]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (seen.has(norm)) { removed++; return false; }
      seen.add(norm);
      return true;
    });

    const next = lines.join('\n');
    const backup = `${file}.bak.${Date.now()}`;
    try {
      await fs.copyFile(file, backup);
      await pruneConsolidateBackups(file);
    } catch { /* best-effort */ }
    /* v8 ignore next -- best-effort: atomicWrite failure during consolidate is non-fatal */
    try { await atomicWrite(file, next); } catch { return 0; /* best-effort */ }
    this.invalidateCache(file);
    return removed;
  }
}

async function pruneConsolidateBackups(file: string): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = `${base}.bak.`;
  const backups = (await fs.readdir(dir))
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();

  await Promise.all(
    backups.slice(MAX_MEMORY_CONSOLIDATE_BACKUPS).map(async (name) => {
      try {
        await fs.unlink(path.join(dir, name));
      } catch {
        // best-effort
      }
    }),
  );
}

// ── Entry parsing ──────────────────────────────────────────────────────

export function parseEntries(raw: string, scope: MemoryScope = 'project-memory'): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    const entry = lineToEntry(line, scope);
    if (entry) entries.push(entry);
  }
  return entries.reverse(); // newest first
}
