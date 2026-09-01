/**
 * semantic-search-indexer plugin — lightweight keyword-based search over
 * project source files.
 *
 * The plugin builds an in-memory inverted index (no persistence, no
 * embeddings) and exposes two tools:
 *
 *  - `semantic_search`       — ranked keyword search with TF scoring
 *  - `semantic_index_status` — index counters and configuration
 *
 * Files are tokenized into lowercase alphanumeric terms and indexed with
 * per-document term frequencies. Queries are scored by summing the TF of
 * each matched query token, then results are returned with the matching
 * file path, score, and a handful of matched lines.
 *
 * Config (`config.extensions['semantic-search-indexer']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "includeExtensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "excludePatterns": ["node_modules", "\\.git", "dist"],
 *   "maxFileBytes": 1_000_000,
 *   "defaultLimit": 10,
 *   "minTokenLength": 2,
 *   "maxMatchesPerFile": 10,
 *   "maxFiles": 5000
 * }
 * ```
 *
 * @public
 */

import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { DEFAULT_WALK_IGNORE_DIRS } from '@wrongstack/core/utils';

const API_VERSION = '^0.1.10';

/** Regex-escape a literal directory name for use in `excludePatterns`. */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface Posting {
  tf: number;
}

interface FileEntry {
  lines: string[];
  size: number;
  /** Absolute path as walked — lets the delete-prune stat exactly this file. */
  absPath: string;
}

interface InvertedIndex {
  terms: Map<string, Map<string, Posting>>;
  files: Map<string, FileEntry>;
}

interface SemanticSearchState {
  index: InvertedIndex | null;
  cachedPath: string | null;
  fileCount: number;
  termCount: number;
  bytesIndexed: number;
  truncated: boolean;
  queryCount: number;
  reindexCount: number;
  buildPromise: Promise<void> | null;
  buildGeneration: number;
  publishedGeneration: number;
  hookUnregister: (() => void) | null;
  /** Unregister for the deletion-tool prune hook (PostToolUse on shell tools). */
  deleteHookUnregister: (() => void) | null;
  /** Throttle stamp for the post-delete prune stat-scan. */
  lastPruneAt: number;
  /** In-flight prune pass — overlapping delete events share one scan. */
  pruneInFlight: Promise<number> | null;
}

const state: SemanticSearchState = {
  index: null,
  cachedPath: null,
  fileCount: 0,
  termCount: 0,
  bytesIndexed: 0,
  truncated: false,
  queryCount: 0,
  reindexCount: 0,
  buildPromise: null,
  buildGeneration: 0,
  publishedGeneration: 0,
  hookUnregister: null,
  deleteHookUnregister: null,
  lastPruneAt: 0,
  pruneInFlight: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SemanticSearchConfig {
  enabled: boolean;
  includeExtensions: string[];
  excludePatterns: string[];
  maxFileBytes: number;
  defaultLimit: number;
  minTokenLength: number;
  maxMatchesPerFile: number;
  maxFiles: number;
}

const DEFAULTS: SemanticSearchConfig = {
  enabled: true,
  includeExtensions: [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.java',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.cpp',
    '.c',
    '.h',
    '.cs',
    '.swift',
    '.kt',
    '.scala',
    '.sh',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.css',
    '.scss',
    '.html',
  ],
  excludePatterns: [
    ...DEFAULT_WALK_IGNORE_DIRS.map(escapeRegex),
    '\\.wrongstack',
    '\\.temp_files',
  ],
  maxFileBytes: 1_000_000,
  defaultLimit: 10,
  minTokenLength: 2,
  maxMatchesPerFile: 10,
  maxFiles: 5_000,
};

export function readConfig(raw: unknown): SemanticSearchConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, includeExtensions: [...DEFAULTS.includeExtensions], excludePatterns: [...DEFAULTS.excludePatterns] };
  const r = raw as Record<string, unknown>;

  const rawExts = r['includeExtensions'] ?? r['include_extensions'] ?? r['extensions'] ?? r['file_extensions'];
  const includeExtensions = Array.isArray(rawExts)
    ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
    : [...DEFAULTS.includeExtensions];

  const rawExclude = r['excludePatterns'] ?? r['exclude_patterns'] ?? r['exclude'];
  const excludePatterns = Array.isArray(rawExclude)
    ? (rawExclude as unknown[]).filter((x): x is string => typeof x === 'string')
    : [...DEFAULTS.excludePatterns];

  const clamp = (v: unknown, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback;

  const rawBytes = r['maxFileBytes'] ?? r['max_file_bytes'] ?? r['maxBytes'] ?? r['max_bytes'];
  const rawLimit = r['defaultLimit'] ?? r['default_limit'] ?? r['limit'];
  const rawMaxFiles = r['maxFiles'] ?? r['max_files'];

  return {
    enabled: r['enabled'] !== false,
    includeExtensions,
    excludePatterns,
    maxFileBytes: clamp(rawBytes, 1_024, 50_000_000, DEFAULTS.maxFileBytes),
    defaultLimit: clamp(rawLimit, 1, 1_000, DEFAULTS.defaultLimit),
    minTokenLength: clamp(r['minTokenLength'], 1, 10, DEFAULTS.minTokenLength),
    maxMatchesPerFile: clamp(r['maxMatchesPerFile'], 1, 100, DEFAULTS.maxMatchesPerFile),
    maxFiles: clamp(rawMaxFiles, 1, 50_000, DEFAULTS.maxFiles),
  };
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function withinProject(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  const root = normalizeSlashes(process.cwd());
  const resolved = normalizeSlashes(isAbsolute(p) ? resolve(p) : resolve(root, p));
  const rel = normalizeSlashes(relative(root, resolved));
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function resolveProjectPath(p: string | undefined): string | null {
  const raw = typeof p === 'string' && p.length > 0 ? p : '.';
  if (!withinProject(raw)) return null;
  const root = normalizeSlashes(process.cwd());
  return normalizeSlashes(isAbsolute(raw) ? resolve(raw) : resolve(root, raw));
}

// ---------------------------------------------------------------------------
// Tokenization + indexing
// ---------------------------------------------------------------------------

function tokenize(text: string, minLength: number): string[] {
  const tokens: string[] = [];
  for (const match of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (match.length >= minLength) tokens.push(match);
  }
  return tokens;
}

function compileExcludes(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p));
    } catch {
      // skip invalid patterns
    }
  }
  return out;
}

