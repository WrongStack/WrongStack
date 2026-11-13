import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ChronicleFileLineageReader,
  ChronicleFileLineageRow,
} from '@wrongstack/contracts/types/chronicle-metrics';
import type { KanbanTask } from '@wrongstack/kanban';
import { resolveCachedGitIsolation } from './auto-review-git.js';
import { parsePorcelainStatusZ } from './git-porcelain.js';
import { JsonlFindingStore } from './review-finding-store.js';
import type {
  ResolvedChimeraConfig,
  ReviewContextBundle,
  ReviewDeletedFileReference,
  ReviewFileEntry,
  ReviewPriorFindingSummary,
  ReviewSignatureCallers,
  ReviewSkippedFile,
} from './review-types.js';

export { parsePorcelainStatusZ, statusUnderPrefix } from './git-porcelain.js';

// ---------------------------------------------------------------------------
// Noise filtering, candidate prioritization, and diff line-number helpers
// ---------------------------------------------------------------------------

const LOCKFILE_BASENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'go.sum',
  'composer.lock',
  'gemfile.lock',
]);

const BUILD_DIR_SEGMENTS = new Set([
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'node_modules',
  'target',
  '.turbo',
]);

const BINARY_OR_MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.avif',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pyc',
  '.class',
]);

const SOURCE_CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sql',
  '.sh',
  '.ps1',
  '.vue',
  '.svelte',
]);

/**
 * Classify generated, binary, lockfile, or internal paths that burn review
 * tokens without carrying reviewable source logic. Returns a concise detail
 * tag when the file should be skipped, or `null` when reviewable.
 */
export function isIgnoredReviewNoisePath(filePath: string): string | null {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const lower = normalized.toLowerCase();
  if (lower.startsWith('.wrongstack/') || lower === '.wrongstack') return 'internal_state';
  const segments = lower.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile';
  if (segments.slice(0, -1).some((seg) => BUILD_DIR_SEGMENTS.has(seg))) return 'build_artifact';
  if (base.endsWith('.snap')) return 'snapshot';
  if (base.endsWith('.map')) return 'sourcemap';
  if (
    base.endsWith('.min.js') ||
    base.endsWith('.min.mjs') ||
    base.endsWith('.min.css') ||
    base.endsWith('.bundle.js')
  ) {
    return 'minified';
  }
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx !== -1 && BINARY_OR_MEDIA_EXTENSIONS.has(base.slice(dotIdx))) {
    return 'binary_asset';
  }
  return null;
}

function candidateTier(filePath: string): number {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const isTest =
    /\.(?:test|spec)\.[a-z0-9]+$/.test(base) ||
    normalized.includes('/tests/') ||
    normalized.includes('/__tests__/');
  const dotIdx = base.lastIndexOf('.');
  const ext = dotIdx !== -1 ? base.slice(dotIdx) : '';
  if (SOURCE_CODE_EXTENSIONS.has(ext) && !isTest) return 0; // primary production code first
  if (SOURCE_CODE_EXTENSIONS.has(ext) && isTest) return 1; // test code second
  if (ext === '.css' || ext === '.scss' || ext === '.html') return 2; // UI markup/styles
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') return 3; // configs
  return 4; // docs / markdown / misc last
}

/**
 * Deterministically rank review candidates so source code files are never
 * crowded out by docs or JSON files when `maxFiles` caps a batch. Preserves
 * original relative order within each priority tier.
 */
export function prioritizeReviewCandidates<
  T extends { path: string; status: 'added' | 'modified' },
>(files: readonly T[], maxFiles: number): { selected: T[]; capped: T[] } {
  const cap = Math.max(1, maxFiles);
  const indexed = files.map((file, index) => ({ file, index, tier: candidateTier(file.path) }));
  indexed.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return {
    selected: indexed.slice(0, cap).map((entry) => entry.file),
    capped: indexed.slice(cap).map((entry) => entry.file),
  };
}

function truncateDiffSurrogateSafe(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  const lastKept = text.charCodeAt(end - 1);
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
  return {
    text: `${text.slice(0, end)}\n... (diff truncated at ${maxChars} bytes — please use the read tool to view full file content)`,
    truncated: true,
  };
}

const SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)/,
];

function extractSymbolName(codeLine: string): string | null {
  for (const pattern of SYMBOL_PATTERNS) {
    const match = pattern.exec(codeLine);
    if (match?.[1]) return match[1];
  }
  return null;
}

const EXPORTED_SYMBOL_PATTERNS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/,
];

function extractExportedSymbolName(codeLine: string): string | null {
  for (const pattern of EXPORTED_SYMBOL_PATTERNS) {
    const match = pattern.exec(codeLine);
    if (match?.[1]) return match[1];
  }
  return null;
}

export interface AnnotatedDiffResult {
  annotatedDiff: string;
  hunkCount: number;
  addedLines: number;
  removedLines: number;
  changedSymbols: string[];
  modifiedExportedSymbols: string[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Annotate a unified diff with exact post-image (current disk) line numbers on
 * `+` and context lines so the reviewer can cite `file:line` directly without
 * issuing redundant `read` tool calls. Also extracts hunk/line counts and
 * touched top-level symbol names.
 */
export function annotateUnifiedDiffWithLineNumbers(rawDiff: string): AnnotatedDiffResult {
  const lines = rawDiff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  let inHunk = false;
  let seenChangeInHunk = false;
  let newLine = 0;
  let hunkCount = 0;
  let addedLines = 0;
  let removedLines = 0;
  const symbols = new Set<string>();
  const modifiedExports = new Set<string>();

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      inHunk = true;
      seenChangeInHunk = false;
      hunkCount++;
      newLine = Number.parseInt(hunkMatch[3]!, 10);
      const headerContext = hunkMatch[5]?.trim();
      if (headerContext) {
        const sym = extractSymbolName(headerContext);
        if (sym && symbols.size < 16) symbols.add(sym);
      }
      out.push(line);
      continue;
    }

    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode ') ||
      line.startsWith('deleted file mode ') ||
      line.startsWith('similarity index ') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ')
    ) {
      inHunk = false;
      seenChangeInHunk = false;
      out.push(line);
      continue;
    }

