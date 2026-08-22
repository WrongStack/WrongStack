import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core/types';
import {
  atomicWrite,
  detectNewlineStyle,
  normalizeToLf,
  toStyle,
  unifiedDiff,
} from '@wrongstack/core/utils';
import { ToolValidationError } from '@wrongstack/core/types';
import {
  adjustIndent,
  findLadderMatches,
  firstLineIndent,
  type MatchTier,
  nearestMatchHint,
  TIER_CONFIDENCE,
  TIER_LABEL,
} from './_edit-match.js';
import { checkSyntax } from './_syntax-check.js';
import { safeResolveReal, sha256hex, truncateDiffPayload } from './_util.js';
import { enqueueReindex } from './codebase-index/background-indexer.js';

/** Byte budget for the returned unified diff — matches `maxOutputBytes`. */
const MAX_DIFF_BYTES = 262_144;

interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  /**
   * When true, replaces all occurrences of `old_string`.
   * When false (default), replaces only the first occurrence and errors
   * if more than one match exists — use this to ensure you target the
   * right location.
   */
  replace_all?: boolean | undefined;
}

interface EditOutput {
  path: string;
  replacements: number;
  diff: string;
  /**
   * How `old_string` was located. Anything other than 'exact' means a
   * whitespace/fuzzy fallback fired — the note carries the confidence level
   * and the diff shows exactly what was replaced.
   */
  matched_by: MatchTier;
  /**
   * Parse errors found in the file AFTER the edit was applied (TS/JS/JSON
   * only). The edit is still on disk — fix these in a follow-up edit now,
   * before doing anything else.
   */
  syntax_errors?: string[] | undefined;
  note?: string | undefined;
}

