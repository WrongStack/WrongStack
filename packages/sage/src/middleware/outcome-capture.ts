/**
 * Opt-in capture of durable tool outcomes / error patterns into SAGE.
 *
 * Disabled unless `Sage.capture.toolOutcomes` or `Sage.capture.errorPatterns`
 * is true. Never auto-deletes; writes are add-only with modest importance so
 * hygiene/review remain in control.
 */

import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';
import type { Middleware } from '@wrongstack/core/kernel';
import type { MemoryPort } from '@wrongstack/core/types';
import { getSageSurface } from '../memory-port.js';

export interface SageOutcomeCaptureOptions {
  memory: MemoryPort;
  toolOutcomes?: boolean | undefined;
  errorPatterns?: boolean | undefined;
  /** Max captures per process hour (spam guard). Default: 20. */
  maxPerHour?: number | undefined;
}

const recentKeys = new Map<string, number>();
const HOUR_MS = 60 * 60_000;

function prune(now: number): void {
  for (const [k, t] of recentKeys) {
    if (now - t > HOUR_MS) recentKeys.delete(k);
  }
}

function allowKey(key: string, maxPerHour: number): boolean {
  const now = Date.now();
  prune(now);
  if (recentKeys.size >= maxPerHour) return false;
  if (recentKeys.has(key)) return false;
  recentKeys.set(key, now);
  return true;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * After tool execution, optionally remember successful command outcomes or
 * error signatures. Fail-open: never blocks the tool pipeline.
 */
export function createSageOutcomeCaptureMiddleware(
  opts: SageOutcomeCaptureOptions,
): Middleware<ToolCallPipelinePayload> {
  const maxPerHour = opts.maxPerHour ?? 20;
  return {
    name: 'sage.outcome-capture',
    owner: 'sage',
    async handler(payload, next) {
      const nextPayload = await next(payload);
      if (!opts.toolOutcomes && !opts.errorPatterns) return nextPayload;
      try {
        const surface = getSageSurface(opts.memory);
        if (!surface?.rememberSage) return nextPayload;

        const name = nextPayload.toolUse.name;
        const isError = nextPayload.result.is_error === true;
        const output = asString(nextPayload.result.content);
        const input = nextPayload.toolUse.input as Record<string, unknown> | undefined;
        const command =
          asString(input?.['command']) ||
          asString(input?.['CommandLine']) ||
          asString(input?.['cmd']) ||
          name;

        if (opts.errorPatterns && isError && output.trim()) {
          const signature = output.replace(/\s+/g, ' ').trim().slice(0, 200);
          const key = `err:${signature.slice(0, 80)}`;
          if (allowKey(key, maxPerHour)) {
            await surface.rememberSage({
              text: `Error pattern from ${name}: ${signature}`,
              kind: 'error_pattern',
              scope: 'project',
              importance: 0.55,
              confidence: 0.6,
              tags: ['auto-capture', 'error_pattern', name],
              anchors: command ? [{ type: 'command', command: String(command).slice(0, 200) }] : [],
              sources: [{ type: 'tool_result' }],
            });
          }
        }

        const commandTools = new Set([
          'bash',
          'exec',
          'shell',
          'run_terminal_command',
          'run_command',
          'execute_command',
        ]);
        if (opts.toolOutcomes && !isError && commandTools.has(name)) {
          const summary = output.replace(/\s+/g, ' ').trim().slice(0, 160);
          const key = `ok:${String(command).slice(0, 100)}`;
          if (allowKey(key, maxPerHour) && summary) {
            await surface.rememberSage({
              text: `Successful ${name}: \`${String(command).slice(0, 120)}\` → ${summary}`,
              kind: 'tool_outcome',
              scope: 'project',
              importance: 0.45,
              confidence: 0.7,
              tags: ['auto-capture', 'tool_outcome', name],
              anchors: [{ type: 'command', command: String(command).slice(0, 200) }],
              sources: [{ type: 'tool_result' }],
            });
          }
        }
      } catch {
        // Fail-open
      }
      return nextPayload;
    },
  };
}