    if (!inHunk) {
      out.push(line);
      continue;
    }

    if (line.startsWith('+')) {
      seenChangeInHunk = true;
      const body = line.slice(1);
      out.push(`${String(newLine).padStart(4, ' ')} | +${body}`);
      newLine++;
      addedLines++;
      const sym = extractSymbolName(body);
      if (sym && symbols.size < 16) symbols.add(sym);
      const exportedSym = extractExportedSymbolName(body);
      if (exportedSym && modifiedExports.size < 8) modifiedExports.add(exportedSym);
    } else if (line.startsWith('-')) {
      seenChangeInHunk = true;
      const body = line.slice(1);
      out.push(`     | -${body}`);
      removedLines++;
      const sym = extractSymbolName(body);
      if (sym && symbols.size < 16) symbols.add(sym);
      const exportedSym = extractExportedSymbolName(body);
      if (exportedSym && modifiedExports.size < 8) modifiedExports.add(exportedSym);
    } else if (line.startsWith(' ')) {
      const body = line.slice(1);
      out.push(`${String(newLine).padStart(4, ' ')} |  ${body}`);
      newLine++;
      // When a hunk starts near the top of a declaration, git diff places the
      // signature in the leading context lines rather than the `@@` header.
      if (!seenChangeInHunk) {
        const sym = extractSymbolName(body);
        if (sym && symbols.size < 16) symbols.add(sym);
      }
    } else {
      out.push(line);
    }
  }

  return {
    annotatedDiff: out.join('\n'),
    hunkCount,
    addedLines,
    removedLines,
    changedSymbols: [...symbols],
    modifiedExportedSymbols: [...modifiedExports],
  };
}

/**
 * Compute a compact line-numbered unified delta diff between `previousContent`
 * (an earlier completed review snapshot in this session) and `currentContent`
 * (current file on disk), with 3 lines of context and exact current disk line
 * numbers. Falls back to `null` if inputs are huge (>6,000 lines) or identical.
 */
export function computeHybridIncrementalDeltaDiff(
  previousContent: string,
  currentContent: string,
  headStats?: { hunkCount: number; addedLines: number; removedLines: number } | undefined,
): (AnnotatedDiffResult & { unchangedHunkSummary?: string | undefined }) | null {
  if (previousContent === currentContent) return null;
  const oldLines = previousContent.replace(/\r\n/g, '\n').split('\n');
  const newLines = currentContent.replace(/\r\n/g, '\n').split('\n');
  if (oldLines.length > 6_000 || newLines.length > 6_000) return null;

  // Trim common prefix and suffix first so typical localized edits run in O(delta^2)
  // rather than O(N*M) across the whole file.
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const midOld = oldLines.slice(prefix, oldEnd);
  const midNew = newLines.slice(prefix, newEnd);
  if (midOld.length * midNew.length > 1_500_000) return null;

  // LCS over the changed middle window
  const m = midOld.length;
  const n = midNew.length;
  const dp = new Uint16Array((m + 1) * (n + 1));
  const stride = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (midOld[i] === midNew[j]) {
        dp[i * stride + j] = (dp[(i + 1) * stride + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * stride + j] ?? 0;
        const right = dp[i * stride + (j + 1)] ?? 0;
        dp[i * stride + j] = Math.max(down, right);
      }
    }
  }

  type EditOp = { kind: 'equal' | 'add' | 'del'; text: string; oldLine: number; newLine: number };
  const ops: EditOp[] = [];
  for (let k = 0; k < prefix; k++) {
    ops.push({ kind: 'equal', text: newLines[k]!, oldLine: k + 1, newLine: k + 1 });
  }
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (midOld[i] === midNew[j]) {
      ops.push({
        kind: 'equal',
        text: midNew[j]!,
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      i++;
      j++;
    } else if ((dp[(i + 1) * stride + j] ?? 0) >= (dp[i * stride + (j + 1)] ?? 0)) {
      ops.push({
        kind: 'del',
        text: midOld[i]!,
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      i++;
    } else {
      ops.push({
        kind: 'add',
        text: midNew[j]!,
        oldLine: prefix + i + 1,
        newLine: prefix + j + 1,
      });
      j++;
    }
  }
  while (i < m) {
    ops.push({ kind: 'del', text: midOld[i]!, oldLine: prefix + i + 1, newLine: prefix + n + 1 });
    i++;
  }
  while (j < n) {
    ops.push({ kind: 'add', text: midNew[j]!, oldLine: prefix + m + 1, newLine: prefix + j + 1 });
    j++;
  }
  for (let k = newEnd; k < newLines.length; k++) {
    const oldIdx = oldEnd + (k - newEnd);
    ops.push({ kind: 'equal', text: newLines[k]!, oldLine: oldIdx + 1, newLine: k + 1 });
  }

  // Group non-equal ops into unified hunks with 3 lines of context
  const CONTEXT = 3;
  const changedIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.kind !== 'equal') changedIndices.push(idx);
  }
  if (changedIndices.length === 0) return null;

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changedIndices) {
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(ops.length - 1, idx + CONTEXT);
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end + 1) {
      prev.end = Math.max(prev.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const rawHunks: string[] = [];
  for (const range of ranges) {
    const slice = ops.slice(range.start, range.end + 1);
    const oldStart = slice[0]!.oldLine;
    const newStart = slice[0]!.newLine;
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    rawHunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) {
      if (op.kind === 'add') rawHunks.push(`+${op.text}`);
      else if (op.kind === 'del') rawHunks.push(`-${op.text}`);
      else rawHunks.push(` ${op.text}`);
    }
  }

  const annotated = annotateUnifiedDiffWithLineNumbers(rawHunks.join('\n'));
  const unchangedHunkSummary =
    headStats && headStats.hunkCount > annotated.hunkCount
      ? `${headStats.hunkCount - annotated.hunkCount} earlier session hunk(s) against HEAD were already reviewed and remain unchanged.`
      : 'Showing only delta edits since the previous completed review snapshot in this session.';
  return {
    ...annotated,
    unchangedHunkSummary,
  };
}

