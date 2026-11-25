import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BoundedMap, collectSourceFilesAsync } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

/**
 * How long to stay quiet about one path after warning about it. Also the
 * retention window for `state.lastHookWarning` — past this point an entry
 * cannot affect a decision, so keeping it is pure memory growth.
 */
export const HOOK_WARNING_COOLDOWN_MS = 60_000;

export interface DuplicateLocation {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface DuplicateFinding {
  fingerprint: string;
  lineCount: number;
  locations: DuplicateLocation[];
}

export interface DuplicateCodeDetectorState {
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

export const state: DuplicateCodeDetectorState = {
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

export interface DuplicateCodeDetectorConfig {
  enabled: boolean;
  minLines: number;
  threshold: number;
  extensions: string[];
  excludeDirs: string[];
  maxFindings: number;
}

export const DEFAULTS: DuplicateCodeDetectorConfig = {
  enabled: true,
  minLines: 8,
  threshold: 0.8,
  extensions: ['.ts', '.tsx', '.js', '.jsx'],
  excludeDirs: ['node_modules', 'dist', '.git', 'coverage'],
  maxFindings: 5,
};

export function readConfig(raw: unknown): DuplicateCodeDetectorConfig {
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
      typeof rawMin === 'number' && rawMin >= 2 && rawMin <= 100 ? rawMin : DEFAULTS.minLines,
    threshold:
      typeof r['threshold'] === 'number' && r['threshold'] > 0 && r['threshold'] <= 1
        ? r['threshold']
        : DEFAULTS.threshold,
    extensions,
    excludeDirs: Array.isArray(rawExclude)
      ? (rawExclude as unknown[]).filter((x): x is string => typeof x === 'string')
      : DEFAULTS.excludeDirs,
    maxFindings:
      typeof rawMax === 'number' && rawMax >= 1 && rawMax <= 500 ? rawMax : DEFAULTS.maxFindings,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// withinProject() imported from ../runtime/index.js

/** Check a resolved/canonical path against one fixed project-root snapshot. */
export function isWithinRoot(projectRoot: string, candidate: string): boolean {
  const rel = relative(projectRoot, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function relativePath(p: string): string {
  return toPosix(relative(process.cwd(), p));
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

export function removeInlineComments(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function normalizeLine(line: string): string {
  let normalized = line.trim().toLowerCase();
  normalized = removeInlineComments(normalized);
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

/**
 * Indexes of the lines that still carry code once normalized. Windows are
 * built over these, not over raw lines: blank and comment-only lines
 * normalize to '' and used to sit inside a raw `minLines` window without
 * reaching its fingerprint, so seven different comment lines plus one shared
 * `return x;` fingerprinted as that single line — an "8-line duplicate".
 */
export function codeLineIndexes(normalizedLines: string[]): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < normalizedLines.length; i++) {
    if (normalizedLines[i]!.length > 0) indexes.push(i);
  }
  return indexes;
}

/** Fingerprint of the `minLines` code lines starting at `codeLines[start]`. */
export function windowFingerprint(
  normalizedLines: string[],
  codeLines: number[],
  start: number,
  minLines: number,
): string {
  return codeLines
    .slice(start, start + minLines)
    .map((i) => normalizedLines[i])
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
export function extractFingerprintHashes(
  content: string,
  minLines: number,
  maxWindows: number,
): Set<number> {
  // Normalize once per source line. Normalizing every overlapping window
  // repeated this work roughly minLines times and created large transient
  // string heaps during project scans.
  const normalizedLines = content.split(/\r?\n/).map(normalizeLine);
  const codeLines = codeLineIndexes(normalizedLines);
  const fingerprints = new Set<number>();
  const windowCount = Math.min(Math.max(codeLines.length - minLines + 1, 0), maxWindows);
  for (let index = 0; index < windowCount; index += 1) {
    fingerprints.add(
      hashFingerprint(windowFingerprint(normalizedLines, codeLines, index, minLines)),
    );
  }
  return fingerprints;
}

/**
 * LRU-evict the hook fingerprint index until it is within both the file-count and
 * total-fingerprint budgets. Oldest entries (front of the Map's insertion order)
 * go first; `indexFingerprintCount` is kept in sync so this is O(evicted).
 */
export function evictHookIndex(): void {
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

export interface CodeWindow {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  fingerprint: string;
}

/**
 * Duplicate-candidate windows of one file. `isDuplicate` says whether a
 * fingerprint occurs at least twice across the scan; only those windows are
 * kept, so the interval dedup below can never skip a real duplicate.
 *
 * The dedup used to run on EVERY window before matching, which tiled each
 * file at fixed offsets (1, 1+minLines, …). Two copies of a block were then
 * found only when their start lines were congruent mod `minLines` — a block
 * at line 1 of one file and line 4 of another produced no finding at all.
 */
export function extractWindows(
  filePath: string,
  content: string,
  minLines: number,
  isDuplicate: (fingerprint: string) => boolean,
): CodeWindow[] {
  const rawLines = content.split(/\r?\n/);
  const normalizedLines = rawLines.map(normalizeLine);
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
  // Windows are visited in ascending start order, so a new window can only
  // overlap the most recently kept one.
  const codeLines = codeLineIndexes(normalizedLines);
  let coveredUntil = 0;
  const windows: CodeWindow[] = [];
  for (let k = 0; k <= codeLines.length - minLines; k++) {
    const first = codeLines[k]!;
    const last = codeLines[k + minLines - 1]!;
    const startLine = first + 1;
    const endLine = last + 1;
    if (startLine <= coveredUntil) continue;
    const fingerprint = windowFingerprint(normalizedLines, codeLines, k, minLines);
    if (!isDuplicate(fingerprint)) continue;
    windows.push({
      file: filePath,
      startLine,
      endLine,
      snippet: rawLines.slice(first, last + 1).join('\n'),
      fingerprint,
    });
    coveredUntil = endLine;
  }
  return windows;
}

export function findDuplicates(
  files: Map<string, string>,
  minLines: number,
  maxFindings: number,
): DuplicateFinding[] {
  // Pass 1: how often each window fingerprint occurs across every file.
  // Counted by compact hash so a project scan does not retain one string
  // per window; a collision only admits a candidate that pass 2's exact
  // string grouping then drops as a singleton.
  const occurrences = new Map<number, number>();
  for (const content of files.values()) {
    const normalizedLines = content.split(/\r?\n/).map(normalizeLine);
    const codeLines = codeLineIndexes(normalizedLines);
    for (let k = 0; k <= codeLines.length - minLines; k++) {
      const hash = hashFingerprint(windowFingerprint(normalizedLines, codeLines, k, minLines));
      occurrences.set(hash, (occurrences.get(hash) ?? 0) + 1);
    }
  }
  const isDuplicate = (fingerprint: string): boolean =>
    (occurrences.get(hashFingerprint(fingerprint)) ?? 0) >= 2;

  const byFingerprint = new Map<string, CodeWindow[]>();
  for (const [filePath, content] of files.entries()) {
    const windows = extractWindows(filePath, content, minLines, isDuplicate);
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
  const safeMax = Number.isFinite(maxFindings) ? Math.max(0, Math.floor(maxFindings)) : 0;
  const capped = findings.slice(0, safeMax);
  return capped;
}

export async function scanPath(
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
