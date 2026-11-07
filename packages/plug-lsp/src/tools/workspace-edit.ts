import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import type { DocumentTracker } from '../document-tracker.js';
import { editsByPath } from '../formatters/workspace-edit.js';
import { LSPError, LSPErrorCode } from '../types.js';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface ApplyWorkspaceEditResult {
  files: string[];
  edits: number;
}

export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  tracker: DocumentTracker,
  projectRoot: string,
): Promise<ApplyWorkspaceEditResult> {
  const entries = editsByPath(edit);
  const targetsByKey = new Map<string, [string, TextEdit[]]>();
  for (const [file, edits] of entries) {
    // `editsByPath` keys custom-scheme targets (`jdt:`, `vscode-remote:`) by
    // their URI, which is not a writable filesystem path. Only `file:` targets
    // resolve to an absolute path, so skip anything else rather than failing
    // the whole edit on read.
    if (!path.isAbsolute(file)) continue;
    const resolved = path.resolve(file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const existing = targetsByKey.get(key);
    if (existing) {
      existing[1].push(...edits);
    } else {
      targetsByKey.set(key, [file, [...edits]]);
    }
  }
  const targets = [...targetsByKey.values()];

  // Reads may leave the project (definitions jump into dependencies), but
  // writes may not: the server-provided edit was written to any absolute
  // path it named. Refuse the whole edit before touching a single file.
  const outside = await filesOutsideRoot(
    targets.map(([file]) => file),
    projectRoot,
  );
  if (outside.length > 0) {
    throw new LSPError(
      LSPErrorCode.ApplyEditFailed,
      `Refusing to apply workspace edit outside the project root (${projectRoot}): ${outside.join(', ')}`,
    );
  }

  const ops: Array<{ path: string; original: string; next: string; edits: number }> = [];
  for (const [file, edits] of targets) {
    // Every file is rewritten whole from its decode: a legacy single-byte file
    // (ISO-8859-x, Windows-125x) would come back with U+FFFD for every
    // non-ASCII byte. Refuse the edit before any file is written.
    let original: string;
    try {
      original = strictUtf8.decode(await fs.readFile(file));
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      throw new LSPError(
        LSPErrorCode.ApplyEditFailed,
        `Refusing to apply workspace edit: ${file} is not UTF-8 text (a legacy single-byte encoding?)`,
      );
    }
    ops.push({ path: file, original, next: applyTextEdits(original, edits), edits: edits.length });
  }

  const written: typeof ops = [];
  try {
    for (const op of ops) {
      await atomicWrite(op.path, op.next);
      written.push(op);
    }
  } catch (err) {
    /* v8 ignore start -- atomicWrite failures are OS-dependent; read failures are covered separately. */
    for (const op of written) {
      try {
        await atomicWrite(op.path, op.original);
      } catch {
        // best-effort rollback
      }
    }
    throw new LSPError(LSPErrorCode.ApplyEditFailed, 'Failed to apply workspace edit', err);
    /* v8 ignore stop */
  }

  for (const op of ops) await tracker.fileWritten(op.path);
  return { files: ops.map((op) => op.path), edits: ops.reduce((sum, op) => sum + op.edits, 0) };
}

/** Targets whose lexical or real (symlink-resolved) path leaves `projectRoot`. */
async function filesOutsideRoot(files: readonly string[], projectRoot: string): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const realRoot = await fs.realpath(root).catch(() => root);
  const outside: string[] = [];
  for (const file of files) {
    const lexical = path.resolve(file);
    const real = await fs.realpath(lexical).catch(() => lexical);
    if (!isWithin(root, lexical) || !isWithin(realRoot, real)) outside.push(file);
  }
  return outside;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * One ascending pass over the original text. The stable sort keeps
 * same-position edits in array order, which LSP says is the order their text
 * appears in; applying from the end backwards reversed them.
 */
export function applyTextEdits(original: string, edits: TextEdit[]): string {
  const lineStarts = buildLineStarts(original);
  const ordered = edits
    .map((edit) => {
      const start = offsetOf(edit.range.start, original, lineStarts);
      const end = offsetOf(edit.range.end, original, lineStarts);
      if (end < start) {
        throw new LSPError(
          LSPErrorCode.ApplyEditFailed,
          'Refusing to apply workspace edit with inverted text edit range',
        );
      }
      return {
        newText: edit.newText,
        start,
        end,
      };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) {
      throw new LSPError(
        LSPErrorCode.ApplyEditFailed,
        'Refusing to apply workspace edit with overlapping text edit ranges',
      );
    }
    out += original.slice(cursor, edit.start) + edit.newText;
    cursor = edit.end;
  }
  return out + original.slice(cursor);
}

/**
 * Line starts under LSP's line-break rule: `\n`, `\r\n` AND a lone `\r` (the
 * same rule `splitLines` applies when positions are computed). Splitting on
 * `\n` alone made a CR-only file one line long, so every edit past line 0
 * clamped to end-of-document and was appended there instead.
 */
function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10 || (ch === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  return starts;
}

/**
 * LSP: a character past the line length "defaults back to the line length",
 * and a line past the end means the end of the document. Unclamped, an
 * over-long end ran through the newline and deleted the rest of the file.
 */
function offsetOf(
  pos: { line: number; character: number },
  text: string,
  lineStarts: number[],
): number {
  if (pos.line >= lineStarts.length) return text.length;
  const line = Math.max(0, pos.line);
  const lineStart = lineStarts[line]!;
  let lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : text.length;
  if (line + 1 < lineStarts.length && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
  return Math.min(lineStart + Math.max(0, pos.character), Math.max(lineStart, lineEnd));
}
