/**
 * `codebase-diff-impact` tool — analyze the blast radius, affected symbols,
 * contract invariant violations, and impacted test suites of a git diff
 * (working tree, staged, or branch/commit range).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { type Tool, ToolValidationError } from '@wrongstack/contracts/types';
import { gitIsolationEnv } from '@wrongstack/primitives';
import { type InvariantViolation, polyglotInvariantEngine } from './ast-invariant-engine.js';
import { ensureAtlasDir, writeAtlasFile } from './atlas-projection.js';
import {
  discoverConventionTestFiles,
  type ImpactCallSite,
  isTestFilePath,
} from './codebase-impact-analysis-tool.js';
import {
  type AnchoredFileHealth,
  type AnchoredSageInsight,
  findAnchoredSageMemories,
  findFileHealthAlerts,
} from './ecosystem-bridge.js';
import type { StructuralChangeKind } from './fingerprint.js';
import { codebaseIndexDirOverride, indexStorePool, resolveIndexDir } from './writer.js';
import { posixIndexPath } from './writer-helpers.js';

const execFileAsync = promisify(execFile);

export interface DiffHunkRange {
  startLine: number;
  endLine: number;
}

export interface ParsedDiffFile {
  /** Project-relative POSIX file path. */
  file: string;
  status: 'added' | 'modified' | 'deleted';
  hunks: DiffHunkRange[];
}

export interface DiffAffectedSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  directCallers: number;
  transitiveCallers: number;
}

export interface DiffChangedFileReport {
  file: string;
  status: 'added' | 'modified' | 'deleted';
  changeKind: StructuralChangeKind;
  modifiedSymbols: string[];
  invariantViolations: InvariantViolation[];
}

export interface CodebaseDiffImpactInput {
  /**
   * Optional git ref or range to diff against (e.g. `"HEAD"`, `"HEAD~1"`,
   * `"main..HEAD"`). Defaults to `"HEAD"` (working tree + staged changes).
   */
  baseRef?: string | undefined;
  /** When true, inspect only staged (`git diff --cached`) changes. */
  staged?: boolean | undefined;
  /** Optional list of project-relative file paths to restrict the analysis. */
  files?: string[] | undefined;
  /** Whether to traverse transitive callers (default: true). */
  transitive?: boolean | undefined;
  /** When true, write `.wrongstack/atlas/diff-overlay.json` for visual blast-radius inspection. */
  persist?: boolean | undefined;
}

export const ATLAS_DIFF_OVERLAY_JSON = '.wrongstack/atlas/diff-overlay.json';

export interface CodebaseDiffImpactOutput {
  status: 'ok';
  baseRef: string;
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  changedFiles: DiffChangedFileReport[];
  affectedSymbols: DiffAffectedSymbol[];
  totalCallSites: number;
  affectedProductionFiles: string[];
  affectedTestFiles: string[];
  invariantViolations: Array<InvariantViolation & { file: string }>;
  callSites: ImpactCallSite[];
  recommendedActionPlan: string[];
  relatedMemories?: AnchoredSageInsight[] | undefined;
  fileHealthAlerts?: AnchoredFileHealth[] | undefined;
  persistedOverlayPath?: string | undefined;
}

/**
 * Persist a git diff blast-radius overlay to `.wrongstack/atlas/diff-overlay.json`
 * so visual graph viewers (`CodeMap`) and external tools can render 0/1/2-hop
 * affected nodes without re-running git diff.
 */
