/**
 * Spawns the roster specialist a file-pattern trigger asked for.
 *
 * The detection half lives in core (`specialist-trigger-plugin.ts`) and knows
 * nothing about the fleet; this is the other side of that boundary, mirroring
 * how `chimera.review_needed` is handled. A host with no Director simply never
 * spawns, and the plugin keeps working as a pure detector.
 *
 * What it deliberately does not do: retry ladders, model pinning, cascades, or
 * report persistence. A specialist woken by a glob is a background opinion,
 * not a gate — if the model is down, the right outcome is one line in the
 * transcript saying so, not a chain of failovers spending more money on an
 * opinion nobody asked for.
 */

import { randomUUID } from 'node:crypto';
import type { Director } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SpecialistNeededPayload } from '@wrongstack/core/plugin';
import type { SessionWriter, StopReason } from '@wrongstack/core/types';

export interface InstallSpecialistTriggerHandlerOptions {
  events: EventBus;
  director: Director | null | undefined;
  session: SessionWriter;
  /** Session-scoped disposers, drained at session end. */
  teardownHandlers: Array<() => void>;
  /** Registers background work so the session waits for it before closing. */
  trackWork?: ((work: Promise<void>) => void) | undefined;
}

/** A woken specialist gets a bounded run: it is an opinion, not a project. */
const SPECIALIST_MAX_ITERATIONS = 30;
const SPECIALIST_MAX_TOOL_CALLS = 120;
const SPECIALIST_TIMEOUT_MS = 6 * 60 * 1000;

export function installSpecialistTriggerHandler({
  events,
  director,
  session,
  teardownHandlers,
  trackWork,
}: InstallSpecialistTriggerHandlerOptions): void {
  // Capture the disposer: an undisposed wildcard listener accumulates in
  // EventBus.wildcards until the process cap rejects new registrations.
  const off = events.onPattern(
    'fleet.specialist_needed',
    (_event, payload) => {
      const request = payload as SpecialistNeededPayload;
      const dir = director;
      if (!dir) return;
      if (!request?.role || !request.task) return;

      const work = (async () => {
        try {
          const subagentId = await dir.spawn({
            name: `trigger-${request.role}`,
            role: request.role,
            tier: request.tier,
            maxIterations: SPECIALIST_MAX_ITERATIONS,
            maxToolCalls: SPECIALIST_MAX_TOOL_CALLS,
            timeoutMs: SPECIALIST_TIMEOUT_MS,
            // Triggered specialists are background infrastructure, like
            // reviewers: they must not eat the leader's lifetime spawn budget,
            // which the user reserved for work they asked for.
            spawnBudgetExempt: true,
          });

          const taskId = await dir.assign({
            id: randomUUID(),
            description: request.task,
            subagentId,
            timeoutMs: SPECIALIST_TIMEOUT_MS,
          });
          const [result] = await dir.awaitTasks([taskId]);

          if (result?.status === 'success') {
            const text =
              typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            await session.append({
              type: 'llm_response',
              ts: new Date().toISOString(),
              content: [
                {
                  type: 'text',
                  text: `🔔 ${request.role} (triggered by ${request.paths.length} changed file(s)) — ${text}`,
                },
              ],
              stopReason: 'end_turn' as StopReason,
              usage: { input: 0, output: 0 },
            });
            return;
          }

          await session.append({
            type: 'error',
            ts: new Date().toISOString(),
            message: `🔔 ${request.role} trigger ${result?.status ?? 'unknown'}: ${
              result?.error?.message ?? 'no result'
            }`,
            phase: 'agent',
          });
        } catch (err) {
          // A background opinion must never take the session with it.
          try {
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🔔 ${request.role} trigger failed to run: ${
                err instanceof Error ? err.message : String(err)
              }`,
              phase: 'agent',
            });
          } catch {
            /* transcript unavailable — nothing further to do */
          }
        }
      })();

      trackWork?.(work);
    },
    'specialist-trigger',
  );
  // Session-scoped release: without it the wildcard listener accumulates
  // toward MAX_WILDCARDS for the life of the process.
  if (off) teardownHandlers.push(off);
}
