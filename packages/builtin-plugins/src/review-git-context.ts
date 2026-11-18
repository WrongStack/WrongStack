import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { resolveCachedGitIsolation } from './auto-review-git.js';
import { parsePorcelainStatusZ } from './git-porcelain.js';
import {
  isIgnoredReviewNoisePath,
  normalizeReviewPath,
  SOURCE_CODE_EXTENSIONS,
} from './review-candidates.js';
import {
  type AnnotatedDiffResult,
  annotateUnifiedDiffWithLineNumbers,
  truncateDiffSurrogateSafe,
} from './review-diff.js';
import type { ReviewDeletedFileReference, ReviewSignatureCallers } from './review-types.js';

const GIT_TIMEOUT_MS = 15_000;
export const MAX_DIFF_BYTES = 100_000; // cap individual file diffs to ~100KB
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
export async function getFileDiff(
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
export async function getHeadAndRecentCommits(
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

export async function resolvePairedTestStatus(
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

export async function getAllChangedFiles(
  cwd: string,
  isolation?: Record<string, string> | null,
): Promise<Array<{ path: string; status: string }>> {
  const r = await runGit(['status', '--porcelain', '-z'], cwd, isolation);
  return r.code === 0 ? parsePorcelainStatusZ(r.stdout) : [];
}

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

export async function findDeletedFileReferences(
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

export async function findModifiedExportCallers(
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
