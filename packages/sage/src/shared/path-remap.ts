/**
 * Remap file/directory/symbol anchors when a project path or symbol is renamed.
 * Used by rename-aware middleware so memories stay bound to live code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryAnchor, Sage } from '../types.js';

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

/**
 * Rewrite anchors that point at `fromPath` (exact file) or live under it
 * (directory prefix). Symbol anchors update their path component only.
 */
export function remapAnchors(
  anchors: readonly MemoryAnchor[],
  fromPath: string,
  toPath: string,
): { anchors: MemoryAnchor[]; changed: boolean } {
  const from = normalizeRelPath(fromPath);
  const to = normalizeRelPath(toPath);
  if (!from || !to || from === to) return { anchors: [...anchors], changed: false };

  let changed = false;
  const next = anchors.map((anchor) => {
    if (!anchor.path) return anchor;
    const p = normalizeRelPath(anchor.path);
    if (p === from) {
      changed = true;
      return { ...anchor, path: to };
    }
    // Directory move: `src/old/...` → `src/new/...`
    if (p.startsWith(`${from}/`)) {
      changed = true;
      return { ...anchor, path: `${to}${p.slice(from.length)}` };
    }
    return anchor;
  });
  return { anchors: next, changed };
}

/**
 * Rename symbol anchors. When `path` is set, only anchors on that file path
 * are updated; otherwise every matching symbol name is rewritten.
 */
export function remapSymbolAnchors(
  anchors: readonly MemoryAnchor[],
  opts: { oldSymbol: string; newSymbol: string; path?: string | undefined },
): { anchors: MemoryAnchor[]; changed: boolean } {
  const oldSymbol = opts.oldSymbol.trim();
  const newSymbol = opts.newSymbol.trim();
  if (!oldSymbol || !newSymbol || oldSymbol === newSymbol) {
    return { anchors: [...anchors], changed: false };
  }
  const pathFilter = opts.path ? normalizeRelPath(opts.path) : undefined;
  let changed = false;
  const next = anchors.map((anchor) => {
    if (anchor.type !== 'symbol' || !anchor.symbol) return anchor;
    if (anchor.symbol !== oldSymbol) return anchor;
    if (pathFilter) {
      if (!anchor.path) return anchor;
      if (normalizeRelPath(anchor.path) !== pathFilter) return anchor;
    }
    changed = true;
    return { ...anchor, symbol: newSymbol };
  });
  return { anchors: next, changed };
}

export function memoryNeedsPathRemap(memory: Pick<Sage, 'anchors'>, fromPath: string): boolean {
  const from = normalizeRelPath(fromPath);
  if (!from) return false;
  return memory.anchors.some((a) => {
    if (!a.path) return false;
    const p = normalizeRelPath(a.path);
    return p === from || p.startsWith(`${from}/`);
  });
}

export function memoryNeedsSymbolRemap(
  memory: Pick<Sage, 'anchors'>,
  opts: { oldSymbol: string; path?: string | undefined },
): boolean {
  const oldSymbol = opts.oldSymbol.trim();
  if (!oldSymbol) return false;
  const pathFilter = opts.path ? normalizeRelPath(opts.path) : undefined;
  return memory.anchors.some((a) => {
    if (a.type !== 'symbol' || a.symbol !== oldSymbol) return false;
    if (!pathFilter) return true;
    return a.path ? normalizeRelPath(a.path) === pathFilter : false;
  });
}

/** Parse common rename command shapes: `mv a b`, `git mv a b`, `Move-Item a b`. */
export function parseRenameCommand(command: string): { from: string; to: string } | undefined {
  const c = command.replace(/\s+/g, ' ').trim();
  const token = '(?:"([^"]+)"|\'([^\']+)\'|([^\\s]+))';
  // git mv [-flags] <from> <to>
  let m = new RegExp(`(?:^|\\s)git\\s+mv\\s+(?:-[^\\s]+\\s+)*${token}\\s+${token}\\s*$`, 'i').exec(c);
  if (m) {
    const from = m[1] ?? m[2] ?? m[3];
    const to = m[4] ?? m[5] ?? m[6];
    if (from && to) return { from, to };
  }
  // mv [-flags] <from> <to>  (avoid multi-source forms)
  m = new RegExp(`(?:^|\\s)mv\\s+(?:-[^\\s]+\\s+)*${token}\\s+${token}\\s*$`, 'i').exec(c);
  if (m) {
    const from = m[1] ?? m[2] ?? m[3];
    const to = m[4] ?? m[5] ?? m[6];
    if (from && to) return { from, to };
  }
  // PowerShell Move-Item
  m = new RegExp(`Move-Item\\s+(?:-Path\\s+)?${token}\\s+(?:-Destination\\s+)?${token}`, 'i').exec(c);
  if (m) {
    const from = m[1] ?? m[2] ?? m[3];
    const to = m[4] ?? m[5] ?? m[6];
    if (from && to) return { from, to };
  }
  return undefined;
}

/**
 * Read the identifier at a 1-based human line/character position (matches
 * plug-lsp rename tool input). Used to capture the old symbol name *before*
 * `lsp_rename` mutates the file.
 */
export function readIdentifierAt(
  absolutePath: string,
  line: number,
  character: number,
): string | undefined {
  try {
    if (line < 1 || character < 1) return undefined;
    const text = fs.readFileSync(absolutePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const row = lines[line - 1];
    if (!row) return undefined;
    const col = character - 1;
    if (col > row.length) return undefined;
    // Expand to word characters (unicode letters/digits/_/$).
    let start = col;
    let end = col;
    const isId = (ch: string) => /[\p{L}\p{N}_$]/u.test(ch);
    if (!isId(row[col] ?? '')) {
      // Cursor may sit just after the identifier.
      if (col > 0 && isId(row[col - 1] ?? '')) start = col - 1;
      else return undefined;
    }
    while (start > 0 && isId(row[start - 1] ?? '')) start--;
    while (end < row.length && isId(row[end] ?? '')) end++;
    const id = row.slice(start, end);
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function toProjectRelative(projectRoot: string, cwd: string, inputPath: string): string {
  const abs = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return normalizeRelPath(inputPath);
  return normalizeRelPath(rel || '.');
}