function shouldIndexFile(filePath: string, cfg: SemanticSearchConfig): boolean {
  if (cfg.includeExtensions.length === 0) return true;
  const lower = filePath.toLowerCase();
  for (const ext of cfg.includeExtensions) {
    if (lower.endsWith(ext.toLowerCase())) return true;
  }
  return false;
}

const INDEX_BATCH_SIZE = 32;
const YIELD_EVERY_FILES = 64;

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function addFileToIndex(
  relPath: string,
  absPath: string,
  content: string,
  size: number,
  cfg: SemanticSearchConfig,
): void {
  if (!state.index || content.includes('\u0000')) return; // skip binary-looking files

  state.bytesIndexed += content.length;
  const lines = content.split(/\r?\n/);
  state.index.files.set(relPath, { lines, size, absPath });

  for (let i = 0; i < lines.length; i += 1) {
    const terms = tokenize(lines[i]!, cfg.minTokenLength);
    for (const term of terms) {
      let postings = state.index.terms.get(term);
      if (!postings) {
        postings = new Map<string, Posting>();
        state.index.terms.set(term, postings);
      }
      let posting = postings.get(relPath);
      if (!posting) {
        posting = { tf: 0 };
        postings.set(relPath, posting);
      }
      posting.tf += 1;
    }
  }
}

async function indexFileFromStats(
  absPath: string,
  relPath: string,
  stats: Stats,
  cfg: SemanticSearchConfig,
): Promise<void> {
  if (!shouldIndexFile(relPath, cfg) || !stats.isFile() || stats.size > cfg.maxFileBytes) return;

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch {
    return;
  }

  addFileToIndex(relPath, absPath, content, stats.size, cfg);
}

async function flushFileBatch(
  batch: Array<{ absPath: string; relPath: string; stats: Stats }>,
  cfg: SemanticSearchConfig,
): Promise<void> {
  if (batch.length === 0) return;
  const current = batch.splice(0, batch.length);
  await Promise.allSettled(
    current.map(({ absPath, relPath, stats }) => indexFileFromStats(absPath, relPath, stats, cfg)),
  );
}

