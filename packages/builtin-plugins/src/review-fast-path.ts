import * as path from 'node:path';
import { HUNK_HEADER_RE } from './review-diff.js';
import type { ReviewContextBundle } from './review-types.js';

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
