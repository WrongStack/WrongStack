import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';
import { displayPath, uriToPath } from '../utils/uri.js';

export function summarizeWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string {
  const entries = editsByPath(edit);
  if (entries.size === 0) return 'WorkspaceEdit contains no text edits.';
  let total = 0;
  const lines = ['Workspace edit:'];
  for (const [file, edits] of entries) {
    total += edits.length;
    lines.push(`  ${displayPath(file, cwd)} ${edits.length} edit(s)`);
  }
  lines.push(`Total: ${total} edits across ${entries.size} files.`);
  return lines.join('\n');
}

export function editsByPath(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    out.set(uriToPath(uri), edits);
  }
  for (const change of edit.documentChanges ?? []) {
    if ('textDocument' in change && Array.isArray(change.edits)) {
      out.set(
        uriToPath(change.textDocument.uri),
        change.edits.filter((e): e is TextEdit => 'newText' in e),
      );
    }
  }
  return out;
}
