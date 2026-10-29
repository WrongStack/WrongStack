/**
 * Before-content of the files an editing Code Assist run writes, so the panel can review and
 * restore every file the run changed, not only the one it was opened on.
 *
 * The executor emits `tool.started` synchronously right before running a tool, so reading the
 * target here (synchronously) sees the file as it was before that tool. Only `write` and `edit`
 * name their single target in `path`; other tools that can change files (shell, replace, patch,
 * formatters, …) are listed as uncaptured instead of being guessed at.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { isPathInside } from './path-containment.js';

const CAPTURED_TOOLS = new Set(['write', 'edit']);
/** Tools that can change project files without naming one target this module can read first. */
const UNCAPTURED_TOOLS = new Set([
  'bash',
  'exec',
  'pwsh',
  'replace',
  'patch',
  'format',
  'lint',
  'git',
  'install',
  'design',
  'image_generate',
  'project_kit',
]);
const MAX_FILES = 50;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export interface CapturedEdit {
  /** Project-relative POSIX path. */
  path: string;
  /** Text before the run's first write; null when the file did not exist. */
  before: string | null;
}

export function createEditCapture(projectRoot: string) {
  const edits = new Map<string, CapturedEdit>();
  const uncaptured: string[] = [];
  let total = 0;
  const skip = (entry: string) => {
    if (!uncaptured.includes(entry)) uncaptured.push(entry);
  };
  return {
    /** Feed every `tool.started` event of the run. */
    onToolStarted(event: { name?: unknown; input?: unknown }) {
      const name = typeof event.name === 'string' ? event.name : '';
      if (UNCAPTURED_TOOLS.has(name)) return skip(name);
      if (!CAPTURED_TOOLS.has(name)) return;
      const raw = (event.input as { path?: unknown } | undefined)?.path;
      if (typeof raw !== 'string' || !raw.trim()) return skip(name);
      const absolute = path.resolve(projectRoot, raw);
      if (!isPathInside(projectRoot, absolute)) return skip(`${raw} (${name})`);
      const relative = path.relative(projectRoot, absolute).split(path.sep).join('/');
      if (edits.has(relative)) return;
      if (edits.size >= MAX_FILES) return skip(`${relative} (file limit)`);
      let before: string | null;
      try {
        const bytes = readFileSync(absolute);
        if (bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TOTAL_BYTES)
          return skip(`${relative} (too large)`);
        before = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        total += bytes.length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') before = null;
        else return skip(`${relative} (not readable text)`);
      }
      edits.set(relative, { path: relative, before });
    },
    result() {
      return { edits: [...edits.values()], uncaptured: [...uncaptured] };
    },
  };
}