export const editTool: Tool<EditInput, EditOutput> = {
  name: 'edit',
  category: 'Filesystem',
  description:
    'Perform a precise, surgical text replacement in a file. This is the preferred tool for modifying existing code. ' +
    'It works best after a prior `read`, but can auto-read the current file when the replacement is still unambiguous. ' +
    'Fails safely if the `old_string` appears more than once unless `replace_all` is set.',
  usageHint:
    'RECOMMENDED WORKFLOW:\n' +
    '1. Prefer calling `read` on the target file first when planning an edit.\n' +
    '2. Use a sufficiently unique `old_string` (include surrounding lines/context if needed).\n' +
    '3. If the string appears multiple times and you want to change all of them, set `replace_all: true`.\n' +
    '4. `new_string` must be the exact replacement text.\n\n' +
    'If no prior read is recorded, the tool auto-reads the current file and only applies the edit after the same ambiguity checks pass.\n' +
    'If `old_string` differs from the file only in whitespace (trailing spaces, indentation), a lower-confidence fallback match is applied and reported in `matched_by`/`note` — always verify the diff when this happens.\n' +
    'After the edit, TS/JS/JSON files are syntax-checked; if `syntax_errors` is present in the output, fix those errors immediately with a follow-up edit.',
  selection: {
    doNotUseWhen:
      'creating a new file, replacing the whole file, or applying an existing unified diff.',
    useInstead: ['write', 'patch'],
  },
  permission: 'confirm',
  // WS-046: gives permission decisions something to key on — the file being
  // edited, so trust rules can scope by path.
  subjectKey: 'path',
  mutating: true,
  capabilities: ['fs.write'],
  icon: 'edit',
  timeoutMs: 5_000,
  maxOutputBytes: 262_144,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Path to the file to edit — relative to the project root, or absolute inside it.',
      },
      old_string: {
        type: 'string',
        description:
          'The exact text to replace, including whitespace and indentation. Must be unique in the file unless `replace_all` is set — add surrounding lines to disambiguate.',
      },
      new_string: {
        type: 'string',
        description: 'The exact replacement text (may be empty to delete `old_string`).',
      },
      replace_all: {
        type: 'boolean',
        description:
          'Replace every occurrence instead of requiring a unique match. Only allowed when `old_string` matches exactly (or up to trailing whitespace) — fuzzy matches stay single-target.',
      },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(input, ctx, opts) {
    if (!input?.path) {
      throw new ToolValidationError({ message: 'edit: path is required', field: 'path' });
    }
    if (input.old_string === undefined) {
      throw new ToolValidationError({
        message: 'edit: old_string is required',
        field: 'old_string',
      });
    }
    if (input.new_string === undefined) {
      throw new ToolValidationError({
        message: 'edit: new_string is required',
        field: 'new_string',
      });
    }
    if (input.old_string === '') {
      throw new ToolValidationError({
        message: 'edit: old_string cannot be empty',
        field: 'old_string',
      });
    }

    const absPath = await safeResolveReal(input.path, ctx);
    const stat = await fs.stat(absPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ToolValidationError({
          message: `edit: file "${input.path}" does not exist. Use \`write\` instead.`,
          field: 'path',
          context: { exists: false },
        });
      }
      throw err;
    });
    if (!stat.isFile()) {
      throw new ToolValidationError({
        message: `edit: "${input.path}" is not a regular file`,
        field: 'path',
      });
    }

    const autoRead = !ctx.hasRead(absPath);
    // Read BEFORE mtime check to eliminate TOCTOU window.
    // The sequence must be: read content → check mtime → apply edit.
    // If we check mtime first, a concurrent modification between the
    // stat call and the read gives us stale content to search/replace.
    const original = await fs.readFile(absPath, 'utf8');
    const updated = await fs.stat(absPath);
    const mtimeTolerance = process.platform === 'win32' ? 2000 : 1;
    const originalHash = sha256hex(original);
    // Optional call: embedders and older test fixtures may hand in a
    // duck-typed Context without hash tracking — they fall back to mtime.
    const lastReadHash = ctx.lastReadHash?.(absPath);
    if (lastReadHash !== undefined) {
      // Content hash is the authoritative arbiter when available: it closes
      // the mtime tolerance window (an external write within 2 s of the read
      // on Windows is invisible to mtime) and ignores content-preserving
      // mtime bumps (touch, checkout of identical content).
      if (lastReadHash !== originalHash) {
        throw new ToolValidationError({
          message: `edit: file "${input.path}" was modified externally. Re-read it first.`,
          field: 'path',
          context: { reason: 'external_modification' },
        });
      }
    } else {
      const lastReadMtime = ctx.lastReadMtime(absPath);
      if (lastReadMtime !== undefined && updated.mtimeMs > lastReadMtime + mtimeTolerance) {
        throw new ToolValidationError({
          message: `edit: file "${input.path}" was modified externally. Re-read it first.`,
          field: 'path',
          context: { reason: 'external_modification' },
        });
      }
    }
    if (autoRead && updated.mtimeMs > stat.mtimeMs + mtimeTolerance) {
      throw new ToolValidationError({
        message: `edit: file "${input.path}" changed while being auto-read. Retry the edit.`,
        field: 'path',
        context: { reason: 'auto_read_race' },
      });
    }
    const autoReadNote = autoRead
      ? `No prior read was recorded for "${input.path}"; edit auto-read the current file and applied the replacement only after the ambiguity checks passed.`
      : undefined;
    const style = detectNewlineStyle(original);
    const fileLf = normalizeToLf(original);
    const oldLf = normalizeToLf(input.old_string);
    const newLf = normalizeToLf(input.new_string);

    if (oldLf === newLf) {
      // Only report a benign no-op when the text actually occurs in the file.
      // Otherwise this is a wrong-target call (the model thinks the text is
      // there but it is not) — surface the normal no-match error so the model
      // can tell "already applied" apart from "wrong file/wrong text".
      if (!fileLf.includes(oldLf)) {
        throw noMatchError(input.path, fileLf, oldLf);
      }
      if (autoRead) ctx.recordRead(absPath, updated.mtimeMs, 'user', originalHash);
      return {
        path: absPath,
        replacements: 0,
        diff: '(no-op: old and new are identical)',
        matched_by: 'exact',
        note: autoReadNote,
      };
    }

    // Check abort signal before entering potentially slow matching logic
    opts?.signal?.throwIfAborted();
    const ladder = findLadderMatches(fileLf, oldLf);

    if (!ladder) {
      opts?.signal?.throwIfAborted();
      throw noMatchError(input.path, fileLf, oldLf);
    }

    const { tier, matches } = ladder;
    const count = matches.length;

    if (ladder.ambiguous) {
      const lines = matches.map((m) => m.startLine);
      throw new ToolValidationError({
        message:
          `edit: old_string only matched fuzzily and ${count} candidate blocks scored too close ` +
          `to distinguish (lines: ${lines.join(', ')}) in "${input.path}". ` +
          `Re-read the file and use the exact text of the intended block.`,
        field: 'old_string',
        context: { occurrences: count, matchTier: tier },
      });
    }

    // Fuzzy/indent-insensitive matches are single-target operations: applying
    // them in bulk multiplies a low-confidence guess. replace_all therefore
    // requires at least a trailing-whitespace-level match.
    if (input.replace_all && tier !== 'exact' && tier !== 'trailing-whitespace') {
      throw new ToolValidationError({
        message:
          `edit: old_string only matched via ${TIER_LABEL[tier]} in "${input.path}", ` +
          `but replace_all requires an exact (or trailing-whitespace) match. ` +
          `Re-read the file and use its exact text.`,
        field: 'old_string',
        context: { matchTier: tier },
      });
    }

    if (count > 1 && !input.replace_all) {
      const lines = matches.map((m) => m.startLine);
      throw new ToolValidationError({
        message:
          `edit: old_string matched ${count} times in "${input.path}" (lines: ${lines.join(', ')})` +
          `${tier === 'exact' ? '' : ` via ${TIER_LABEL[tier]}`}. ` +
          `Add more context to make it unique, or set replace_all: true.`,
        field: 'old_string',
        context: { occurrences: count, matchTier: tier },
      });
    }

    let newFileLf: string;
    let tierNote: string | undefined;
    if (tier === 'exact') {
      newFileLf = input.replace_all
        ? fileLf.split(oldLf).join(newLf)
        : fileLf.replace(oldLf, newLf);
    } else {
      // Fallback tiers matched whole-line windows — splice by char offsets,
      // right to left so earlier offsets stay valid. For indent-insensitive
      // tiers, shift the replacement to the file's actual indentation.
      let replacement = newLf;
      let indentSuffix = '';
      if (tier === 'whitespace-normalized' || tier === 'fuzzy') {
        const first = matches[0] as (typeof matches)[number];
        const matchedText = fileLf.slice(first.start, first.end);
        const adjusted = adjustIndent(newLf, firstLineIndent(oldLf), firstLineIndent(matchedText));
        replacement = adjusted.text;
        if (adjusted.adjusted) indentSuffix = '; replacement re-indented to match the file';
      }
      newFileLf = fileLf;
      const applied = input.replace_all ? matches : matches.slice(0, 1);
      for (let i = applied.length - 1; i >= 0; i--) {
        const m = applied[i] as (typeof matches)[number];
        newFileLf = newFileLf.slice(0, m.start) + replacement + newFileLf.slice(m.end);
      }
      const scoreSuffix =
        ladder.score !== undefined ? `, similarity ${(ladder.score * 100).toFixed(1)}%` : '';
      tierNote =
        `old_string did not match exactly; applied via ${TIER_LABEL[tier]} at line ` +
        `${(matches[0] as (typeof matches)[number]).startLine} ` +
        `(confidence: ${TIER_CONFIDENCE[tier]}${scoreSuffix}${indentSuffix}). ` +
        `Review the diff to confirm the intended target was edited.`;
    }
    const newFile = toStyle(newFileLf, style);

    // Last exit before mutating the filesystem: a run aborted during the
    // read/match phase must not leave the edit behind. (atomicWrite itself
    // is all-or-nothing — the file is old or new, never partial.)
    opts?.signal?.throwIfAborted();
    await atomicWrite(absPath, newFile, { mode: updated.mode & 0o777 });

    try {
      enqueueReindex({ projectRoot: ctx.projectRoot, files: [absPath] });
    } catch {
      // Non-fatal background reindex
    }

    const written = await fs.stat(absPath);
    // Record mtime + content hash so a later edit detects external
    // modification, but tag as 'write' so the permission policy's
    // write-smart-bypass does NOT treat this as "user already saw the
    // content" (P1 #1).
    ctx.recordRead(absPath, written.mtimeMs, 'write', sha256hex(newFile));

    // Record for session rewind
    ctx.session?.recordFileChange?.({
      path: absPath,
      action: 'modified',
      before: original,
      after: newFile,
    });

    // Check abort before diff generation (can be slow on large files)
    opts?.signal?.throwIfAborted();
    const { text: diff, truncated: diffTruncated } = truncateDiffPayload(
      unifiedDiff(original, newFile, {
        fromFile: input.path,
        toFile: input.path,
      }),
      MAX_DIFF_BYTES,
    );
    const diffNote = diffTruncated
      ? 'Diff truncated to the 256 KiB output budget — the full edit is on disk.'
      : undefined;

    // Post-edit syntax validation (TS/JS/JSON). The edit stays on disk —
    // errors come back in the same turn so the model fixes them immediately.
    const syntax = await checkSyntax(absPath, newFile, original).catch(() => undefined);
    let syntaxNote: string | undefined;
    if (syntax && syntax.errors.length > 0) {
      syntaxNote = syntax.preExisting
        ? `Syntax check: the file still has parse errors (they pre-date this edit) — see syntax_errors.`
        : `Syntax check: this edit introduced ${syntax.errors.length} parse error(s) — fix them now, see syntax_errors.`;
    }

    const notes = [autoReadNote, tierNote, diffNote, syntaxNote].filter(Boolean);

    return {
      path: absPath,
      replacements: input.replace_all ? count : 1,
      diff,
      matched_by: tier,
      syntax_errors: syntax && syntax.errors.length > 0 ? syntax.errors : undefined,
      note: notes.length > 0 ? notes.join('\n') : undefined,
    };
  },
};

/**
 * The canonical "old_string not found" error, shared by the ladder-miss path
 * and the old===new short-circuit (which must not report a benign no-op when
 * the text is simply absent).
 */
function noMatchError(inputPath: string, fileLf: string, oldLf: string): ToolValidationError {
  const hint = nearestMatchHint(fileLf, oldLf);
  return new ToolValidationError({
    message: `edit: no match for old_string in "${inputPath}".${
      hint
        ? ` Nearest match near line ${hint.line}:\n${hint.snippet}\n` +
          `Compare this against your old_string and retry with the file's actual text.`
        : ''
    }`,
    field: 'old_string',
  });
}
