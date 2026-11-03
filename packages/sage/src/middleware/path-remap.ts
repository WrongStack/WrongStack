/**
 * After a successful rename-like tool, remap file/symbol anchors so memories
 * track code:
 * - bash/exec: `mv` / `git mv` / `Move-Item` → path remap
 * - `lsp_rename`: capture old identifier before apply, then symbol remap
 *
 * Not in a linked Git worktree: it shares its main checkout's memory, but a
 * rename there exists only on that worktree's branch. Rewriting the shared
 * anchors would point every other checkout at a path it does not have, so the
 * main checkout would see the memory go stale for a change it never made.
 */

import * as path from 'node:path';
import type { Middleware } from '@wrongstack/contracts/kernel';
import type { MemoryPort } from '@wrongstack/contracts/types';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import { canonicalProjectRoot } from '@wrongstack/core/utils';
import { getSageSurface } from '../memory-port.js';
import {
  memoryNeedsPathRemap,
  memoryNeedsSymbolRemap,
  parseRenameCommand,
  readIdentifierAt,
  remapAnchors,
  remapSymbolAnchors,
  toProjectRelative,
} from '../shared/path-remap.js';
import { isVerificationStale } from '../shared/stale-reason.js';
import type { Sage } from '../types.js';

export interface SagePathRemapOptions {
  memory: MemoryPort;
  /** Max remaps per process hour. Default: 50. */
  maxPerHour?: number | undefined;
}

const recent: number[] = [];
const HOUR_MS = 60 * 60_000;

/**
 * Hourly rate cap on remap passes. Repeats of the same rename are NOT
 * rejected: a file moved a→b, back b→a, then a→b again must be followed
 * each time, and re-running an already-applied remap is a no-op anyway.
 */
function allow(_key: string, max: number): boolean {
  const now = Date.now();
  while (recent.length > 0 && now - recent[0]! > HOUR_MS) recent.shift();
  if (recent.length >= max) return false;
  recent.push(now);
  return true;
}

/**
 * Stale memories are remapped too. A rename is exactly what makes the next
 * verification mark a file-anchored memory stale ("Anchored path no longer
 * exists"), and nothing ever moves stale back to active — remapping only
 * active rows lost every memory whose file was verified between the move and
 * this hook, permanently.
 */
const REMAP_STATUSES: Sage['status'][] = ['active', 'stale'];

/**
 * A remapped memory that verification demoted points at live code again; the
 * next verification pass re-marks it if something else (content hash,
 * symbol) is broken. A manually retired memory keeps its status — its anchors
 * still follow the file.
 */
function reactivateIfStale(memory: Sage): { status?: 'active' } {
  return isVerificationStale(memory) ? { status: 'active' } : {};
}

/**
 * Replace `oldId` only where it stands as a whole identifier. The previous
 * `split/join` rewrote substrings of unrelated names: renaming `get` turned
 * `getUser` into `fetchUser` inside the memory text.
 */
