/**
 * Chimera finding disk-verification pass (P0-2).
 *
 * A review finding is only as good as its citation. Before a finding is
 * persisted and before it can gate a cascade, the execution owner runs this
 * deterministic pass against the actual working tree:
 *
 *   1. the cited file must exist inside the workspace;
 *   2. the cited line must be in range for that file;
 *   3. a code anchor extracted from the finding's title/description must
 *      appear at or near the cited line.
 *
 * This is deliberately NOT semantic verification — it does not judge whether
 * the claim is correct, only whether the citation is real. It catches the
 * gross phantom-finding classes cheaply: files that do not exist, line
 * numbers past EOF, and lines that have nothing to do with the claim.
 *
 * @module review-finding-verification
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ChimeraFinding } from './review-finding-types.js';

export interface VerifyFindingsOptions {
  /** Workspace root the reviewer cited against. */
  cwd: string;
  /**
   * Lines around the cited line to search for the code anchor.
   * Default 2 (i.e. the cited line plus 2 above and 2 below).
   */
  anchorWindow?: number | undefined;
}

const DEFAULT_ANCHOR_WINDOW = 2;

/** English stopwords + finding-prose generics never treated as code anchors. */
const STOPWORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'before',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'each',
  'few',
  'for',
  'from',
  'further',
  'get',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'may',
  'me',
  'might',
  'more',
  'most',
  'much',
  'must',
  'my',
  'new',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'out',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  // Finding-prose generics: common English nouns that are terrible anchors
  // because they match prose everywhere. Kept deliberately small.
  'area',
  'bug',
  'check',
  'code',
  'data',
  'endpoint',
  'error',
  'file',
  'fix',
  'issue',
  'line',
  'make',
  'may',
  'potential',
  'request',
  'response',
  'result',
  'use',
  'used',
  'user',
  'using',
  'value',
]);

/**
 * Extract all candidate code identifiers from finding text, prioritizing:
 *   1. Identifiers inside backticks (explicit code mentions: `foo.bar()`, `varName`)
 *   2. Code-like identifiers (camelCase, snake_case, $-suffixed)
 *   3. Other meaningful non-stopword tokens (>= 3 chars)
 */