export async function writeDiffImpactOverlay(
  projectRoot: string,
  report: CodebaseDiffImpactOutput,
): Promise<{ path: string; bytes: number }> {
  const payload = `${JSON.stringify(
    {
      schema: 1,
      generatedAt: Date.now(),
      baseRef: report.baseRef,
      riskLevel: report.riskLevel,
      summary: report.summary,
      changedFiles: report.changedFiles,
      affectedSymbols: report.affectedSymbols,
      affectedProductionFiles: report.affectedProductionFiles,
      affectedTestFiles: report.affectedTestFiles,
      invariantViolations: report.invariantViolations,
      callSites: report.callSites,
    },
    null,
    2,
  )}\n`;
  const dir = await ensureAtlasDir(projectRoot);
  await writeAtlasFile(dir, path.basename(ATLAS_DIFF_OVERLAY_JSON), payload);
  return {
    path: ATLAS_DIFF_OVERLAY_JSON,
    bytes: Buffer.byteLength(payload, 'utf8'),
  };
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Undo git's C quoting; `\NNN` escapes are UTF-8 bytes, decoded together. */
function unquoteGitPath(inner: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const code = inner.codePointAt(i) ?? 0;
    if (code !== 92) {
      const ch = String.fromCodePoint(code);
      bytes.push(...Buffer.from(ch, 'utf8'));
      i += ch.length - 1;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
      continue;
    }
    const next = inner[i + 1] ?? '';
    bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * A `---`/`+++` path as git prints it: C-quoted when it holds non-ASCII or
 * special bytes (core.quotePath), behind `a/`/`b/` or a `diff.mnemonicPrefix`
 * letter (`c/`, `i/`, `w/`, `o/`).
 */
function diffHeaderPath(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = unquoteGitPath(value.slice(1, -1));
  }
  return value === '/dev/null' ? value : value.replace(/^[abciwo]\//, '');
}

/**
 * Parse unified `git diff -U0` output into per-file changed line ranges.
 * Exported as a pure helper for direct unit testing.
 */
export function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const results: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldPath = '';

  for (const rawLine of diffText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      current = null;
      oldPath = '';
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = diffHeaderPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = diffHeaderPath(line.slice(4));
      const isDeleted = newPath === '/dev/null';
      const isAdded = oldPath === '/dev/null';
      const relPath = (isDeleted ? oldPath : newPath).replace(/\\/g, '/');
      if (!relPath || relPath === '/dev/null') continue;
      current = {
        file: relPath,
        status: isAdded ? 'added' : isDeleted ? 'deleted' : 'modified',
        hunks: [],
      };
      results.push(current);
      continue;
    }
    if (current && line.startsWith('@@ ')) {
      const match = HUNK_HEADER_RE.exec(line);
      if (!match) continue;
      const oldStart = Number.parseInt(match[1] ?? '1', 10);
      const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
      const newStart = Number.parseInt(match[3] ?? '1', 10);
      const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;

      if (current.status === 'deleted') {
        const start = Math.max(1, oldStart);
        const end = Math.max(start, oldStart + Math.max(1, oldCount) - 1);
        current.hunks.push({ startLine: start, endLine: end });
      } else {
        const start = Math.max(1, newStart);
        const end = Math.max(start, newStart + Math.max(1, newCount) - 1);
        current.hunks.push({ startLine: start, endLine: end });
      }
    }
  }

  return results;
}

/**
 * Map a file's ordered declarations and diff hunk line spans to the symbols
 * whose declaration/body range intersects at least one hunk.
 */
export function matchSymbolsToDiffHunks<
  T extends { name: string; kind: string; line: number; endLine?: number | undefined },
>(symbols: readonly T[], hunks: readonly DiffHunkRange[]): T[] {
  if (symbols.length === 0) return [];
  if (hunks.length === 0) return symbols.slice(0, 6);

  const ordered = [...symbols].sort((a, b) => a.line - b.line);
  const matched: T[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < ordered.length; i++) {
    const sym = ordered[i] as T;
    const symStart = sym.line;
    const nextSym = ordered[i + 1];
    const symEnd =
      typeof sym.endLine === 'number' && sym.endLine >= symStart
        ? sym.endLine
        : nextSym
          ? Math.max(symStart, nextSym.line - 1)
          : Number.MAX_SAFE_INTEGER;

    const overlaps = hunks.some((hunk) => hunk.startLine <= symEnd && hunk.endLine >= symStart);
    if (overlaps && !seen.has(sym.name)) {
      seen.add(sym.name);
      matched.push(sym);
    }
  }

  // Fallback: if hunks hit top-of-file imports/constants above the first symbol,
  // include the file's primary declarations (bounded).
  if (matched.length === 0) {
    for (const sym of ordered.slice(0, 4)) {
      if (!seen.has(sym.name)) {
        seen.add(sym.name);
        matched.push(sym);
      }
    }
  }

  return matched;
}

/**
 * Git on the repository under analysis, which nobody vouched for: its config
 * names programs (`core.fsmonitor`, `.gitattributes` filters) that `diff`
 * runs. Null when git fails, or when its isolation could not be set up.
 */
async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const isolation = await gitIsolationEnv(cwd);
  if (!isolation) return null;
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...isolation },
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * A revision or `a..b` / `a...b` range, nothing git could read as an option.
 * `baseRef` comes from the model: `--output=<path>` would turn this read-only
 * tool into a file writer (`git diff --output`).
 */
const REVISION_RE = /^[A-Za-z0-9_./~^@{}:+-]+$/;

function isSafeRevisionRange(baseRef: string): boolean {
  const sides = baseRef.split(/\.{2,3}/);
  return (
    sides.length <= 2 &&
    sides.every((side, i) =>
      side === '' ? i > 0 || sides.length === 2 : REVISION_RE.test(side),
    ) &&
    sides.every((side) => !side.startsWith('-'))
  );
}