export function replaceIdentifier(text: string, oldId: string, newId: string): string {
  if (!oldId || oldId === newId) return text;
  const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`, 'gu');
  // Function replacer: `newId` must never be read as a `$&`-style pattern.
  return text.replace(pattern, () => newId);
}

const COMMAND_TOOLS = new Set([
  'bash',
  'exec',
  'shell',
  'run_terminal_command',
  'run_command',
  'execute_command',
]);

/** A linked worktree's identity root is its main checkout, not itself. */
export function isLinkedWorktreeRoot(projectRoot: string): boolean {
  const own = path.resolve(projectRoot);
  const identity = canonicalProjectRoot(own);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? own.toLowerCase() !== identity.toLowerCase()
    : own !== identity;
}

export function createSagePathRemapMiddleware(
  opts: SagePathRemapOptions,
): Middleware<ToolCallPipelinePayload> {
  const maxPerHour = opts.maxPerHour ?? 50;
  return {
    name: 'sage.path-remap',
    owner: 'sage',
    async handler(payload, next) {
      // Capture old symbol *before* lsp_rename mutates the file.
      let pendingSymbol: { path: string; oldSymbol: string; newSymbol: string } | undefined;
      try {
        if (payload.toolUse.name === 'lsp_rename') {
          const input = payload.toolUse.input as Record<string, unknown> | undefined;
          const filePath = typeof input?.['path'] === 'string' ? input['path'] : '';
          const newName = typeof input?.['new_name'] === 'string' ? input['new_name'] : '';
          const line = typeof input?.['line'] === 'number' ? input['line'] : 0;
          const character = typeof input?.['character'] === 'number' ? input['character'] : 0;
          if (filePath && newName && line > 0) {
            const abs = path.isAbsolute(filePath)
              ? filePath
              : path.resolve(payload.ctx.cwd, filePath);
            const oldSymbol = readIdentifierAt(abs, line, character);
            if (oldSymbol && oldSymbol !== newName) {
              pendingSymbol = {
                path: toProjectRelative(payload.ctx.projectRoot, payload.ctx.cwd, filePath),
                oldSymbol,
                newSymbol: newName,
              };
            }
          }
        }
      } catch {
        // ignore pre-capture errors
      }

      const nextPayload = await next(payload);
      try {
        if (nextPayload.result.is_error) return nextPayload;
        const surface = getSageSurface(opts.memory);
        if (!surface?.listSage || !surface.updateSage) return nextPayload;
        // Checked only when a remap would run: it reads the checkout's `.git`.
        let linked: boolean | undefined;
        const inLinkedWorktree = () => {
          linked ??= isLinkedWorktreeRoot(nextPayload.ctx.projectRoot);
          return linked;
        };

        const name = nextPayload.toolUse.name;

        // ── Path remaps from shell renames ──────────────────────────
        if (COMMAND_TOOLS.has(name)) {
          const input = nextPayload.toolUse.input as Record<string, unknown> | undefined;
          const command =
            typeof input?.['command'] === 'string'
              ? input['command']
              : typeof input?.['CommandLine'] === 'string'
                ? input['CommandLine']
                : typeof input?.['cmd'] === 'string'
                  ? input['cmd']
                  : '';
          const parsed = command ? parseRenameCommand(command) : undefined;
          if (parsed) {
            const from = toProjectRelative(
              nextPayload.ctx.projectRoot,
              nextPayload.ctx.cwd,
              parsed.from,
            );
            const to = toProjectRelative(
              nextPayload.ctx.projectRoot,
              nextPayload.ctx.cwd,
              parsed.to,
            );
            if (
              from &&
              to &&
              from !== to &&
              !inLinkedWorktree() &&
              allow(`path:${from}->${to}`, maxPerHour)
            ) {
              const candidates = await surface.listSage(REMAP_STATUSES);
              for (const memory of candidates) {
                if (!memoryNeedsPathRemap(memory, from)) continue;
                const { anchors, changed } = remapAnchors(memory.anchors, from, to);
                if (changed) {
                  await surface.updateSage(memory.id, { anchors, ...reactivateIfStale(memory) });
                }
              }
            }
          }
        }

        // ── Symbol remaps from lsp_rename ───────────────────────────
        if (pendingSymbol && !inLinkedWorktree()) {
          const key = `sym:${pendingSymbol.path}#${pendingSymbol.oldSymbol}->${pendingSymbol.newSymbol}`;
          if (allow(key, maxPerHour)) {
            const candidates = await surface.listSage(REMAP_STATUSES);
            for (const memory of candidates) {
              if (
                !memoryNeedsSymbolRemap(memory, {
                  oldSymbol: pendingSymbol.oldSymbol,
                  path: pendingSymbol.path,
                })
              ) {
                continue;
              }
              const { anchors, changed } = remapSymbolAnchors(memory.anchors, {
                oldSymbol: pendingSymbol.oldSymbol,
                newSymbol: pendingSymbol.newSymbol,
                path: pendingSymbol.path,
              });
              if (!changed) continue;
              // Also rewrite whole-identifier occurrences in the text.
              const text = replaceIdentifier(
                memory.text,
                pendingSymbol.oldSymbol,
                pendingSymbol.newSymbol,
              );
              await surface.updateSage(memory.id, {
                anchors,
                ...(text !== memory.text ? { text } : {}),
                ...reactivateIfStale(memory),
              });
            }
          }
        }
      } catch {
        // Fail-open
      }
      return nextPayload;
    },
  };
}
