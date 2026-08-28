import * as fs from 'node:fs/promises';
import { atomicWrite } from '@wrongstack/core/utils';
import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import type { DocumentTracker } from '../document-tracker.js';
import { editsByPath } from '../formatters/workspace-edit.js';
import { LSPError, LSPErrorCode } from '../types.js';

interface ApplyWorkspaceEditResult {
  files: string[];
  edits: number;
}

export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  tracker: DocumentTracker,
): Promise<ApplyWorkspaceEditResult> {
  const entries = editsByPath(edit);
  const ops: Array<{ path: string; original: string; next: string; edits: number }> = [];
  for (const [file, edits] of entries) {
    const original = await fs.readFile(file, 'utf8');
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

export function applyTextEdits(original: string, edits: TextEdit[]): string {
  const lineStarts = buildLineStarts(original);
  const sorted = [...edits].sort(
    (a, b) => offsetOf(b.range.start, lineStarts) - offsetOf(a.range.start, lineStarts),
  );
  let out = original;
  for (const edit of sorted) {
    const start = offsetOf(edit.range.start, lineStarts);
    const end = offsetOf(edit.range.end, lineStarts);
    out = out.slice(0, start) + edit.newText + out.slice(end);
  }
  return out;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetOf(pos: { line: number; character: number }, lineStarts: number[]): number {
  return (lineStarts[pos.line] ?? lineStarts[lineStarts.length - 1]!) + pos.character;
}
