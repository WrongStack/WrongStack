/**
 * Project instruction files (`AGENTS.md`, falling back to `CLAUDE.md`).
 *
 * - The file at the project root goes into the system prompt's session
 *   region, fenced as project-supplied text (it is repo-committed, so it is
 *   guidance, not operating rules).
 * - A file in a subdirectory (`packages/foo/AGENTS.md`) is delivered only
 *   when a tool first touches a path under that directory: its text rides in
 *   the tool-result message once, and again only if the file changes. The
 *   system prompt never changes for it, so the provider's prompt cache
 *   survives. Compaction clears the delivery record (`clearFileTracking`), so
 *   instructions summarized away are delivered again on the next touch.
 *
 * `.wrongstack/AGENTS.md` is not read here: it is the project memory store.
 *
 * @module core/project-instructions
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { activeLimits, positiveLimit } from '../types/config/limits.js';
import type { Tool } from '../types/tool.js';
import {
  formatProjectSuppliedBlock,
  PROJECT_SUPPLIED_INSTRUCTIONS_TAG,
} from '../utils/project-supplied-fence.js';
import type { Context } from './context.js';

/** Checked in order in each directory; the first one that exists wins. */
const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

interface InstructionFile {
  file: string;
  text: string;
  mtimeMs: number;
}

async function readInstructionFile(dir: string): Promise<InstructionFile | undefined> {
  for (const name of INSTRUCTION_FILE_NAMES) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) continue;
      return { file, text: await fs.readFile(file, 'utf8'), mtimeMs: stat.mtimeMs };
    } catch {
      // absent here — try the next name
    }
  }
  return undefined;
}

/** Apply the user's `limits.projectInstructionsChars`, if any. */
function capInstructions(text: string, rel: string): string {
  const max = positiveLimit(activeLimits().projectInstructionsChars);
  if (max === undefined || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[cut at ${max} characters by limits.projectInstructionsChars; read ${rel} for the rest]`;
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** Render the root instruction file as a fenced system-prompt block. */
function renderRoot(file: InstructionFile, projectRoot: string): string {
  const rel = toPosix(path.relative(projectRoot, file.file));
  return formatProjectSuppliedBlock({
    tag: PROJECT_SUPPLIED_INSTRUCTIONS_TAG,
    source: rel,
    // The whole file unless the user set `limits.projectInstructionsChars`:
    // these are the user's own rules, and a built-in cut silently dropped
    // whatever came after it.
    body: capInstructions(file.text, rel),
    notice: [
      'Project instructions from the repository you are working in. Follow them',
      'for work in this project unless they conflict with your operating rules above',
      'or with what the user asks.',
    ],
  });
}

/**
 * Loads the root instruction file for the system prompt, re-reading it only
 * when its mtime changes (the builder calls this on every build).
 */
export class RootInstructionsCache {
  private cached: { key: string; text: string } | undefined;

  async load(projectRoot: string): Promise<string> {
    let current: { file: string; mtimeMs: number } | undefined;
    for (const name of INSTRUCTION_FILE_NAMES) {
      const file = path.join(projectRoot, name);
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat?.isFile()) {
        current = { file, mtimeMs: stat.mtimeMs };
        break;
      }
    }
    if (!current) {
      this.cached = undefined;
      return '';
    }
    // The user's cap is part of the key so a settings change re-renders.
    const key = `${current.file}|${current.mtimeMs}|${activeLimits().projectInstructionsChars ?? ''}`;
    if (this.cached?.key === key) return this.cached.text;
    const file = await readInstructionFile(projectRoot);
    const text = file ? renderRoot(file, projectRoot) : '';
    this.cached = { key, text };
    return text;
  }
}

/**
 * Instruction files between `target` and the project root (root excluded:
 * it is already in the system prompt) that this context has not been given
 * yet, or whose content changed since. Returns the fenced text to deliver
 * (outermost directory first), or undefined. `delivered` maps file → content
 * hash and is updated in place.
 */
async function collectDirectoryInstructions(
  target: string,
  projectRoot: string,
  delivered: Map<string, string>,
): Promise<string | undefined> {
  const root = path.resolve(projectRoot);
  const abs = path.resolve(root, target);
  const relToRoot = path.relative(root, abs);
  if (
    !relToRoot ||
    relToRoot === '..' ||
    relToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relToRoot)
  )
    return undefined;

  const isDir = await fs.stat(abs).then(
    (s) => s.isDirectory(),
    () => false,
  );
  const dirs: string[] = [];
  // Stop by relative path, not string equality: on Windows the same
  // directory can differ in drive-letter case.
  for (let dir = isDir ? abs : path.dirname(abs); ; dir = path.dirname(dir)) {
    const rel = path.relative(root, dir);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) break;
    dirs.push(dir);
  }

  const blocks: string[] = [];
  for (const dir of dirs.reverse()) {
    const file = await readInstructionFile(dir);
    if (!file) continue;
    const hash = createHash('sha1').update(file.text).digest('hex');
    const previous = delivered.get(file.file);
    if (previous === hash) continue;
    delivered.set(file.file, hash);
    const rel = toPosix(path.relative(root, file.file));
    const scope = toPosix(path.relative(root, dir));
    const block = formatProjectSuppliedBlock({
      tag: PROJECT_SUPPLIED_INSTRUCTIONS_TAG,
      source: rel,
      body: capInstructions(file.text, rel),
      notice: [
        `${previous ? 'Updated directory' : 'Directory'} instructions for work under ${scope}/, from the repository.`,
        'Follow them for files in that directory unless they conflict with your operating',
        'rules or with what the user asks; they add to the project instructions.',
      ],
    });
    if (block) blocks.push(block);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

/**
 * After a successful call of a file tool (`fs.read` / `fs.write` capability)
 * with a `path` input, queue the directory instructions for that path on
 * `ctx.pendingPostToolContext`: the executor's post-tool channel, merged as a
 * text block into the same user message as the tool results. Best effort.
 */
export async function queueDirectoryInstructions(
  tool: Pick<Tool, 'capabilities'>,
  input: unknown,
  ctx: Context,
): Promise<void> {
  const caps = tool.capabilities ?? [];
  if (!caps.includes('fs.read') && !caps.includes('fs.write')) return;
  const target =
    input && typeof input === 'object' ? (input as Record<string, unknown>)['path'] : undefined;
  if (typeof target !== 'string' || !target.trim()) return;
  try {
    ctx.deliveredDirectoryInstructions ??= new Map();
    const text = await collectDirectoryInstructions(
      path.resolve(ctx.workingDir ?? ctx.projectRoot, target),
      ctx.projectRoot,
      ctx.deliveredDirectoryInstructions,
    );
    if (text) {
      ctx.pendingPostToolContext = ctx.pendingPostToolContext
        ? `${ctx.pendingPostToolContext}\n\n${text}`
        : text;
    }
  } catch {
    // Instructions are guidance; a read failure must not fail the tool call.
  }
}