function extractBaseCommitRef(baseRef: string): string {
  const tripleIdx = baseRef.indexOf('...');
  if (tripleIdx > 0) return baseRef.slice(0, tripleIdx);
  const doubleIdx = baseRef.indexOf('..');
  if (doubleIdx > 0) return baseRef.slice(0, doubleIdx);
  return baseRef;
}

const MAX_ANALYZED_SYMBOLS = 25;

export const codebaseDiffImpactTool: Tool<CodebaseDiffImpactInput, CodebaseDiffImpactOutput> = {
  name: 'codebase-diff-impact',
  category: 'Project',
  icon: 'index',
  permission: 'auto',
  mutating: false,
  capabilities: ['fs.read'],
  timeoutMs: 35_000,
  description:
    'Analyze the blast radius of current git changes (working tree, staged diff, or commit/branch range). ' +
    'Maps modified diff hunks to affected symbols, finds all direct and transitive callers across the codebase, ' +
    'checks AST contract invariants (INV-001..004) against the base revision, and identifies impacted test suites.',
  usageHint:
    'CALL BEFORE COMMITTING OR OPENING A PR TO VERIFY BLAST RADIUS:\n\n' +
    '- Call `codebase-diff-impact({})` to inspect working tree + staged changes against HEAD.\n' +
    '- Pass `staged: true` to inspect only staged changes, or `baseRef: "main..HEAD"` for branch diffs.\n' +
    '- Reports modified symbols, contract-breaking invariant violations, affected production callers, and exact test files to run.',
  inputSchema: {
    type: 'object',
    properties: {
      baseRef: {
        type: 'string',
        description:
          'Optional git ref or revision range (e.g. "HEAD", "HEAD~1", "main..HEAD"). Defaults to "HEAD".',
      },
      staged: {
        type: 'boolean',
        description: 'When true, analyze only staged changes (`git diff --cached`).',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of project-relative file paths to scope the diff.',
      },
      transitive: {
        type: 'boolean',
        description:
          'Whether to include transitive callers (callers of callers). Defaults to true.',
      },
      persist: {
        type: 'boolean',
        description:
          'When true, persist `.wrongstack/atlas/diff-overlay.json` for visual CodeMap overlay.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const projectRoot = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    const indexDir = codebaseIndexDirOverride(ctx);
    const transitive = input?.transitive ?? true;
    const baseRef = input?.baseRef?.trim() || 'HEAD';
    const staged = input?.staged === true;
    const pathFilter = (input?.files ?? []).filter(
      (f) => typeof f === 'string' && f.trim().length > 0,
    );

    if (!isSafeRevisionRange(baseRef)) {
      throw new ToolValidationError({
        message: `Invalid baseRef "${baseRef}". Expected a git revision or range such as HEAD, HEAD~1 or main..HEAD.`,
        field: 'baseRef',
      });
    }

    // Fixed prefixes: `diff.noprefix` / `diff.mnemonicPrefix` config would
    // otherwise decide how the header paths read.
    const DIFF_BASE = ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv'];
    const PREFIXES = ['--src-prefix=a/', '--dst-prefix=b/'];
    const diffArgs = [...DIFF_BASE, ...PREFIXES];
    if (staged) diffArgs.push('--cached');
    // --end-of-options right before the revision: it is read as a revision,
    // never as a git option (options after the marker are revisions too).
    if (!staged || baseRef !== 'HEAD') diffArgs.push('--end-of-options', baseRef);
    if (pathFilter.length > 0) {
      diffArgs.push('--', ...pathFilter);
    }

    let diffText = await runGit(projectRoot, diffArgs);
    if (diffText === null && baseRef === 'HEAD' && !staged) {
      // Fallback for fresh repos with no HEAD commit yet
      const fallbackArgs = [...DIFF_BASE, ...PREFIXES];
      if (pathFilter.length > 0) fallbackArgs.push('--', ...pathFilter);
      diffText = await runGit(projectRoot, fallbackArgs);
    }

    const parsedFiles = parseUnifiedDiff(diffText ?? '');
    if (parsedFiles.length === 0) {
      return {
        status: 'ok',
        baseRef,
        riskLevel: 'low',
        summary: `No git diff changes detected against '${baseRef}'${staged ? ' (staged)' : ''}.`,
        changedFiles: [],
        affectedSymbols: [],
        totalCallSites: 0,
        affectedProductionFiles: [],
        affectedTestFiles: [],
        invariantViolations: [],
        callSites: [],
        recommendedActionPlan: ['No modified files or symbols found in the requested diff.'],
      };
    }

    const hasIndex = existsSync(path.join(resolveIndexDir(projectRoot, indexDir), 'index.db'));
    const store = hasIndex ? indexStorePool.acquire(projectRoot, { indexDir }) : null;

    const changedFiles: DiffChangedFileReport[] = [];
    const allViolations: Array<InvariantViolation & { file: string }> = [];
    const candidateSymbols: Array<{ name: string; kind: string; file: string; line: number }> = [];
    const seenSymbolKeys = new Set<string>();
    const baseCommit = extractBaseCommitRef(baseRef);

    const prodFilesSet = new Set<string>();
    const testFilesSet = new Set<string>();
    const directProdFilesSet = new Set<string>();
    const callSites: ImpactCallSite[] = [];
    const seenCallSiteKeys = new Set<string>();
    const affectedSymbols: DiffAffectedSymbol[] = [];

    // Any test files directly modified in the diff should also be in affectedTestFiles
    for (const df of parsedFiles) {
      if (isTestFilePath(df.file)) testFilesSet.add(df.file);
    }

    try {
      for (const diffFile of parsedFiles) {
        const absPath = path.resolve(projectRoot, diffFile.file);
        let fileSymbols = store ? store.getFileSymbols(absPath, 500) : [];
        if (store && fileSymbols.length === 0) {
          fileSymbols = store.getFileSymbols(posixIndexPath(absPath), 500);
        }
        const matched = matchSymbolsToDiffHunks(fileSymbols, diffFile.hunks);

        // Evaluate polyglot AST contract invariants when the file was modified
        const fileViolations: InvariantViolation[] = [];
        let changeKind: StructuralChangeKind = 'STRUCTURAL';
        if (diffFile.status === 'modified') {
          const [oldSource, newSource] = await Promise.all([
            runGit(projectRoot, [
              'show',
              '--no-textconv',
              '--end-of-options',
              `${baseCommit}:${diffFile.file}`,
            ]),
            fs.readFile(absPath, 'utf8').catch(() => null),
          ]);
          if (oldSource !== null && newSource !== null) {
            const evalResult = await polyglotInvariantEngine.evaluate({
              originalCode: oldSource,
              modifiedCode: newSource,
              filePath: diffFile.file,
            });
            fileViolations.push(...evalResult.violations);
            for (const v of evalResult.violations) {
              allViolations.push({ ...v, file: diffFile.file });
            }
            if (evalResult.violations.length === 0 && matched.length === 0) {
              changeKind = 'COSMETIC';
            }
          }
        }

        changedFiles.push({
          file: diffFile.file,
          status: diffFile.status,
          changeKind,
          modifiedSymbols: matched.map((s) => s.name),
          invariantViolations: fileViolations,
        });

        if (isTestFilePath(diffFile.file)) continue;

        for (const sym of matched) {
          const key = `${diffFile.file}::${sym.name}`;
          if (seenSymbolKeys.has(key)) continue;
          seenSymbolKeys.add(key);
          if (candidateSymbols.length < MAX_ANALYZED_SYMBOLS) {
            candidateSymbols.push({
              name: sym.name,
              kind: sym.kind,
              file: diffFile.file,
              line: sym.line,
            });
          }
        }
      }

      if (store) {
        for (const sym of candidateSymbols) {
          const serviced = transitive
            ? store.findTransitiveIncomingCallsByName(sym.name, sym.file, 100)
            : store.findIncomingCallsByName(sym.name, sym.file, 100);
          let directCount = 0;
          let transitiveCount = 0;
          for (const site of serviced.calls) {
            const relPath = path.relative(projectRoot, site.symbol.file).replace(/\\/g, '/');
            const isTest = isTestFilePath(relPath);
            const indirect = !site.callType;
            if (indirect) transitiveCount++;
            else directCount++;

            if (isTest) {
              testFilesSet.add(relPath);
            } else {
              prodFilesSet.add(relPath);
              if (!indirect) directProdFilesSet.add(relPath);
            }

            const siteKey = `${relPath}:${site.line}:${site.symbol.name}:${site.callType}`;
            if (!seenCallSiteKeys.has(siteKey)) {
              seenCallSiteKeys.add(siteKey);
              callSites.push({
                file: relPath,
                line: site.line,
                callerName: site.symbol.name,
                callerKind: site.symbol.kind,
                callType: site.callType,
                isTest,
                ...(indirect ? { indirect: true } : {}),
              });
            }
          }
          affectedSymbols.push({
            name: sym.name,
            kind: sym.kind,
            file: sym.file,
            line: sym.line,
            directCallers: directCount,
            transitiveCallers: transitiveCount,
          });
        }
      }
    } finally {
      if (store) indexStorePool.release(store);
    }

    for (const convTest of discoverConventionTestFiles(projectRoot, [
      ...changedFiles.map((f) => f.file),
      ...directProdFilesSet,
    ])) {
      testFilesSet.add(convTest);
    }

    const prodFiles = [...prodFilesSet].sort();
    const testFiles = [...testFilesSet].sort();
    const directProdFiles = [...directProdFilesSet].sort();
    const totalCallSites = callSites.filter((s) => !s.indirect).length;

    let riskLevel: 'low' | 'medium' | 'high' = 'low';
    if (
      allViolations.some((v) => v.severity === 'CRITICAL') ||
      directProdFiles.length > 5 ||
      totalCallSites > 10
    ) {
      riskLevel = 'high';
    } else if (
      allViolations.length > 0 ||
      directProdFiles.length > 1 ||
      totalCallSites > 3 ||
      prodFiles.length > 5
    ) {
      riskLevel = 'medium';
    }

    const recommendedActionPlan: string[] = [];
    if (allViolations.length > 0) {
      recommendedActionPlan.push(
        `Review ${allViolations.length} AST contract violation(s): ${allViolations
          .slice(0, 3)
          .map((v) => `[${v.ruleId}] ${v.file}: ${v.message}`)
          .join('; ')}`,
      );
    }
    if (directProdFiles.length > 0) {
      recommendedActionPlan.push(
        `Verify ${totalCallSites} direct call site(s) across ${directProdFiles.length} production file(s): ${directProdFiles.slice(0, 4).join(', ')}${directProdFiles.length > 4 ? ` +${directProdFiles.length - 4} more` : ''}`,
      );
    }
    if (testFiles.length > 0) {
      recommendedActionPlan.push(
        `Run impacted test suite(s) (${testFiles.length}): ${testFiles.slice(0, 5).join(', ')}${testFiles.length > 5 ? ` +${testFiles.length - 5} more` : ''}`,
      );
    } else if (changedFiles.some((f) => !isTestFilePath(f.file))) {
      recommendedActionPlan.push(
        'No existing test suites reference the modified symbols. Consider adding regression tests.',
      );
    }

    const relatedMemories = findAnchoredSageMemories({
      projectRoot,
      files: changedFiles.map((f) => f.file),
      symbols: affectedSymbols.map((s) => s.name),
      limit: 5,
    });
    if (relatedMemories.length > 0) {
      recommendedActionPlan.push(
        `Check ${relatedMemories.length} anchored SAGE memory insight(s): ${relatedMemories
          .map((m) => `[${m.kind}] ${m.text}`)
          .slice(0, 2)
          .join(' | ')}`,
      );
    }

    const fileHealthAlerts = findFileHealthAlerts(projectRoot, [
      ...changedFiles.map((f) => f.file),
      ...directProdFiles.slice(0, 10),
    ]);
    if (fileHealthAlerts.some((h) => h.isFragile)) {
      if (riskLevel === 'low') riskLevel = 'medium';
      recommendedActionPlan.push(
        `Caution: ${fileHealthAlerts.filter((h) => h.isFragile).length} touched/affected file(s) are flagged FRAGILE by WrongTrace`,
      );
    }

    const summary =
      `Diff Impact (${baseRef}${staged ? ', staged' : ''}): ${riskLevel.toUpperCase()} RISK — ` +
      `${changedFiles.length} changed file(s), ${affectedSymbols.length} modified symbol(s), ` +
      `${totalCallSites} direct call site(s) in ${directProdFiles.length} prod file(s), ` +
      `${testFiles.length} affected test suite(s), ${allViolations.length} invariant violation(s).`;

    const output: CodebaseDiffImpactOutput = {
      status: 'ok',
      baseRef,
      riskLevel,
      summary,
      changedFiles,
      affectedSymbols,
      totalCallSites,
      affectedProductionFiles: prodFiles,
      affectedTestFiles: testFiles,
      invariantViolations: allViolations,
      callSites,
      recommendedActionPlan,
      ...(relatedMemories.length > 0 ? { relatedMemories } : {}),
      ...(fileHealthAlerts.length > 0 ? { fileHealthAlerts } : {}),
    };
    if (input?.persist === true) {
      const persisted = await writeDiffImpactOverlay(projectRoot, output);
      output.persistedOverlayPath = persisted.path;
    }
    return output;
  },
};
