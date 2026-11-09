/**
 * Subagent lifecycle subscriptions for AgentStatusTracker. Split out of
 * agent-status-tracker.ts; the tracker owns the agent map and flush.
 */
import type { AgentEntry } from '@wrongstack/core/session-catalog';
import {
  addToolActivity,
  boundedText,
  type CompletedToolPayload,
  clampPct,
  completedToolReceipt,
  type PendingTool,
} from './agent-status-helpers.js';

/** Max chars of streamed assistant text kept in the registry (the live tail). */
export const PARTIAL_TEXT_CAP = 1200;
/** Completed receipts retained per agent for cross-process Office history. */
export const RECENT_TOOL_LIMIT = 12;
/** Registry snapshots must stay small even when a task or prompt is huge. */
export const TASK_TEXT_CAP = 1200;

export interface SubagentStatusHost {
  readonly agents: Map<string, AgentEntry>;
  readonly subagentPendingTools: Map<string, PendingTool>;
  flush(): void;
}

type OnPattern = (pattern: string, fn: (event: string, payload: unknown) => void) => () => void;

/**
 * Subscribe to the real fleet lifecycle events (emitted by MultiAgentHost /
 * the subagent runner / director) and mirror them into `host.agents`.
 * Returns the unsubscribers.
 */
export function subscribeSubagentStatus(
  host: SubagentStatusHost,
  on: OnPattern,
): Array<() => void> {
  const unsubscribers: Array<() => void> = [];
  const touch = (id: string): AgentEntry => {
    let entry = host.agents.get(id);
    if (!entry) {
      const now = new Date().toISOString();
      entry = {
        id,
        name: id,
        status: 'idle',
        iterations: 0,
        toolCalls: 0,
        startedAt: now,
        lastActivityAt: now,
      };
      host.agents.set(id, entry);
    }
    entry.lastActivityAt = new Date().toISOString();
    return entry;
  };

  unsubscribers.push(
    on('subagent.spawned', (_e, payload) => {
      const p = payload as
        | {
            subagentId?: string;
            name?: string;
            model?: string;
            provider?: string;
            taskId?: string;
            description?: string;
          }
        | undefined;
      if (!p?.subagentId) return;
      const entry = touch(p.subagentId);
      entry.name = p.name?.trim() || entry.name;
      if (p.model) entry.model = p.model;
      if (p.provider) entry.provider = p.provider;
      if (p.taskId) entry.taskId = p.taskId;
      if (p.description?.trim()) entry.currentTask = boundedText(p.description, TASK_TEXT_CAP);
      /* v8 ignore next -- touch() always sets startedAt on creation */
      if (!entry.startedAt) entry.startedAt = new Date().toISOString();
      entry.status = 'running';
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.ctx_pct', (_e, payload) => {
      const p = payload as { subagentId?: string; load?: number } | undefined;
      if (!p?.subagentId) return;
      const entry = touch(p.subagentId);
      if (typeof p.load === 'number') entry.ctxPct = clampPct(Math.round(p.load * 100));
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.task_started', (_e, payload) => {
      const p = payload as
        | { subagentId?: string; taskId?: string; description?: string }
        | undefined;
      if (!p?.subagentId) return;
      const entry = touch(p.subagentId);
      entry.status = 'running';
      if (p.taskId) entry.taskId = p.taskId;
      if (p.description?.trim()) entry.currentTask = boundedText(p.description, TASK_TEXT_CAP);
      /* v8 ignore next -- touch() always sets startedAt on creation */
      if (!entry.startedAt) entry.startedAt = new Date().toISOString();
      entry.iterations++;
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.tool_started', (_e, payload) => {
      const p = payload as
        | { subagentId?: string; id?: string; name?: string; input?: unknown }
        | undefined;
      if (!p?.subagentId || !p.name) return;
      const entry = touch(p.subagentId);
      entry.status = 'running';
      entry.currentTool = p.name;
      host.subagentPendingTools.set(`${p.subagentId}:${p.id ?? p.name}`, {
        name: p.name,
        input: p.input,
        startedAt: Date.now(),
      });
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.tool_executed', (_e, payload) => {
      const p = payload as (CompletedToolPayload & { subagentId?: string }) | undefined;
      if (!p?.subagentId || !p.name) return;
      const entry = touch(p.subagentId);
      entry.status = 'running';
      /* v8 ignore next -- touch() always sets startedAt on creation */
      if (!entry.startedAt) entry.startedAt = new Date().toISOString();
      const key = `${p.subagentId}:${p.id ?? p.name}`;
      const receipt = completedToolReceipt(p, host.subagentPendingTools.get(key));
      entry.recentTools = [receipt, ...(entry.recentTools ?? [])].slice(0, RECENT_TOOL_LIMIT);
      entry.activity = addToolActivity(entry.activity, receipt);
      host.subagentPendingTools.delete(key);
      entry.currentTool = undefined;
      entry.toolCalls++;
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.iteration_summary', (_e, payload) => {
      const p = payload as
        | {
            subagentId?: string;
            iteration?: number;
            toolCalls?: number;
            currentTool?: string;
            costUsd?: number;
            partialText?: string;
          }
        | undefined;
      if (!p?.subagentId) return;
      const entry = touch(p.subagentId);
      entry.status = 'running';
      /* v8 ignore next -- touch() always sets startedAt on creation */
      if (!entry.startedAt) entry.startedAt = new Date().toISOString();
      if (typeof p.iteration === 'number') entry.iterations = p.iteration;
      if (typeof p.toolCalls === 'number') entry.toolCalls = p.toolCalls;
      if (typeof p.costUsd === 'number') entry.costUsd = p.costUsd;
      if (p.currentTool) entry.currentTool = p.currentTool;
      // Live streamed tail of THIS subagent's current response (the runner
      // already accumulates it) — capped to the same budget as the leader.
      if (typeof p.partialText === 'string') {
        entry.partialText =
          p.partialText.length > PARTIAL_TEXT_CAP
            ? p.partialText.slice(p.partialText.length - PARTIAL_TEXT_CAP)
            : p.partialText;
      }
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.task_completed', (_e, payload) => {
      const p = payload as
        | { subagentId?: string; status?: string; iterations?: number; toolCalls?: number }
        | undefined;
      if (!p?.subagentId) return;
      // Only update an agent we already know — a completion for an unseen
      // agent isn't worth materialising.
      const entry = host.agents.get(p.subagentId);
      if (!entry) return;
      entry.status = p.status === 'failed' || p.status === 'timeout' ? 'error' : 'idle';
      entry.currentTool = undefined;
      entry.currentTask = undefined;
      entry.taskId = undefined;
      entry.partialText = undefined;
      if (typeof p.iterations === 'number') entry.iterations = p.iterations;
      if (typeof p.toolCalls === 'number') entry.toolCalls = p.toolCalls;
      entry.lastActivityAt = new Date().toISOString();
      host.flush();
    }),
  );

  unsubscribers.push(
    on('subagent.stopped', (_e, payload) => {
      const p = payload as { subagentId?: string } | undefined;
      if (!p?.subagentId) return;
      if (host.agents.delete(p.subagentId)) host.flush();
    }),
  );
  unsubscribers.push(
    on('subagent.removed', (_e, payload) => {
      const p = payload as { subagentId?: string } | undefined;
      if (!p?.subagentId) return;
      if (host.agents.delete(p.subagentId)) host.flush();
    }),
  );

  return unsubscribers;
}
