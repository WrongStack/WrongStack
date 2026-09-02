/**
 * After a successful rename-like tool, remap file/symbol anchors so memories
 * track code:
 * - bash/exec: `mv` / `git mv` / `Move-Item` → path remap
 * - `lsp_rename`: capture old identifier before apply, then symbol remap
 */

import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { Middleware } from '@wrongstack/core/kernel';
import type { MemoryPort } from '@wrongstack/core/types';
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

export interface SagePathRemapOptions {
  memory: MemoryPort;
  /** Max remaps per process hour. Default: 50. */
  maxPerHour?: number | undefined;
}

const recent = new Map<string, number>();
const HOUR_MS = 60 * 60_000;

function allow(key: string, max: number): boolean {
  const now = Date.now();
  for (const [k, t] of recent) {
    if (now - t > HOUR_MS) recent.delete(k);
  }
  if (recent.size >= max) return false;
  if (recent.has(key)) return false;
  recent.set(key, now);
  return true;
}

const COMMAND_TOOLS = new Set(['bash', 'exec', 'shell', 'run_terminal_command']);

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

        const name = nextPayload.toolUse.name;

        // ── Path remaps from shell renames ──────────────────────────
        if (COMMAND_TOOLS.has(name)) {
          const input = nextPayload.toolUse.input as Record<string, unknown> | undefined;
          const command = typeof input?.['command'] === 'string' ? input['command'] : '';
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
            if (from && to && from !== to && allow(`path:${from}->${to}`, maxPerHour)) {
              const active = await surface.listSage(['active']);
              for (const memory of active) {
                if (!memoryNeedsPathRemap(memory, from)) continue;
                const { anchors, changed } = remapAnchors(memory.anchors, from, to);
                if (changed) await surface.updateSage(memory.id, { anchors });
              }
            }
          }
        }

        // ── Symbol remaps from lsp_rename ───────────────────────────
        if (pendingSymbol) {
          const key = `sym:${pendingSymbol.path}#${pendingSymbol.oldSymbol}->${pendingSymbol.newSymbol}`;
          if (allow(key, maxPerHour)) {
            const active = await surface.listSage(['active']);
            for (const memory of active) {
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
              // Also rewrite bare symbol occurrences in text when exact match.
              const text = memory.text.includes(pendingSymbol.oldSymbol)
                ? memory.text.split(pendingSymbol.oldSymbol).join(pendingSymbol.newSymbol)
                : memory.text;
              await surface.updateSage(memory.id, {
                anchors,
                ...(text !== memory.text ? { text } : {}),
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