export function extractFindingAnchors(
  title: string,
  description: string,
  suggestedFix?: string,
): string[] {
  const fullText = `${title ?? ''} ${description ?? ''} ${suggestedFix ?? ''}`;
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (token: string): void => {
    const trimmed = token.trim();
    if (trimmed.length >= 3 && !STOPWORDS.has(trimmed.toLowerCase()) && !seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push(trimmed);
    }
  };

  // 1. Backticked code tokens: `foo.bar` or `myFunc()`
  const backtickMatches = fullText.match(/`([^`]+)`/g) ?? [];
  for (const match of backtickMatches) {
    const inner = match.slice(1, -1).trim();
    const innerTokens = inner.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    for (const t of innerTokens) add(t);
  }

  // 2. Code-like tokens: camelCase (lower followed by upper), snake_case, or $ suffix.
  const tokens = fullText.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const meaningful = tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  const codeLike = meaningful.filter(
    (t) => /[a-z][A-Z]/.test(t) || t.includes('_') || t.endsWith('$'),
  );
  codeLike.sort((a, b) => b.length - a.length);
  for (const t of codeLike) add(t);

  // If we found any explicit backticked or code-like identifiers, return those!
  if (candidates.length > 0) {
    return candidates;
  }

  // Fallback only when NO code-like identifiers exist: longest meaningful tokens
  const remaining = [...meaningful].sort((a, b) => b.length - a.length);
  for (const t of remaining) add(t);

  return candidates;
}

/**
 * Extract the most distinctive code identifier from a finding's
 * title + description. Prefers camelCase / snake_case / `$`-suffixed
 * identifiers (code-like), then falls back to the first non-stopword
 * token of length >= 3. Exported for unit tests.
 */
export function extractFindingAnchor(title: string, description: string): string | undefined {
  const anchors = extractFindingAnchors(title, description);
  return anchors[0];
}

/**
 * Resolve a finding's cited path against the workspace, normalizing
 * backslashes, leading `./`, absolute POSIX paths, and (on win32) absolute
 * Windows paths. Returns the absolute path when the citation resolves
 * INSIDE the workspace, or `null` when it escapes it. Exported for tests.
 */
export function resolveFindingPath(raw: string, cwd: string): string | null {
  const pathMod = process.platform === 'win32' ? path.win32 : path;
  const forward = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const isAbsolute = pathMod.isAbsolute(forward) || /^[a-zA-Z]:\//.test(forward);
  const relative = isAbsolute ? pathMod.relative(cwd, forward).replace(/\\/g, '/') : forward;
  // Reject traversal: `../` escaping the workspace must never resolve.
  if (relative === '..' || relative.startsWith('../') || pathMod.isAbsolute(relative)) return null;
  const resolved = pathMod.resolve(cwd, relative);
  const rel = pathMod.relative(cwd, resolved);
  if (rel === '..' || rel.startsWith('..') || pathMod.isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Verify findings against the working tree. Each finding that carries a
 * `location` gets a `verification` result attached; findings without a
 * location are left untouched (there is nothing to verify). Files are read
 * once per unique path. Never throws — read failures degrade to a
 * `failed`/`unverified` verdict so one unreadable file cannot abort the
 * whole review pipeline.
 */
export async function verifyFindingsAgainstDisk(
  findings: ChimeraFinding[],
  opts: VerifyFindingsOptions,
): Promise<ChimeraFinding[]> {
  const window = opts.anchorWindow ?? DEFAULT_ANCHOR_WINDOW;
  const cache = new Map<string, { lines: string[] } | { error: 'missing' | 'unreadable' }>();

  const readFile = async (
    abs: string,
  ): Promise<{ lines: string[] } | { error: 'missing' | 'unreadable' }> => {
    const cached = cache.get(abs);
    if (cached) return cached;
    let result: { lines: string[] } | { error: 'missing' | 'unreadable' };
    try {
      const content = await fsp.readFile(abs, 'utf8');
      result = { lines: content.split('\n') };
    } catch (err) {
      result = {
        error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      };
    }
    cache.set(abs, result);
    return result;
  };

  return Promise.all(
    findings.map(async (finding): Promise<ChimeraFinding> => {
      if (!finding.location?.file) return finding;

      const abs = resolveFindingPath(finding.location.file, opts.cwd);
      if (abs === null) {
        return { ...finding, verification: { status: 'failed', reason: 'outside_workspace' } };
      }

      const file = await readFile(abs);
      if ('error' in file) {
        return {
          ...finding,
          verification: {
            status: 'failed',
            reason: file.error === 'missing' ? 'file_missing' : 'unreadable',
          },
        };
      }

      const anchors = extractFindingAnchors(
        finding.title,
        finding.description,
        finding.suggestedFix,
      );

      // No line: search the whole file for code-like anchors (weak signal, only
      // meaningful for distinctive anchors); otherwise stay unverified.
      if (finding.location.line === undefined) {
        for (const a of anchors) {
          if (/[a-z][A-Z]/.test(a) || a.includes('_')) {
            const hit = file.lines.findIndex((l) => l.includes(a));
            if (hit !== -1) {
              return {
                ...finding,
                verification: {
                  status: 'verified',
                  reason: 'anchor_found',
                  evidence: trimEvidence(file.lines[hit] ?? ''),
                },
              };
            }
          }
        }
        return { ...finding, verification: { status: 'unverified', reason: 'no_line' } };
      }

      const line = finding.location.line;
      if (line < 1 || line > file.lines.length) {
        return { ...finding, verification: { status: 'failed', reason: 'line_out_of_range' } };
      }

      if (anchors.length === 0) {
        return { ...finding, verification: { status: 'unverified', reason: 'no_anchor' } };
      }

      const from = Math.max(0, line - 1 - window);
      const to = Math.min(file.lines.length, line - 1 + window + 1);

      // Check all candidate anchors against the window lines
      for (const a of anchors) {
        for (let i = from; i < to; i++) {
          const sourceLine = file.lines[i]!;
          if (sourceLine.includes(a)) {
            return {
              ...finding,
              verification: {
                status: 'verified',
                reason: 'anchor_found',
                evidence: trimEvidence(sourceLine),
              },
            };
          }
        }
      }

      return { ...finding, verification: { status: 'unverified', reason: 'anchor_not_found' } };
    }),
  );
}

function trimEvidence(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}
