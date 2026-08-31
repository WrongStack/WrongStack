/**
 * duplicate-code-detector plugin — finds duplicated code blocks across source
 * files using normalized-line fingerprinting.
 *
 * Tools registered:
 * - detect_duplicate_code : Scan a path for duplicated blocks.
 * - duplicate_code_status : Report config + counters.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit` to source files, warning when the
 *   changed file introduces blocks that duplicate existing code elsewhere.
 *
 * Config (`config.extensions['duplicate-code-detector']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "minLines": 5,
 *   "threshold": 0.8,
 *   "extensions": [".ts", ".tsx", ".js", ".jsx"],
 *   "excludeDirs": ["node_modules", "dist", ".git", "coverage"],
 *   "maxFindings": 20
 * }
 * ```
 *
 * @public
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { BoundedMap, collectSourceFilesAsync, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

/**
 * How long to stay quiet about one path after warning about it. Also the
 * retention window for `state.lastHookWarning` — past this point an entry
 * cannot affect a decision, so keeping it is pure memory growth.
 */
const HOOK_WARNING_COOLDOWN_MS = 60_000;

interface DuplicateLocation {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface DuplicateFinding {
  fingerprint: string;
  lineCount: number;
  locations: DuplicateLocation[];
}

interface DuplicateCodeDetectorState {
  scanCount: number;
  findingCount: number;
  hookInvocationCount: number;
  warningCount: number;
  errorCount: number;
  hookUnregister: null | (() => void);
  /**
   * Per-path cooldown timestamps, so a bulk edit does not repeat the same
   * warning for one file on every write.
   *
   * Bounded with a TTL matching the cooldown window: an entry older than
   * the cooldown can never change a decision again, but a plain `Map` kept
   * it for the life of the process — one entry per source file ever
   * touched, released only at teardown.
   */
  lastHookWarning: BoundedMap<string, number>;
  /**
   * Process-lifetime fingerprint index. Maps `filePath -> {mtimeMs, size, fingerprints}`.
   * On every PostToolUse invocation the hook compares `(mtimeMs, size)` of each
   * source file against the cached value. When the pair matches, the file is
   * byte-identical to its last read and we skip both the read AND the per-window
   * extraction. This collapses the hook's per-edit cost from `O(all_sources *
   * lines)` re-extraction to `O(all_sources * stat())` for unchanged files.
   *
   * RAM: the entry stores only compact numeric fingerprint hashes (`Set<number>`),
   * NOT the `CodeWindow` objects — which carry the raw snippet + normalized
   * fingerprint TEXT for every overlapping window. Retaining those across a whole
   * monorepo leaked ~1GB for the process lifetime. Snippets are needed only by the
   * on-demand `detect_duplicate_code` tool, which re-reads files transiently.
   *
   * The index is bounded (see `hookIndexBudgets`) with LRU eviction, and
   * invalidated when the plugin reloads (reset in setup()/teardown()) or when a
   * file's `(mtimeMs, size)` changes.
   */
  fileIndex: Map<string, { mtimeMs: number; size: number; fingerprints: Set<number> }>;
  /** Per-file reads currently populating `fileIndex`, shared by concurrent background hooks. */
  inFlightFingerprintReads: Map<string, Promise<Set<number> | null>>;
  /** Running sum of `fingerprints.size` across `fileIndex`, kept in sync so eviction is O(evicted). */
  indexFingerprintCount: number;
  /** Number of file entries evicted from `fileIndex` under budget pressure (observability). */
  hookIndexEvictions: number;
  /** Number of hook fingerprint reads skipped because the source file exceeded the byte budget. */
  oversizedFileSkips: number;
}

const state: DuplicateCodeDetectorState = {
  scanCount: 0,
  findingCount: 0,
  hookInvocationCount: 0,
  warningCount: 0,
  errorCount: 0,
  hookUnregister: null,
  lastHookWarning: new BoundedMap<string, number>({ max: 512, ttlMs: HOOK_WARNING_COOLDOWN_MS }),
  fileIndex: new Map(),
  inFlightFingerprintReads: new Map(),
  indexFingerprintCount: 0,
  hookIndexEvictions: 0,
  oversizedFileSkips: 0,
};

// ---------------------------------------------------------------------------
// Hook fingerprint-index budgets (bound the process-lifetime RAM footprint)
// ---------------------------------------------------------------------------

/**
 * Tunable budgets that bound the hook fingerprint index. Keeping the defaults
 * together makes the file, fingerprint, and byte limits explicit.
 */
export const hookIndexBudgets = {
  /** Max number of files retained in the hook fingerprint index (LRU-evicted). */
  maxFiles: 5000,
  /** Max total fingerprints across the whole index (running-sum enforced, LRU-evicted). */
  maxFingerprints: 300_000,
  /**
   * Max candidate windows hashed and cached per file by the advisory hook. The
   * on-demand detect_duplicate_code tool intentionally scans every window.
   */
  maxFingerprintsPerFile: 25_000,
  /** Files larger than this are skipped entirely by the hook (never read/extracted/cached). */
  maxFileBytes: 2 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface DuplicateCodeDetectorConfig {
  enabled: boolean;
  minLines: number;
  threshold: number;
  extensions: string[];
  excludeDirs: string[];
  maxFindings: number;
}

const DEFAULTS: DuplicateCodeDetectorConfig = {
  enabled: false,
  minLines: 8,
  threshold: 0.8,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  excludeDirs: ['node_modules', 'dist', '.git', 'coverage'],
  maxFindings: 5,
};

function readConfig(raw: unknown): DuplicateCodeDetectorConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS };
  }
  const r = raw as Record<string, unknown>;
  const rawExts = r['extensions'] ?? r['file_extensions'] ?? r['fileExtensions'];
  const extensions = Array.isArray(rawExts)
    ? (rawExts as unknown[]).filter((x): x is string => typeof x === 'string')
    : DEFAULTS.extensions;

  const rawMin = r['minLines'] ?? r['min_lines'] ?? r['min'];
  const rawExclude = r['excludeDirs'] ?? r['exclude_dirs'] ?? r['exclude'];
  const rawMax = r['maxFindings'] ?? r['max_findings'] ?? r['limit'];

  return {
    enabled: r['enabled'] === true,
    minLines:
      typeof rawMin === 'number' && rawMin >= 2 && rawMin <= 100
        ? rawMin
        : DEFAULTS.minLines,
    threshold:
      typeof r['threshold'] === 'number' && r['threshold'] > 0 && r['threshold'] <= 1
        ? r['threshold']
        : DEFAULTS.threshold,
    extensions,
    excludeDirs: Array.isArray(rawExclude)
      ? (rawExclude as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.excludeDirs,
    maxFindings:
      typeof rawMax === 'number' && rawMax >= 1 && rawMax <= 500
        ? rawMax
        : DEFAULTS.maxFindings,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

/** Check a resolved/canonical path against one fixed project-root snapshot. */
function isWithinRoot(projectRoot: string, candidate: string): boolean {
  const rel = relative(projectRoot, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function removeInlineComments(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//, '');
}

function normalizeLine(line: string): string {
  let normalized = line.trim().toLowerCase();
  normalized = removeInlineComments(normalized);
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

function buildFingerprint(lines: string[]): string {
  return lines
    .map(normalizeLine)
    .filter((l) => l.length > 0)
    .join('\n');
}

/**
 * Compact 53-bit hash of a fingerprint string. The hook index can retain up to
 * 300k fingerprints, where a 32-bit hash has a material birthday-collision risk
 * and can emit a false duplicate warning. The result remains a JS-safe integer,
 * so the index keeps the compact `Set<number>` representation instead of storing
 * raw fingerprint text.
 */
export function hashFingerprint(fp: string): number {
  let low = 0xdeadbeef;
  let high = 0x41c6ce57;
  for (let index = 0; index < fp.length; index += 1) {
    const code = fp.charCodeAt(index);
    low = Math.imul(low ^ code, 2_654_435_761);
    high = Math.imul(high ^ code, 1_597_334_677);
  }
  low =
    Math.imul(low ^ (low >>> 16), 2_246_822_507) ^ Math.imul(high ^ (high >>> 13), 3_266_489_909);
  high =
    Math.imul(high ^ (high >>> 16), 2_246_822_507) ^ Math.imul(low ^ (low >>> 13), 3_266_489_909);
  return 4_294_967_296 * (high & 0x1fffff) + (low >>> 0);
}

/** Compact hashes used only by the automatic advisory hook. */
function extractFingerprintHashes(
  content: string,
  minLines: number,
  maxWindows: number,
): Set<number> {
  const rawLines = content.split(/\r?\n/);
  // Normalize once per source line. Normalizing every overlapping window
  // repeated this work roughly minLines times and created large transient
  // string heaps during project scans.
  const normalizedLines = rawLines.map(normalizeLine);
  const fingerprints = new Set<number>();
  const windowCount = Math.min(Math.max(rawLines.length - minLines + 1, 0), maxWindows);
  for (let index = 0; index < windowCount; index += 1) {
    const fingerprint = normalizedLines
      .slice(index, index + minLines)
      .filter((line) => line.length > 0)
      .join('\n');
    if (fingerprint.length > 0) fingerprints.add(hashFingerprint(fingerprint));
  }
  return fingerprints;
}

/**
 * LRU-evict the hook fingerprint index until it is within both the file-count and
 * total-fingerprint budgets. Oldest entries (front of the Map's insertion order)
 * go first; `indexFingerprintCount` is kept in sync so this is O(evicted).
 */
function evictHookIndex(): void {
  while (
    state.fileIndex.size > hookIndexBudgets.maxFiles ||
    state.indexFingerprintCount > hookIndexBudgets.maxFingerprints
  ) {
    const oldest = state.fileIndex.keys().next();
    if (oldest.done) break;
    const key = oldest.value;
    const entry = state.fileIndex.get(key);
    if (entry) state.indexFingerprintCount -= entry.fingerprints.size;
    state.fileIndex.delete(key);
    state.hookIndexEvictions += 1;
  }
}

interface CodeWindow {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  fingerprint: string;
}

function extractWindows(filePath: string, content: string, minLines: number): CodeWindow[] {
  const rawLines = content.split(/\r?\n/);
  // Per-file interval tracker. The naive sliding-window scanner above
  // emits (rawLines.length - minLines + 1) windows per file; for a 200-line
  // file with minLines=8 that's 193 windows, most of which overlap and
  // identify the *same* duplicated block with slightly shifted boundaries.
  // Each shifted overlap is given a different fingerprint (the fingerprint
  // normalizes per-line so dropping or adding a boundary line changes the
  // hash), so a single logical duplication produced N findings, dominating
  // `maxFindings` and starving truly distinct fingerprints elsewhere in the
  // project. Track the [startLine, endLine] intervals we've already emitted
  // and skip any new window whose range overlaps an existing one for the
  // same file — that way one duplication produces one location per file,
  // not one location per shifted window.
  const covered: Array<[number, number]> = [];
  const windows: CodeWindow[] = [];
  for (let i = 0; i <= rawLines.length - minLines; i++) {
    const startLine = i + 1;
    const endLine = i + minLines;
    let overlaps = false;
    for (const [s, e] of covered) {
      // Intervals overlap iff startLine <= e && s <= endLine (inclusive on both ends).
      if (startLine <= e && s <= endLine) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    const slice = rawLines.slice(i, i + minLines);
    const fingerprint = buildFingerprint(slice);
    if (fingerprint.length === 0) continue;
    const snippet = slice.join('\n');
    windows.push({
      file: filePath,
      startLine,
      endLine,
      snippet,
      fingerprint,
    });
    covered.push([startLine, endLine]);
  }
  return windows;
}

function findDuplicates(
  files: Map<string, string>,
  minLines: number,
  maxFindings: number,
): DuplicateFinding[] {
  const byFingerprint = new Map<string, CodeWindow[]>();
  for (const [filePath, content] of files.entries()) {
    const windows = extractWindows(filePath, content, minLines);
    for (const w of windows) {
      const list = byFingerprint.get(w.fingerprint) ?? [];
      list.push(w);
      byFingerprint.set(w.fingerprint, list);
    }
  }

  const findings: DuplicateFinding[] = [];
  const coveredSpans = new Set<string>();

  for (const [fingerprint, windows] of byFingerprint.entries()) {
    if (windows.length < 2) continue;

    // Filter out consecutive overlapping sliding windows across the same files
    const isOverlapping = windows.every((w) => {
      const spanKey = `${w.file}:${Math.floor(w.startLine / minLines)}`;
      return coveredSpans.has(spanKey);
    });
    if (isOverlapping && findings.length > 0) continue;

    for (const w of windows) {
      coveredSpans.add(`${w.file}:${Math.floor(w.startLine / minLines)}`);
    }

    const locations = windows.map((w) => ({
      file: relativePath(w.file),
      startLine: w.startLine,
      endLine: w.endLine,
      snippet: w.snippet,
    }));
    findings.push({ fingerprint, lineCount: fingerprint.split('\n').length, locations });
  }

  // Cross-fingerprint merge: a single duplicated block emits multiple
  // fingerprints because the sliding-window scanner shifts the boundary by
  // one line at a time, and each shifted overlap produces a different hash
  // (fingerprint normalization is per-line). The per-file interval dedup in
  // extractWindows eliminates same-fingerprint multi-locations in the same
  // file, but it cannot collapse DIFFERENT fingerprints even when they
  // point at the same logical block. Merge any two findings whose location
  // sets overlap in at least one file: union their locations, keep the
  // longer fingerprint + snippet. Process pairs until no further merges
  // happen (O(n^2) in practice fine for typical project sizes — if a scan
  // ever produces >1000 findings, maxFindings already truncates upstream).
  function locationsOverlap(a: (typeof findings)[number], b: (typeof findings)[number]): boolean {
    for (const la of a.locations) {
      for (const lb of b.locations) {
        if (la.file !== lb.file) continue;
        if (la.startLine <= lb.endLine && lb.startLine <= la.endLine) return true;
      }
    }
    return false;
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < findings.length; i++) {
      for (let j = i + 1; j < findings.length; j++) {
        if (!locationsOverlap(findings[i]!, findings[j]!)) continue;
        const a = findings[i]!;
        const b = findings[j]!;
        // Keep the longer fingerprint (most lines = most specific). Union
        // location sets, dedup exact file+startLine duplicates.
        const keep = b.fingerprint.split('\n').length > a.fingerprint.split('\n').length ? b : a;
        const drop = keep === a ? b : a;
        const seen = new Set<string>();
        const mergedLocations: typeof a.locations = [];
        for (const loc of [...keep.locations, ...drop.locations]) {
          const k = `${loc.file}#${loc.startLine}#${loc.endLine}`;
          if (seen.has(k)) continue;
          seen.add(k);
          mergedLocations.push(loc);
        }
        mergedLocations.sort((x, y) =>
          x.file === y.file ? x.startLine - y.startLine : x.file.localeCompare(y.file),
        );
        findings[i] = {
          fingerprint: keep.fingerprint,
          lineCount: keep.fingerprint.split('\n').length,
          locations: mergedLocations,
        };
        findings.splice(j, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }

  // maxFindings cap (applied AFTER merging so it counts logical
  // duplications, not fingerprint explosions).
  const capped = findings.slice(0, maxFindings);
  return capped;
}

async function scanPath(
  rawPath: string,
  cfg: DuplicateCodeDetectorConfig,
): Promise<{ findings: DuplicateFinding[]; scannedFiles: number }> {
  const root = process.cwd();
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const filePaths = await collectSourceFilesAsync(resolved, {
    extensions: cfg.extensions,
    excludeDirs: cfg.excludeDirs,
  });
  const files = new Map<string, string>();
  for (const p of filePaths) {
    try {
      files.set(p, await readFile(p, 'utf-8'));
    } catch {
      // skip unreadable files
    }
  }
  return {
    findings: findDuplicates(files, cfg.minLines, cfg.maxFindings),
    scannedFiles: files.size,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'duplicate-code-detector',
  version: '0.1.0',
  description:
    'Finds duplicated code blocks across source files using normalized-line fingerprinting',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, description: 'Master switch.' },
      minLines: {
        type: 'number',
        minimum: 2,
        maximum: 100,
        default: 8,
        description: 'Minimum number of consecutive lines to form a block.',
      },
      threshold: {
        type: 'number',
        minimum: 0.01,
        maximum: 1,
        default: 0.8,
        description: 'Similarity threshold (currently exact-match only).',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'File extensions to scan.',
      },
      excludeDirs: {
        type: 'array',
        items: { type: 'string' },
        default: ['node_modules', 'dist', '.git', 'coverage'],
        description: 'Directory names to skip while scanning.',
      },
      maxFindings: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        default: 20,
        description: 'Maximum duplicate groups reported per scan.',
      },
    },
  },

  setup(api) {
    state.scanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    state.fileIndex.clear();
    state.indexFingerprintCount = 0;
    state.hookIndexEvictions = 0;
    state.oversizedFileSkips = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['duplicate-code-detector']);
    const extensionsSet = new Set(cfg.extensions);

    /**
     * Cached read of a file's fingerprint HASH set. stat() then either return the
     * cached `Set<number>` (when mtime+size match) or read + extract + hash + cache.
     * Only compact numeric hashes are retained — never the snippet/fingerprint text.
     * Cheap stat() cost per unchanged file; only changed files pay read + extract.
     *
     * Files larger than `hookIndexBudgets.maxFileBytes` are skipped (empty set, not cached).
     * Returns null only if the file is unreadable/unstattable.
     */
    async function readCachedFingerprints(
      filePath: string,
      minLines: number,
    ): Promise<Set<number> | null> {
      let st: { mtimeMs: number; size: number };
      try {
        st = await stat(filePath);
      } catch {
        return null;
      }
      const cached = state.fileIndex.get(filePath);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        // LRU touch: re-insert to mark most-recently-used (moves to Map tail).
        state.fileIndex.delete(filePath);
        state.fileIndex.set(filePath, cached);
        return cached.fingerprints;
      }
      // Never read/extract oversized files — they'd dominate the index and the read.
      if (st.size > hookIndexBudgets.maxFileBytes) {
        if (cached) {
          state.indexFingerprintCount -= cached.fingerprints.size;
          state.fileIndex.delete(filePath);
        }
        state.oversizedFileSkips += 1;
        api.log.trace('duplicate-code-detector: skipped oversized file in hook index', {
          file: relativePath(filePath),
          sizeBytes: st.size,
          maxFileBytes: hookIndexBudgets.maxFileBytes,
        });
        return new Set();
      }
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        return null;
      }
      const fingerprints = extractFingerprintHashes(
        content,
        minLines,
        hookIndexBudgets.maxFingerprintsPerFile,
      );
      // Update the running fingerprint count, replacing any prior entry's contribution.
      if (cached) state.indexFingerprintCount -= cached.fingerprints.size;
      state.fileIndex.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, fingerprints });
      state.indexFingerprintCount += fingerprints.size;
      evictHookIndex();
      return fingerprints;
    }

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{
      decision?: 'block';
      reason?: string;
      additionalContext?: string;
      contextAs?: 'inline' | 'separate';
    } | void> => {
      if (!cfg.enabled) return;
      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawSource =
        inp['path'] ??
        inp['TargetFile'] ??
        inp['filePath'] ??
        inp['file_path'] ??
        inp['targetFile'] ??
        inp['file'];
      const sourcePath = typeof rawSource === 'string' ? rawSource : undefined;
      if (!sourcePath || typeof sourcePath !== 'string') return;

      // Snapshot cwd once, resolve against that root, then canonicalize before
      // any stat/read/cache operation. This prevents cwd changes or symlinks
      // from redirecting the persistent fingerprint index outside the project.
      const projectRoot = resolve(process.cwd());
      const resolvedFile = isAbsolute(sourcePath)
        ? resolve(sourcePath)
        : resolve(projectRoot, sourcePath);
      if (!isWithinRoot(projectRoot, resolvedFile)) return;
      let changedFile: string;
      try {
        changedFile = await realpath(resolvedFile);
      } catch {
        state.errorCount += 1;
        return;
      }
      if (!isWithinRoot(projectRoot, changedFile)) return;

      const ext = extname(sourcePath).toLowerCase();
      // Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
      if (!extensionsSet.has(ext)) return;

      state.hookInvocationCount += 1;

      // Throttle repeated warnings for the same file within one minute.
      // Bulk tools like `replace` can touch many files in quick succession;
      // we still report the total count, but we don't repeat the same message
      // for the same file on every edit.
      const now = Date.now();
      const lastWarning = state.lastHookWarning.get(changedFile);
      if (lastWarning !== undefined && now - lastWarning < HOOK_WARNING_COOLDOWN_MS) return;

      const changedFps = await readCachedFingerprints(changedFile, cfg.minLines);
      if (changedFps === null) {
        state.errorCount += 1;
        return;
      }
      if (changedFps.size === 0) return;

      let otherFilePaths: string[];
      try {
        otherFilePaths = await collectSourceFilesAsync(projectRoot, {
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
        });
      } catch {
        state.errorCount += 1;
        return;
      }

      // Compare fingerprint HASH sets instead of concatenating every file's
      // windows into one array (the old per-fire memory spike). Unchanged files
      // pay only a stat(); changed files pay read + extract + hash. `matched`
      // holds the changed-file fingerprints already found elsewhere (deduped),
      // so the count preserves the old "number of changed blocks duplicated
      // elsewhere" semantic without retaining any snippet text.
      const matched = new Set<number>();
      const resolvedChanged = resolve(changedFile).toLowerCase();
      for (const p of otherFilePaths) {
        // Keep the changed file out even if collection/filtering is refactored.
        if (resolve(p).toLowerCase() === resolvedChanged) continue;
        const otherFps = await readCachedFingerprints(p, cfg.minLines);
        if (otherFps === null || otherFps.size === 0) continue;
        for (const fp of changedFps) {
          if (!matched.has(fp) && otherFps.has(fp)) matched.add(fp);
        }
        if (matched.size === changedFps.size) break;
      }

      if (matched.size === 0) return;

      state.warningCount += matched.size;
      state.lastHookWarning.set(changedFile, now);
      return {
        additionalContext:
          `⚠️ duplicate-code-detector: ${sourcePath} contains ${matched.size} block(s) already present elsewhere. ` +
          `Run detect_duplicate_code for details.`,
        contextAs: 'separate',
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook, {
      background: true,
    });

    // --- detect_duplicate_code tool ---
    api.tools.register({
      name: 'detect_duplicate_code',
      description:
        'Scan source files for duplicated code blocks. Uses normalized-line fingerprinting to find identical multi-line blocks across files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', default: '.', description: 'Directory or file path to scan.' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { path?: string }) {
        if (!cfg.enabled) return { ok: false, error: 'duplicate-code-detector is disabled' };

        const raw = input as Record<string, unknown>;
        const rawPath =
          (typeof raw['path'] === 'string' ? raw['path'] : undefined) ??
          (typeof raw['directory'] === 'string' ? raw['directory'] : undefined) ??
          (typeof raw['dir'] === 'string' ? raw['dir'] : undefined) ??
          (typeof raw['SearchDirectory'] === 'string' ? raw['SearchDirectory'] : undefined) ??
          (typeof raw['filePath'] === 'string' ? raw['filePath'] : undefined) ??
          (typeof raw['file_path'] === 'string' ? raw['file_path'] : undefined) ??
          (typeof raw['TargetFile'] === 'string' ? raw['TargetFile'] : undefined) ??
          (typeof raw['targetFile'] === 'string' ? raw['targetFile'] : undefined) ??
          (typeof raw['file'] === 'string' ? raw['file'] : undefined) ??
          '.';
        if (!withinProject(rawPath)) {
          return { ok: false, error: 'scan path is outside the project root' };
        }

        state.scanCount += 1;
        let result: { findings: DuplicateFinding[]; scannedFiles: number };
        try {
          result = await scanPath(rawPath, cfg);
        } catch (err) {
          state.errorCount += 1;
          return { ok: false, error: String(err) };
        }

        state.findingCount += result.findings.length;
        return {
          ok: true,
          path: relativePath(resolve(process.cwd(), rawPath)),
          scannedFiles: result.scannedFiles,
          minLines: cfg.minLines,
          findings: result.findings,
        };
      },
    });

    // --- duplicate_code_status tool ---
    api.tools.register({
      name: 'duplicate_code_status',
      description: 'Reports duplicate-code-detector state: config + counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          minLines: cfg.minLines,
          threshold: cfg.threshold,
          extensions: cfg.extensions,
          excludeDirs: cfg.excludeDirs,
          maxFindings: cfg.maxFindings,
          counters: {
            scans: state.scanCount,
            findings: state.findingCount,
            hookInvocations: state.hookInvocationCount,
            warnings: state.warningCount,
            errors: state.errorCount,
            // Hook fingerprint-index footprint (bounded; see hookIndexBudgets).
            indexedFiles: state.fileIndex.size,
            indexedFingerprints: state.indexFingerprintCount,
            hookIndexEvictions: state.hookIndexEvictions,
            oversizedFileSkips: state.oversizedFileSkips,
            // Rough retained-bytes estimate: ~8B per numeric fingerprint + ~120B
            // per file entry (key string + Set/entry overhead). Compact by design.
            approxIndexBytes: state.indexFingerprintCount * 8 + state.fileIndex.size * 120,
          },
        };
      },
    });

    api.log.info('duplicate-code-detector plugin loaded', {
      version: '0.1.0',
      minLines: cfg.minLines,
      extensions: cfg.extensions,
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
    const final = {
      scans: state.scanCount,
      findings: state.findingCount,
      hookInvocations: state.hookInvocationCount,
      warnings: state.warningCount,
      errors: state.errorCount,
    };
    state.scanCount = 0;
    state.findingCount = 0;
    state.hookInvocationCount = 0;
    state.warningCount = 0;
    state.errorCount = 0;
    state.lastHookWarning.clear();
    state.fileIndex.clear();
    state.indexFingerprintCount = 0;
    state.hookIndexEvictions = 0;
    state.oversizedFileSkips = 0;
    api.log.info('duplicate-code-detector: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.errorCount
        ? `duplicate-code-detector: ${state.errorCount} error(s)`
        : `duplicate-code-detector: ${state.scanCount} scan(s), ${state.findingCount} duplicate group(s)`,
      counters: {
        scans: state.scanCount,
        findings: state.findingCount,
        hookInvocations: state.hookInvocationCount,
        warnings: state.warningCount,
        errors: state.errorCount,
        indexedFiles: state.fileIndex.size,
        indexedFingerprints: state.indexFingerprintCount,
        hookIndexEvictions: state.hookIndexEvictions,
        oversizedFileSkips: state.oversizedFileSkips,
      },
    };
  },
};

export default plugin;