// ---------------------------------------------------------------------------
// Git helpers (shared with chimera-plugin.ts, intentionally duplicated
// to keep this module self-contained for testing).
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 15_000;
const MAX_DIFF_BYTES = 100_000; // cap individual file diffs to ~100KB
const MAX_RECENT_COMMITS = 10;

async function runGit(
  args: string[],
  cwd: string,
  preResolvedIsolation?: Record<string, string> | null,
): Promise<{ stdout: string; stderr: string; code: number }> {
  // The repository's config names programs git runs (fsmonitor, filters);
  // when they cannot be switched off, git does not run.
  const isolation =
    preResolvedIsolation !== undefined
      ? preResolvedIsolation
      : await resolveCachedGitIsolation(cwd);
  if (!isolation) return { stdout: '', stderr: 'git isolation unavailable', code: 1 };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: { ...process.env, ...isolation },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    // Decode across chunks: `+= chunk` decodes each Buffer alone and turns a
    // multibyte UTF-8 character split at a pipe-chunk boundary into U+FFFD.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: Buffer | string) => {
      stdout += d;
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr += d;
    });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    // `code` is null only when git was killed by a signal — never a success.
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

/**
 * Get the unified diff for a single file against HEAD, annotated with post-image
 * current disk line numbers. Returns `undefined` when the file is untracked
 * (added) or git fails.
 */
async function getFileDiff(
  cwd: string,
  filePath: string,
  isolation?: Record<string, string> | null,
): Promise<(AnnotatedDiffResult & { diffTruncated: boolean }) | undefined> {
  const r = await runGit(
    ['diff', '--no-ext-diff', '--no-textconv', '-U4', 'HEAD', '--', filePath],
    cwd,
    isolation,
  );
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  const rawCapped = truncateDiffSurrogateSafe(r.stdout, MAX_DIFF_BYTES);
  const annotated = annotateUnifiedDiffWithLineNumbers(rawCapped.text);
  const finalCapped = truncateDiffSurrogateSafe(annotated.annotatedDiff, MAX_DIFF_BYTES);
  return {
    ...annotated,
    annotatedDiff: finalCapped.text,
    diffTruncated: rawCapped.truncated || finalCapped.truncated,
  };
}

/**
 * Fetch short HEAD SHA and recent commit subjects in a single `git log` process
 * to minimize git subprocess overhead on Windows.
 */
async function getHeadAndRecentCommits(
  cwd: string,
  isolation?: Record<string, string> | null,
): Promise<{ headSha?: string | undefined; recentCommits?: string[] | undefined }> {
  const r = await runGit(['log', `-${MAX_RECENT_COMMITS}`, '--format=%h\t%s'], cwd, isolation);
  if (r.code !== 0 || !r.stdout.trim()) return {};
  const lines = r.stdout.split('\n').filter(Boolean);
  let headSha: string | undefined;
  const subjects: string[] = [];
  for (const line of lines) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) {
      subjects.push(line);
      continue;
    }
    if (!headSha) {
      const sha = line.slice(0, tabIdx).trim();
      if (sha) headSha = sha;
    }
    const subj = line.slice(tabIdx + 1).trim();
    if (subj) subjects.push(subj);
  }
  return {
    ...(headSha ? { headSha } : {}),
    ...(subjects.length > 0 ? { recentCommits: subjects } : {}),
  };
}

function candidateTestPathsFor(filePath: string): string[] {
  const norm = filePath.replaceAll('\\', '/');
  const dotIdx = norm.lastIndexOf('.');
  if (dotIdx === -1) return [];
  const ext = norm.slice(dotIdx);
  if (!SOURCE_CODE_EXTENSIONS.has(ext.toLowerCase())) return [];
  const baseNoExt = norm.slice(0, dotIdx);
  const slashIdx = baseNoExt.lastIndexOf('/');
  const dir = slashIdx !== -1 ? baseNoExt.slice(0, slashIdx) : '';
  const stem = slashIdx !== -1 ? baseNoExt.slice(slashIdx + 1) : baseNoExt;
  if (stem.endsWith('.test') || stem.endsWith('.spec') || norm.includes('/tests/')) return [];

  const candidates = new Set<string>();
  candidates.add(`${baseNoExt}.test${ext}`);
  candidates.add(`${baseNoExt}.spec${ext}`);
  if (dir) {
    candidates.add(`${dir}/__tests__/${stem}.test${ext}`);
  }
  const srcMatch = /^(.*?\/?)src\/(.+)$/.exec(baseNoExt);
  if (srcMatch) {
    const pkgPrefix = srcMatch[1] ?? '';
    const relStem = srcMatch[2]!;
    candidates.add(`${pkgPrefix}tests/${relStem}.test${ext}`);
    const relLeaf = relStem.slice(relStem.lastIndexOf('/') + 1);
    candidates.add(`${pkgPrefix}tests/${relLeaf}.test${ext}`);
  }
  return [...candidates];
}

async function resolvePairedTestStatus(
  cwd: string,
  filePath: string,
  changedPathSet: ReadonlySet<string>,
): Promise<{ pairedTestPath?: string; pairedTestUpdated?: boolean }> {
  const candidates = candidateTestPathsFor(filePath);
  for (const rel of candidates) {
    try {
      await fsp.access(path.join(cwd, rel));
      return {
        pairedTestPath: rel,
        pairedTestUpdated: changedPathSet.has(normalizeReviewPath(rel)),
      };
    } catch {
      /* try next candidate */
    }
  }
  return {};
}