async function walkDirectory(
  absPath: string,
  cfg: SemanticSearchConfig,
  excludes: RegExp[],
  fileBatch: Array<{ absPath: string; relPath: string; stats: Stats }>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(absPath, { withFileTypes: true });
  } catch {
    return;
  }

  const root = normalizeSlashes(process.cwd());

  for (const ent of entries) {
    if (state.fileCount >= cfg.maxFiles) {
      state.truncated = true;
      return;
    }

    const absChild = normalizeSlashes(resolve(absPath, ent.name));
    const relChild = normalizeSlashes(relative(root, absChild));
    if (relChild === '' || relChild === '.') continue;

    if (excludes.some((re) => re.test(relChild))) continue;

    if (ent.isDirectory()) {
      await walkDirectory(absChild, cfg, excludes, fileBatch);
      if (state.truncated) return;
    } else if (ent.isFile()) {
      state.fileCount += 1;
      if (!shouldIndexFile(relChild, cfg)) continue;
      let stats: Stats;
      try {
        stats = await fs.stat(absChild);
      } catch {
        continue;
      }
      fileBatch.push({ absPath: absChild, relPath: relChild, stats });
      if (fileBatch.length >= INDEX_BATCH_SIZE) {
        await flushFileBatch(fileBatch, cfg);
      }
      if (state.fileCount % YIELD_EVERY_FILES === 0) {
        await yieldEventLoop();
      }
    }
  }
}

async function buildIndex(rootPath: string, cfg: SemanticSearchConfig): Promise<void> {
  state.index = { terms: new Map(), files: new Map() };
  state.cachedPath = rootPath;
  state.fileCount = 0;
  state.termCount = 0;
  state.bytesIndexed = 0;
  state.truncated = false;
  state.reindexCount += 1;

  const excludes = compileExcludes(cfg.excludePatterns);

  let rootStats: Stats;
  try {
    rootStats = await fs.stat(rootPath);
  } catch {
    state.termCount = 0;
    return;
  }

  if (rootStats.isFile()) {
    const relPath = normalizeSlashes(relative(normalizeSlashes(process.cwd()), rootPath));
    await indexFileFromStats(rootPath, relPath === '' ? '.' : relPath, rootStats, cfg);
    state.fileCount = state.index ? state.index.files.size : 0;
  } else if (rootStats.isDirectory()) {
    const fileBatch: Array<{ absPath: string; relPath: string; stats: Stats }> = [];
    await walkDirectory(rootPath, cfg, excludes, fileBatch);
    await flushFileBatch(fileBatch, cfg);
  }

  state.termCount = state.index ? state.index.terms.size : 0;
}

async function ensureIndex(rootPath: string, cfg: SemanticSearchConfig): Promise<void> {
  // Invalidation protocol: the hook bumps buildGeneration ONLY (buildIndex is
  // in flight and dereferences state.index across its awaits — nulling shared
  // state mid-build would yank it from under the builder). Freshness is
  // tracked by publishedGeneration: an index is servable only while it was
  // published at the current generation, so an idle invalidation (no build in
  // flight) is picked up by the fast path and a mid-build one by the
  // post-build generation check. Both drop the stale index and rebuild.
  for (;;) {
    if (
      state.index &&
      state.cachedPath === rootPath &&
      state.publishedGeneration === state.buildGeneration
    ) {
      return;
    }
    const gen = state.buildGeneration;
    state.buildPromise ??= buildIndex(rootPath, cfg).finally(() => {
      state.buildPromise = null;
    });
    await state.buildPromise;
    if (gen === state.buildGeneration && state.index && state.cachedPath === rootPath) {
      // Fresh: published at the current generation — every invalidation seen
      // before this build started is already reflected in it.
      state.publishedGeneration = gen;
      return;
    }
    // Stale: an invalidation landed while the build was in flight (or the
    // index predates one). Drop it — the builder has settled, so this cannot
    // yank shared state from under it — and rebuild.
    state.index = null;
    state.cachedPath = null;
  }
}

// ---------------------------------------------------------------------------
// Incremental deletion pruning
// ---------------------------------------------------------------------------

/** Minimum wall-clock gap between post-delete prune stat-scans. */
const PRUNE_MIN_INTERVAL_MS = 30_000;

/**
 * Remove one indexed file's entries (postings + file record) from the index.
 * The stored lines re-derive exactly the terms that were indexed for the
 * file, so each term's posting for it can be dropped and emptied posting
 * maps pruned — no rebuild needed.
 */