async function loadPriorFindingsForFiles(
  projectDir: string | undefined,
  filePaths: readonly string[],
  extraPriorFindings: readonly ReviewPriorFindingSummary[] | undefined,
): Promise<ReviewPriorFindingSummary[] | undefined> {
  const out: ReviewPriorFindingSummary[] = [];
  const seenKeys = new Set<string>();
  const pushUnique = (entry: ReviewPriorFindingSummary) => {
    const key = `${entry.file ?? ''}:${entry.line ?? 0}:${entry.title.toLowerCase()}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push(entry);
  };

  if (extraPriorFindings) {
    for (const item of extraPriorFindings) pushUnique(item);
  }

  if (projectDir && filePaths.length > 0) {
    try {
      const targetSet = new Set(filePaths.map((p) => normalizeReviewPath(p)));
      const store = new JsonlFindingStore(projectDir);
      const existing = await store.list({ limit: 200 });
      for (const finding of existing) {
        const fPath = finding.location?.file;
        if (!fPath || !targetSet.has(normalizeReviewPath(fPath))) continue;
        // Include active/triaged/in_progress AND operator-suppressed findings
        // (`ignored`, or `resolved` as `wontfix` / `false_positive`) so the
        // reviewer knows not to re-raise suppressed items.
        const outcome = finding.resolution?.outcome;
        const isSuppressed =
          finding.status === 'ignored' ||
          (finding.status === 'resolved' &&
            (outcome === 'wontfix' || outcome === 'false_positive'));
        const isOpen =
          finding.status === 'active' ||
          finding.status === 'triaged' ||
          finding.status === 'in_progress';
        if (!isSuppressed && !isOpen) continue;
        pushUnique({
          id: finding.id,
          severity: finding.severity,
          status: finding.status,
          ...(outcome ? { outcome } : {}),
          file: fPath,
          ...(finding.location?.line !== undefined ? { line: finding.location.line } : {}),
          title: finding.title,
        });
        if (out.length >= 25) break;
      }
    } catch {
      /* best-effort */
    }
  }

  return out.length > 0 ? out : undefined;
}

async function getAllChangedFiles(
  cwd: string,
  isolation?: Record<string, string> | null,
): Promise<Array<{ path: string; status: string }>> {
  const r = await runGit(['status', '--porcelain', '-z'], cwd, isolation);
  return r.code === 0 ? parsePorcelainStatusZ(r.stdout) : [];
}

// ---------------------------------------------------------------------------
// Session intent extraction & deleted-file dangling reference helpers
// ---------------------------------------------------------------------------

const GENERIC_MODULE_STEMS = new Set([
  'index',
  'types',
  'utils',
  'helpers',
  'common',
  'config',
  'constants',
  'setup',
  'schema',
  'model',
  'models',
  'store',
  'stores',
  'style',
  'styles',
  'route',
  'routes',
  'server',
  'client',
  'error',
  'errors',
]);

function sliceCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return `${out}…`;
}

function cleanUserIntentSnippet(raw: string): string {
  const withoutSystemBlocks = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/\[System:[\s\S]*?\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutSystemBlocks || withoutSystemBlocks.startsWith('/')) return '';
  return sliceCodePoints(withoutSystemBlocks, 220);
}

/**
 * Extract up to the 3 most recent user request snippets from conversation
 * messages and/or explicit `agent.run.started` `inputText` entries, bounded to
 * ~540 UTF-16 code units total so the reviewer understands session intent
 * without bloating prompt tokens.
 */
export function extractSessionIntentSnippets(input: {
  messages?: ReadonlyArray<{ role?: string | undefined; content?: unknown }> | undefined;
  extraInputs?: readonly string[] | undefined;
}): string[] {
  const candidates: string[] = [];

  if (Array.isArray(input.messages)) {
    for (const msg of input.messages) {
      if (msg?.role !== 'user') continue;
      if (typeof msg.content === 'string') {
        const cleaned = cleanUserIntentSnippet(msg.content);
        if (cleaned) candidates.push(cleaned);
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const block of msg.content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            textParts.push((block as { text: string }).text);
          }
        }
        const cleaned = cleanUserIntentSnippet(textParts.join(' '));
        if (cleaned) candidates.push(cleaned);
      }
    }
  }

  if (Array.isArray(input.extraInputs)) {
    for (const text of input.extraInputs) {
      if (typeof text !== 'string') continue;
      const cleaned = cleanUserIntentSnippet(text);
      if (cleaned) candidates.push(cleaned);
    }
  }

  // Deduplicate preserving latest position, keep at most 3 recent snippets.
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (let i = candidates.length - 1; i >= 0; i--) {
    const item = candidates[i]!;
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.unshift(item);
    if (deduped.length >= 3) break;
  }

  let budget = 540;
  const bounded: string[] = [];
  for (const snippet of deduped) {
    if (budget <= 40) break;
    const clipped = sliceCodePoints(snippet, budget);
    bounded.push(clipped);
    budget -= clipped.length;
  }
  return bounded;
}

async function findDeletedFileReferences(
  cwd: string,
  deletedFiles: readonly string[],
  isolation?: Record<string, string> | null,
): Promise<ReviewDeletedFileReference[] | undefined> {
  if (deletedFiles.length === 0) return undefined;
  const deletedNormSet = new Set(deletedFiles.map(normalizeReviewPath));
  const candidates: Array<{ deletedPath: string; stem: string }> = [];

  for (const del of deletedFiles) {
    if (isIgnoredReviewNoisePath(del)) continue;
    const base = path.posix.basename(del.replaceAll('\\', '/'));
    const stem = base.replace(/\.(?:d\.ts|[^.]+)$/i, '');
    if (stem.length < 5 || GENERIC_MODULE_STEMS.has(stem.toLowerCase())) continue;
    candidates.push({ deletedPath: del, stem });
    if (candidates.length >= 5) break;
  }

  if (candidates.length === 0) return undefined;

  const hits = await Promise.all(
    candidates.map(async ({ deletedPath, stem }) => {
      const res = await runGit(['grep', '-l', '-I', '--fixed-strings', '--', stem], cwd, isolation);
      if (res.code !== 0 || !res.stdout.trim()) return null;
      const referencedBy = res.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(
          (filePath) => filePath.length > 0 && !deletedNormSet.has(normalizeReviewPath(filePath)),
        )
        .slice(0, 8);
      if (referencedBy.length === 0) return null;
      return { deletedPath, referencedBy };
    }),
  );

  const nonEmpty = hits.filter((item): item is ReviewDeletedFileReference => item !== null);
  return nonEmpty.length > 0 ? nonEmpty : undefined;
}

const GENERIC_EXPORT_SYMBOL_NAMES = new Set([
  'action',
  'config',
  'context',
  'count',
  'default',
  'error',
  'errors',
  'handler',
  'input',
  'items',
  'options',
  'output',
  'params',
  'payload',
  'props',
  'result',
  'results',
  'schema',
  'state',
  'status',
  'value',
  'values',
]);

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findModifiedExportCallers(
  cwd: string,
  candidates: ReadonlyArray<{ symbol: string; file: string }>,
  deletedFiles: readonly string[],
  isolation?: Record<string, string> | null,
): Promise<ReviewSignatureCallers[] | undefined> {
  if (candidates.length === 0) return undefined;

  const deletedNormSet = new Set(deletedFiles.map(normalizeReviewPath));
  const selected: Array<{ symbol: string; file: string; wordRe: RegExp; callers: Set<string> }> =
    [];
  const seenSymbols = new Set<string>();
  for (const cand of candidates) {
    const lowerSym = cand.symbol.toLowerCase();
    if (
      cand.symbol.length < 5 ||
      GENERIC_MODULE_STEMS.has(lowerSym) ||
      GENERIC_EXPORT_SYMBOL_NAMES.has(lowerSym)
    ) {
      continue;
    }
    if (seenSymbols.has(cand.symbol)) continue;
    seenSymbols.add(cand.symbol);
    selected.push({
      symbol: cand.symbol,
      file: cand.file,
      wordRe: new RegExp(`(?<![\\w$])${escapeRegExpLiteral(cand.symbol)}(?![\\w$])`),
      callers: new Set<string>(),
    });
    if (selected.length >= 4) break;
  }

  // Zero git subprocess spawns when no exported signatures were modified.
  if (selected.length === 0) return undefined;

  // Single batched `git grep` across all modified exported symbols.
  const grepArgs = ['grep', '-n', '-I', '-F', ...selected.flatMap((c) => ['-e', c.symbol])];
  const res = await runGit(grepArgs, cwd, isolation);
  if (res.code !== 0 || !res.stdout.trim()) return undefined;

  for (const rawLine of res.stdout.split('\n')) {
    if (!rawLine) continue;
    const match = /^([^\0:]+):(\d+):(.*)$/.exec(rawLine);
    if (!match) continue;
    const hitPath = match[1]!.trim();
    const lineNum = match[2]!;
    const snippet = match[3] ?? '';
    if (!hitPath || isIgnoredReviewNoisePath(hitPath)) continue;
    const normHit = normalizeReviewPath(hitPath);
    if (deletedNormSet.has(normHit)) continue;

    for (const item of selected) {
      if (item.callers.size >= 5) continue;
      if (normHit === normalizeReviewPath(item.file)) continue;
      if (item.wordRe.test(snippet)) {
        item.callers.add(`${hitPath}:${lineNum}`);
      }
    }
  }

  const out: ReviewSignatureCallers[] = [];
  for (const item of selected) {
    if (item.callers.size > 0) {
      out.push({
        symbol: item.symbol,
        file: item.file,
        callers: [...item.callers],
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export interface BuildReviewContextOptions {
  cwd: string;
  config: ResolvedChimeraConfig;
  /** Files to review, with content already read. */
  files: Array<{ path: string; status: 'added' | 'modified'; content: string }>;
  /**
   * Active todo items from the session Context (P1 enrichment).
   * Available from `ctx.todos` in the iteration.completed handler.
   * Passed in by the caller — the builder itself has no ctx access.
   */
  activeTodos?: Array<{ id: string; content: string; status: string }> | undefined;
  /**
   * Bounded user request snippets from this session so the reviewer understands
   * user intent and avoids flagging deliberate choices.
   */
  sessionIntent?: string[] | undefined;
  /**
   * Chronicle file-lineage lookup for provenance (host-bound, see
   * `CHRONICLE_FILE_LINEAGE`). Absent: the bundle carries no provenance.
   */
  fileLineage?: ChronicleFileLineageReader | undefined;
  /**
   * Cascade severity threshold from the auto-review plugin config.
   * Threaded into the bundle so execution.ts and the cascade listener
   * can decide whether findings warrant a follow-up agent. Absent for
   * non-auto-review triggers (chimera plugin, /review slash command).
   */
  cascadeOn?: 'off' | 'critical' | 'high' | undefined;
  /**
   * Current cascade depth (0 = initial review). Increments on each
   * fix+re-review cycle; the cascade stops at maxCascadeDepth.
   */
  cascadeDepth?: number | undefined;
  /**
   * Maximum cascade iterations before the self-correcting loop stops.
   * Default 2. Absent for non-auto-review triggers.
   */
  maxCascadeDepth?: number | undefined;
  /**
   * Earlier completed review snapshots in this session (keyed by path or
   * normalized lowercase path). When a modified file was already reviewed and
   * edited again, `buildReviewContext` emits a compact hybrid delta diff
   * instead of re-sending the entire session diff.
   */
  previousSnapshots?: ReadonlyMap<string, { sha256: string; content: string }> | undefined;
  /**
   * Project metadata directory (`~/.wrongstack/projects/<slug>`) used to look up
   * prior/ignored/wontfix findings on the reviewed files.
   */
  projectDir?: string | undefined;
  /**
   * Files excluded before `buildReviewContext` ran (noise, maxFiles cap,
   * already reviewed, unreadable).
   */
  skippedFiles?: ReviewSkippedFile[] | undefined;
  /**
   * Explicit prior findings (e.g. parent verified findings in a cascade
   * re-review) merged ahead of persisted store findings.
   */
  priorFindings?: ReviewPriorFindingSummary[] | undefined;
  /**
   * Pre-resolved `gitIsolationEnv(cwd)` from the caller so `buildReviewContext`
   * skips spawning duplicate git-config/isolation probes on Windows.
   */
  preResolvedIsolation?: Record<string, string> | null | undefined;
  /**
   * Pre-computed porcelain status entries from the caller so `buildReviewContext`
   * skips spawning a second `git status --porcelain -z` subprocess.
   */
  precomputedChangedFiles?: Array<{ path: string; status: string }> | undefined;
}

/**
 * Enrich a bare file list with line-numbered diffs (or hybrid incremental
 * deltas), symbol & paired-test signals, sibling-change awareness, deleted
 * files, HEAD SHA, prior findings, and recent commit history.
 *
 * The function never throws — all enrichment is best-effort. If a git
 * operation fails, the corresponding field is simply left `undefined`,
 * and the caller still gets a valid bundle with the original file data.
 */
export async function buildReviewContext(
  opts: BuildReviewContextOptions,
): Promise<ReviewContextBundle> {
  const { cwd, config } = opts;

  let isolation: Record<string, string> | null = null;
  if (opts.preResolvedIsolation !== undefined) {
    isolation = opts.preResolvedIsolation;
  } else {
    try {
      isolation = (await resolveCachedGitIsolation(cwd)) ?? null;
    } catch {
      isolation = null;
    }
  }

  const filePaths = opts.files.map((f) => f.path);

  // ── Single parallel wave: git status, git log, per-file git diff, kanban, chronicle & prior findings ──
  const [allChangedFiles, logMeta, rawFileDiffs, kanbanCard, rawFileProvenance, priorFindings] =
    await Promise.all([
      opts.precomputedChangedFiles !== undefined
        ? Promise.resolve(opts.precomputedChangedFiles)
        : getAllChangedFiles(cwd, isolation).catch(() => undefined),
      getHeadAndRecentCommits(cwd, isolation).catch(() => ({
        headSha: undefined,
        recentCommits: undefined,
      })),
      Promise.all(
        opts.files.map((f) =>
          f.status === 'modified'
            ? getFileDiff(cwd, f.path, isolation).catch(() => undefined)
            : Promise.resolve(undefined),
        ),
      ),
      findActiveKanbanCard(cwd).catch(() => undefined),
      findFileProvenance(cwd, filePaths, opts.fileLineage).catch(() => []),
      loadPriorFindingsForFiles(opts.projectDir, filePaths, opts.priorFindings),
    ]);

  const headSha = logMeta.headSha;
  const recentCommits = logMeta.recentCommits;
  const fileProvenance = rawFileProvenance.length > 0 ? rawFileProvenance : undefined;
  const changedPathSet = new Set(
    (allChangedFiles ?? []).map((entry) => normalizeReviewPath(entry.path)),
  );
  const deletedFiles = (allChangedFiles ?? [])
    .filter((entry) => entry.status === 'D' || entry.status.includes('D'))
    .map((entry) => entry.path);

  // ── Enrich files with pre-fetched diffs / hybrid deltas, SHA-256, symbols & paired tests ──
  const modifiedExportCandidates: Array<{ symbol: string; file: string }> = [];
  const filesWithDiffs: ReviewFileEntry[] = await Promise.all(
    opts.files.map(async (f, fileIdx) => {
      const sha256 = createHash('sha256').update(f.content).digest('hex');
      const entry: ReviewFileEntry = {
        path: f.path,
        status: f.status,
        content: f.content,
        sha256,
      };

      const prevSnap =
        opts.previousSnapshots?.get(f.path) ??
        opts.previousSnapshots?.get(f.path.replaceAll('\\', '/').toLowerCase());
      const hasPrevContent = Boolean(
        prevSnap && prevSnap.content.length > 0 && prevSnap.sha256 !== sha256,
      );

      if (f.status === 'modified' || hasPrevContent) {
        const headDiff = rawFileDiffs[fileIdx];

        if (hasPrevContent && prevSnap) {
          const delta = computeHybridIncrementalDeltaDiff(
            prevSnap.content,
            f.content,
            headDiff
              ? {
                  hunkCount: headDiff.hunkCount,
                  addedLines: headDiff.addedLines,
                  removedLines: headDiff.removedLines,
                }
              : undefined,
          );
          if (delta) {
            const capped = truncateDiffSurrogateSafe(delta.annotatedDiff, MAX_DIFF_BYTES);
            entry.diff = capped.text;
            entry.hunkCount = delta.hunkCount;
            entry.addedLines = delta.addedLines;
            entry.removedLines = delta.removedLines;
            entry.diffTruncated = capped.truncated;
            entry.isIncrementalDelta = true;
            entry.unchangedHunkSummary = delta.unchangedHunkSummary;
            if (delta.changedSymbols.length > 0) entry.changedSymbols = delta.changedSymbols;
            for (const sym of delta.modifiedExportedSymbols) {
              modifiedExportCandidates.push({ symbol: sym, file: f.path });
            }
          } else if (headDiff) {
            entry.diff = headDiff.annotatedDiff;
            entry.hunkCount = headDiff.hunkCount;
            entry.addedLines = headDiff.addedLines;
            entry.removedLines = headDiff.removedLines;
            entry.diffTruncated = headDiff.diffTruncated;
            if (headDiff.changedSymbols.length > 0) entry.changedSymbols = headDiff.changedSymbols;
            for (const sym of headDiff.modifiedExportedSymbols) {
              modifiedExportCandidates.push({ symbol: sym, file: f.path });
            }
          }
        } else if (headDiff) {
          entry.diff = headDiff.annotatedDiff;
          entry.hunkCount = headDiff.hunkCount;
          entry.addedLines = headDiff.addedLines;
          entry.removedLines = headDiff.removedLines;
          entry.diffTruncated = headDiff.diffTruncated;
          if (headDiff.changedSymbols.length > 0) entry.changedSymbols = headDiff.changedSymbols;
          for (const sym of headDiff.modifiedExportedSymbols) {
            modifiedExportCandidates.push({ symbol: sym, file: f.path });
          }
        }
      } else if (f.status === 'added') {
        const addedLineList = f.content.replace(/\r\n/g, '\n').split('\n');
        entry.addedLines =
          addedLineList.length > 0 && addedLineList[addedLineList.length - 1] === ''
            ? addedLineList.length - 1
            : addedLineList.length;
        entry.removedLines = 0;
        const symbols = new Set<string>();
        for (const line of addedLineList) {
          const sym = extractSymbolName(line);
          if (sym) {
            symbols.add(sym);
            if (symbols.size >= 16) break;
          }
        }
        if (symbols.size > 0) entry.changedSymbols = [...symbols];
      }

      try {
        const paired = await resolvePairedTestStatus(cwd, f.path, changedPathSet);
        if (paired.pairedTestPath) {
          entry.pairedTestPath = paired.pairedTestPath;
          entry.pairedTestUpdated = paired.pairedTestUpdated;
        }
      } catch {
        // best-effort
      }

      return entry;
    }),
  );

  // ── Active todos & cascade threshold (passed in from caller) ──
  const activeTodos =
    opts.activeTodos && opts.activeTodos.length > 0 ? opts.activeTodos : undefined;
  const cascadeOn = opts.cascadeOn ?? undefined;
  const cascadeDepth = opts.cascadeDepth ?? undefined;
  const maxCascadeDepth = opts.maxCascadeDepth ?? undefined;

  // ── Deleted-file dangling references & modified export callers in parallel (0 git spawns in common case) ──
  const [deletedFileReferences, signatureCallers] = await Promise.all([
    findDeletedFileReferences(cwd, deletedFiles, isolation).catch(() => undefined),
    findModifiedExportCallers(cwd, modifiedExportCandidates, deletedFiles, isolation).catch(
      () => undefined,
    ),
  ]);

  const sessionIntent =
    opts.sessionIntent && opts.sessionIntent.length > 0 ? opts.sessionIntent : undefined;

  return {
    config,
    cwd,
    files: filesWithDiffs,
    allChangedFiles,
    ...(headSha ? { headSha } : {}),
    ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
    ...(deletedFileReferences ? { deletedFileReferences } : {}),
    ...(signatureCallers ? { signatureCallers } : {}),
    ...(sessionIntent ? { sessionIntent } : {}),
    ...(opts.skippedFiles && opts.skippedFiles.length > 0
      ? { skippedFiles: opts.skippedFiles }
      : {}),
    ...(priorFindings ? { priorFindings } : {}),
    recentCommits,
    activeTodos,
    cascadeOn,
    cascadeDepth,
    maxCascadeDepth,
    kanbanCard,
    fileProvenance,
  };
}

// ---------------------------------------------------------------------------
// P1 enrichment: kanban card lookup
// ---------------------------------------------------------------------------

/**
 * Find the active (in_progress/review status or running/review lifecycle stage)
 * kanban task across all boards. Enrichment is safe only when exactly one card
 * is active; concurrent active cards are ambiguous and could attach another
 * task's criteria.
 *
 * Uses dynamic import so the builder doesn't hard-depend on @wrongstack/kanban
 * (which may not be installed in all contexts). Best-effort: returns
 * undefined if kanban isn't available, no boards exist, or the active card
 * cannot be identified unambiguously.
 */
async function findActiveKanbanCard(
  projectRoot: string,
): Promise<ReviewContextBundle['kanbanCard']> {
  let kanbanApi: typeof import('@wrongstack/kanban');
  try {
    kanbanApi = await import('@wrongstack/kanban');
  } catch {
    return undefined; // kanban package not available
  }

  const activeTasks: KanbanTask[] = [];
  const boards = await kanbanApi.listBoards(projectRoot);
  for (const board of boards) {
    const data = await kanbanApi.getBoard(projectRoot, board.id);
    if (!data?.tasks) continue;
    activeTasks.push(
      ...data.tasks.filter(
        (task) =>
          task.status === 'in_progress' ||
          task.status === 'review' ||
          task.lifecycle?.currentStage === 'running' ||
          task.lifecycle?.currentStage === 'review',
      ),
    );
  }

  if (activeTasks.length !== 1) return undefined;
  const task = activeTasks[0];
  if (!task) return undefined;
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    successCriteria: task.successCriteria?.map((criterion) => criterion.description),
  };
}

// ---------------------------------------------------------------------------
// P1 enrichment: Chronicle file provenance
// ---------------------------------------------------------------------------

/**
 * Most recent Chronicle event touching each changed file path: agent/task
 * attribution so the reviewer knows WHO made the change and in what task
 * context. The lineage reader is host-bound (`CHRONICLE_FILE_LINEAGE`); without
 * one there is no provenance. Provenance enriches a review, it never gates one.
 */
async function findFileProvenance(
  projectRoot: string,
  filePaths: string[],
  readLineage: ChronicleFileLineageReader | undefined,
): Promise<NonNullable<ReviewContextBundle['fileProvenance']>> {
  if (filePaths.length === 0 || !readLineage) return [];
  const uniquePaths = [...new Set(filePaths)];
  const rows = await readLineage(projectRoot, uniquePaths);
  const byPath = new Map(rows.map((row) => [normalizeReviewPath(row.path), row] as const));
  const provenance: NonNullable<ReviewContextBundle['fileProvenance']> = [];
  for (const filePath of uniquePaths) {
    const row = byPath.get(normalizeReviewPath(filePath));
    if (!row) continue;
    provenance.push({
      path: filePath,
      agentId: row.agentId || undefined,
      taskId: row.taskId || undefined,
      eventType: lineageEventType(row),
      observedAt: row.occurredAt,
    });
  }
  return provenance;
}

function normalizeReviewPath(filePath: string): string {
  // Locale-independent: under a Turkish locale `I` lowers to dotless `ı`.
  return filePath.replaceAll('\\', '/').toLowerCase();
}

function lineageEventType(row: ChronicleFileLineageRow): string {
  return row.source === 'external' ? `file.external.${row.operation || 'modified'}` : 'file.event';
}

// ---------------------------------------------------------------------------
// Deterministic zero-token pre-screen fast path (P1-3)
// ---------------------------------------------------------------------------

export interface ZeroTokenReviewFastPathVerdict {
  eligible: boolean;
  reason?: 'docs_only' | 'comments_or_whitespace_only' | undefined;
}

const PROSE_DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);
const PROSE_DOC_BASENAMES = new Set([
  'license',
  'license.md',
  'license.txt',
  'changelog',
  'changelog.md',
  'notice',
  'authors',
  'contributors',
]);
const EXECUTABLE_DOC_BASENAMES = new Set([
  'skill.md',
  'agents.md',
  'claude.md',
  '.cursorrules',
  'copilot-instructions.md',
]);
const EXECUTABLE_DOC_DIR_RE = /(?:^|\/)(?:instructions|skills|prompts|agents)\//i;

const SLASH_COMMENT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.swift',
  '.dart',
]);

const HASH_COMMENT_EXTENSIONS = new Set([
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.yaml',
  '.yml',
  '.toml',
  '.rb',
  '.conf',
  '.ini',
]);

const SUPPRESSION_DIRECTIVE_RE =
  /@ts-(?:ignore|expect-error|nocheck)|eslint-disable|biome-ignore|oxlint-disable|type:\s*ignore|\bnoqa\b|\bnosec\b|#\[allow\b|\/\/\s*nolint|@SuppressWarnings|\.(?:skip|only)\s*\(/i;

function isPureProseDocPath(filePath: string): boolean {
  const norm = filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const base = path.posix.basename(norm).toLowerCase();
  if (EXECUTABLE_DOC_BASENAMES.has(base)) return false;
  if (EXECUTABLE_DOC_DIR_RE.test(norm)) return false;
  if (PROSE_DOC_BASENAMES.has(base)) return true;
  const ext = path.posix.extname(base);
  return PROSE_DOC_EXTENSIONS.has(ext);
}

function isCommentOrWhitespaceOnlyDiff(filePath: string, diff: string): boolean {
  const ext = path.posix.extname(filePath.replaceAll('\\', '/')).toLowerCase();
  const allowsSlashComment = SLASH_COMMENT_EXTENSIONS.has(ext);
  const allowsHashComment = HASH_COMMENT_EXTENSIONS.has(ext);
  if (!allowsSlashComment && !allowsHashComment) return false;

  let inHunk = false;
  let changedLines = 0;

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (HUNK_HEADER_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;

    let changedBody: string | null = null;
    const annotatedChanged = /^(?:\s*\d+\s*\|\s\+|\s*\|\s-)(.*)$/.exec(line);
    if (annotatedChanged) {
      changedBody = annotatedChanged[1] ?? '';
    } else if (/^\s*\d+\s*\|\s(?: |$)/.test(line)) {
      // Annotated context line — unchanged
      continue;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      changedBody = line.slice(1);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      changedBody = line.slice(1);
    } else {
      continue;
    }

    changedLines++;
    const trimmed = changedBody.trim();
    if (trimmed.length === 0) continue;
    if (SUPPRESSION_DIRECTIVE_RE.test(trimmed)) return false;

    if (allowsSlashComment) {
      // Exclude TS triple-slash directives (`/// <reference ... />`)
      if (!trimmed.startsWith('//') || /^\/\/\/\s*<reference\b/i.test(trimmed)) {
        return false;
      }
      continue;
    }
    if (allowsHashComment) {
      if (!trimmed.startsWith('#') || trimmed.startsWith('#!')) {
        return false;
      }
    }
  }

  return changedLines > 0;
}

/**
 * Deterministically pre-screen an automated review bundle so pure prose-doc
 * updates and comment/whitespace-only diffs complete in 0 LLM tokens ($0.00)
 * while still recording a full `ReviewReport` + `scopeManifest` audit trail.
 *
 * Never triggers for manual `/review`, cascade re-reviews, bundles with
 * dangling deleted-file imports, active prior findings, or prompt/skill files.
 */
export function classifyZeroTokenReviewFastPath(
  bundle: Pick<
    ReviewContextBundle,
    'files' | 'manualTrigger' | 'cascadeDepth' | 'deletedFileReferences' | 'priorFindings'
  >,
): ZeroTokenReviewFastPathVerdict {
  if (bundle.files.length === 0) return { eligible: false };
  if (bundle.manualTrigger) return { eligible: false };
  if ((bundle.cascadeDepth ?? 0) > 0) return { eligible: false };
  if ((bundle.deletedFileReferences?.length ?? 0) > 0) return { eligible: false };
  if (bundle.priorFindings?.some((f) => f.status === 'active')) return { eligible: false };

  let allDocs = true;
  for (const file of bundle.files) {
    if (isPureProseDocPath(file.path)) {
      continue;
    }
    allDocs = false;
    if (
      file.status !== 'modified' ||
      file.diffTruncated ||
      typeof file.diff !== 'string' ||
      file.diff.trim().length === 0 ||
      !isCommentOrWhitespaceOnlyDiff(file.path, file.diff)
    ) {
      return { eligible: false };
    }
  }

  return {
    eligible: true,
    reason: allDocs ? 'docs_only' : 'comments_or_whitespace_only',
  };
}