function removeFileFromIndex(relPath: string, cfg: SemanticSearchConfig): void {
  const index = state.index;
  if (!index) return;
  const entry = index.files.get(relPath);
  if (!entry) return;
  const terms = new Set<string>();
  for (const line of entry.lines) {
    for (const term of tokenize(line, cfg.minTokenLength)) terms.add(term);
  }
  for (const term of terms) {
    const postings = index.terms.get(term);
    if (!postings) continue;
    postings.delete(relPath);
    if (postings.size === 0) index.terms.delete(term);
  }
  index.files.delete(relPath);
  state.fileCount = Math.max(0, state.fileCount - 1);
  state.bytesIndexed = Math.max(0, state.bytesIndexed - entry.size);
  state.termCount = index.terms.size;
}

/**
 * Stat-scan the indexed files and drop entries whose file no longer exists —
 * the delete-side counterpart of the write-path generation bump. Shell tools
 * cannot be matched to exact deleted paths reliably, so instead of a full
 * rebuild we prune exactly the dead entries. Throttled and single-flight;
 * resolves with the number of entries removed.
 */
async function pruneDeletedFiles(
  rootPath: string,
  cfg: SemanticSearchConfig,
  opts?: { force?: boolean },
): Promise<number> {
  const index = state.index;
  if (!index || state.cachedPath !== rootPath) return 0;
  if (state.pruneInFlight) return state.pruneInFlight;
  const now = Date.now();
  if (!opts?.force && now - state.lastPruneAt < PRUNE_MIN_INTERVAL_MS) return 0;
  state.lastPruneAt = now;
  const pass = (async (): Promise<number> => {
    const missing: string[] = [];
    for (const [relPath, entry] of index.files) {
      try {
        await fs.stat(entry.absPath);
      } catch {
        missing.push(relPath);
      }
    }
    for (const relPath of missing) removeFileFromIndex(relPath, cfg);
    return missing.length;
  })();
  state.pruneInFlight = pass.finally(() => {
    state.pruneInFlight = null;
  });
  return pass;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface SearchResult {
  path: string;
  score: number;
  matchedTerms: string[];
  matchedLines: { lineNumber: number; text: string }[];
}

interface RankedCandidate {
  path: string;
  score: number;
  terms: string[];
}

function compareRankedCandidates(a: RankedCandidate, b: RankedCandidate): number {
  return b.score - a.score || a.path.localeCompare(b.path);
}

function insertTopCandidate(top: RankedCandidate[], candidate: RankedCandidate, limit: number): void {
  if (limit <= 0) return;
  if (top.length === 0) {
    top.push(candidate);
    return;
  }

  let insertAt = top.findIndex((existing) => compareRankedCandidates(candidate, existing) < 0);
  if (insertAt === -1) insertAt = top.length;
  if (insertAt >= limit) return;

  top.splice(insertAt, 0, candidate);
  if (top.length > limit) top.pop();
}

function runQuery(query: string, limit: number, cfg: SemanticSearchConfig): SearchResult[] {
  if (!state.index) return [];

  const rawTokens = tokenize(query, cfg.minTokenLength);
  const uniqueTokens = [...new Set(rawTokens)];
  if (uniqueTokens.length === 0) return [];

  const scores = new Map<string, number>();
  const matchedTerms = new Map<string, Set<string>>();

  for (const token of uniqueTokens) {
    const postings = state.index.terms.get(token);
    if (!postings) continue;
    for (const [filePath, posting] of postings) {
      scores.set(filePath, (scores.get(filePath) ?? 0) + posting.tf);
      let terms = matchedTerms.get(filePath);
      if (!terms) {
        terms = new Set<string>();
        matchedTerms.set(filePath, terms);
      }
      terms.add(token);
    }
  }

  const top: RankedCandidate[] = [];
  for (const [path, score] of scores) {
    insertTopCandidate(
      top,
      {
        path,
        score,
        terms: Array.from(matchedTerms.get(path) ?? []),
      },
      limit,
    );
  }

  return top.map(({ path, score, terms }) => {
    const entry = state.index!.files.get(path);
    const matchedLines: { lineNumber: number; text: string }[] = [];

    if (entry) {
      const querySet = new Set(uniqueTokens);
      for (let i = 0; i < entry.lines.length; i += 1) {
        const line = entry.lines[i]!;
        const lower = line.toLowerCase();
        for (const token of querySet) {
          if (lower.includes(token)) {
            matchedLines.push({ lineNumber: i + 1, text: line.trim() });
            break;
          }
        }
        if (matchedLines.length >= cfg.maxMatchesPerFile) break;
      }
    }

    return { path, score, matchedTerms: terms, matchedLines };
  });
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'semantic-search-indexer',
  version: '0.1.0',
  description: 'Builds an in-memory keyword index over project source files and answers ranked search queries',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS, includeExtensions: [...DEFAULTS.includeExtensions], excludePatterns: [...DEFAULTS.excludePatterns] },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      includeExtensions: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.includeExtensions,
        description: 'Only index files with these extensions. Empty = all files.',
      },
      excludePatterns: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.excludePatterns,
        description: 'Regex patterns; matching relative paths are skipped.',
      },
      maxFileBytes: {
        type: 'number',
        minimum: 1024,
        maximum: 50_000_000,
        default: 1_000_000,
        description: 'Files larger than this are skipped.',
      },
      defaultLimit: {
        type: 'number',
        minimum: 1,
        maximum: 1_000,
        default: 10,
        description: 'Default number of results per query.',
      },
      minTokenLength: {
        type: 'number',
        minimum: 1,
        maximum: 10,
        default: 2,
        description: 'Minimum length of an indexed/query token.',
      },
      maxMatchesPerFile: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 10,
        description: 'Maximum matching lines returned per result.',
      },
      maxFiles: {
        type: 'number',
        minimum: 1,
        maximum: 50_000,
        default: 5_000,
        description: 'Maximum files to index in one build.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.index = null;
    state.cachedPath = null;
    state.fileCount = 0;
    state.termCount = 0;
    state.bytesIndexed = 0;
    state.truncated = false;
    state.queryCount = 0;
    state.reindexCount = 0;
    state.buildPromise = null;
    state.buildGeneration = 0;
    state.publishedGeneration = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    if (state.deleteHookUnregister) {
      try {
        state.deleteHookUnregister();
      } catch {
        // best-effort
      }
      state.deleteHookUnregister = null;
    }
    state.lastPruneAt = 0;
    state.pruneInFlight = null;

    const cfg = readConfig(api.config.extensions?.['semantic-search-indexer']);

    // --- semantic_search ---
    api.tools.register({
      name: 'semantic_search',
      description:
        'Search project source files with a lightweight keyword index. ' +
        'Returns ranked file paths, TF scores, and matched lines.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Space-separated keywords to search for.',
          },
          q: { type: 'string', description: 'Alias for `query`.' },
          text: { type: 'string', description: 'Alias for `query`.' },
          keyword: { type: 'string', description: 'Alias for `query`.' },
          keywords: { type: 'string', description: 'Alias for `query`.' },
          search: { type: 'string', description: 'Alias for `query`.' },
          limit: {
            type: 'number',
            description: 'Maximum number of results (defaults to configured defaultLimit).',
          },
          path: {
            type: 'string',
            description: 'Directory or file to search under (defaults to project root).',
          },
          directory: { type: 'string', description: 'Alias for `path`.' },
          dir: { type: 'string', description: 'Alias for `path`.' },
          SearchDirectory: { type: 'string', description: 'Alias for `path`.' },
          SearchPath: { type: 'string', description: 'Alias for `path`.' },
        },
        // Schema-validating hosts check this BEFORE execute() normalizes the
        // aliases, so every query alternative must be declared or alias-only
        // inputs are rejected as schema-invalid before they reach the tool.
        anyOf: [
          { required: ['query'] },
          { required: ['q'] },
          { required: ['text'] },
          { required: ['keyword'] },
          { required: ['keywords'] },
          { required: ['search'] },
        ],
      },
      permission: 'auto',
      category: 'Search',
      mutating: false,
      riskTier: 'safe',
      icon: 'search',
      async execute(input: { query?: string; limit?: number; path?: string }) {
        if (!cfg.enabled) {
          return { ok: false, error: 'semantic-search-indexer is disabled' };
        }

        const rawPath =
          input.path ??
          (input as Record<string, unknown>)['directory'] ??
          (input as Record<string, unknown>)['dir'] ??
          (input as Record<string, unknown>)['SearchDirectory'] ??
          (input as Record<string, unknown>)['SearchPath'] ??
          (input as Record<string, unknown>)['TargetFile'] ??
          (input as Record<string, unknown>)['targetFile'] ??
          (input as Record<string, unknown>)['filePath'] ??
          (input as Record<string, unknown>)['file'];
        const resolved = resolveProjectPath(typeof rawPath === 'string' ? rawPath : undefined);
        if (!resolved) {
          return { ok: false, error: 'path outside project root' };
        }

        await ensureIndex(resolved, cfg);

        const rawQuery =
          input.query ??
          (input as Record<string, unknown>)['q'] ??
          (input as Record<string, unknown>)['text'] ??
          (input as Record<string, unknown>)['keyword'] ??
          (input as Record<string, unknown>)['keywords'] ??
          (input as Record<string, unknown>)['search'] ??
          '';
        const query = String(rawQuery);
        const limit =
          typeof input.limit === 'number' && input.limit >= 1
            ? Math.floor(input.limit)
            : cfg.defaultLimit;

        const results = runQuery(query, limit, cfg);
        const queryTokens = [...new Set(tokenize(query, cfg.minTokenLength))];
        state.queryCount += 1;
        api.metrics.counter('queries');

        return {
          ok: true,
          query,
          queryTokens,
          indexedPath: state.cachedPath,
          totalResults: results.length,
          limit,
          results,
        };
      },
    });

    // --- semantic_index_status ---
    api.tools.register({
      name: 'semantic_index_status',
      description: 'Reports semantic-search-indexer state: indexed path, file/term counts, and counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      riskTier: 'safe',
      icon: 'index',
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          indexedPath: state.cachedPath,
          fileCount: state.fileCount,
          termCount: state.termCount,
          bytesIndexed: state.bytesIndexed,
          truncated: state.truncated,
          counters: {
            queries: state.queryCount,
            reindexes: state.reindexCount,
          },
        };
      },
    });

    // Invalidate index cache when files are written or edited.
    if (typeof (api as any).registerHook === 'function') {
      state.hookUnregister = (api as any).registerHook(
        'PostToolUse',
        'write|edit|write_to_file|replace_file_content',
        (() => {
          // Generation bump ONLY: buildIndex may be in flight right now and
          // dereferences state.index across its awaits — nulling the shared
          // index here would yank it out from under the builder. Freshness is
          // enforced by publishedGeneration in ensureIndex (fast path AND
          // post-build check), which drops the stale index and rebuilds.
          state.buildGeneration += 1;
        }) as never,
        { background: true },
      );
    }

    // Deletion counterpart: shell tools can remove files without any write
    // event, so their PostToolUse fires a throttled stat-scan that prunes
    // exactly the dead entries instead of paying a full rebuild (see
    // pruneDeletedFiles). Scoped to shell + explicit-delete tools.
    if (typeof (api as any).registerHook === 'function') {
      state.deleteHookUnregister = (api as any).registerHook(
        'PostToolUse',
        'bash|exec|pwsh|delete_file|remove_file',
        (() => {
          const root = state.cachedPath;
          if (root) void pruneDeletedFiles(root, cfg);
        }) as never,
        { background: true },
      );
    }

    api.log.info('semantic-search-indexer plugin loaded', {
      version: '0.1.0',
      defaultLimit: cfg.defaultLimit,
      maxFiles: cfg.maxFiles,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    if (state.deleteHookUnregister) {
      try {
        state.deleteHookUnregister();
      } catch {
        // best-effort
      }
      state.deleteHookUnregister = null;
    }
    const final = {
      fileCount: state.fileCount,
      termCount: state.termCount,
      queries: state.queryCount,
      reindexes: state.reindexCount,
    };
    state.index = null;
    state.cachedPath = null;
    state.fileCount = 0;
    state.termCount = 0;
    state.bytesIndexed = 0;
    state.truncated = false;
    state.queryCount = 0;
    state.reindexCount = 0;
    state.buildPromise = null;
    state.buildGeneration = 0;
    state.publishedGeneration = 0;
    state.lastPruneAt = 0;
    state.pruneInFlight = null;
    api.log.info('semantic-search-indexer: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `semantic-search-indexer: ${state.fileCount} file(s), ${state.termCount} term(s), ${state.queryCount} query(ies)`,
      counters: {
        fileCount: state.fileCount,
        termCount: state.termCount,
        bytesIndexed: state.bytesIndexed,
        queries: state.queryCount,
        reindexes: state.reindexCount,
      },
    };
  },
};

/**
 * Test seam: direct access to the incremental delete-prune. `force` bypasses
 * the throttle window (production callers go through the PostToolUse hook).
 */
export const semanticIndexerCoverage = {
  removeFileFromIndex,
  pruneDeletedFiles,
  readConfig,
};

export default plugin;
