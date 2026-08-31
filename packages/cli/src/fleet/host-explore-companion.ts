/**
 * Host wiring for the ExploreCompanion — the state-triggered background
 * codebase explorer behind the leader agent.
 *
 * Mirrors `host-supervisor.ts`: a thin builder that wires the core
 * `ExploreCompanion` observer (coordination/explore-companion.ts) to the
 * director, the project mailbox, and the host session. Built in
 * `buildDirector()`, stopped in `dispose()`.
 *
 * Resident model: one `explore-companion` subagent is spawned lazily on the
 * FIRST probe (never eagerly — an idle session pays nothing) and holds a
 * stable subagent id so subsequent probes reuse it. When the resident is
 * gone (removed/reaped/never spawned), the next probe spawns a fresh one.
 * Probes are `assignInternal`ed, never awaited — the leader is never
 * blocked, and internal tasks stay out of the leader-visible task surface
 * (same treatment as shadow passes). When the resident `submit_result`s,
 * this host posts a same-session `session.note` so the leader folds the
 * findings at its next iteration. Mailbox stays the durable cross-session
 * channel; it is not the in-session talk path.
 *
 * @module host-explore-companion
 */

import { randomUUID } from 'node:crypto';
import {
  buildProbeTaskText,
  DEFAULT_EXPLORE_COMPANION_AGENT_ID,
  type Director,
  ExploreCompanion,
  type ExploreCompanionOptions,
  formatSubagentStructuredReport,
  getSharedProjectMailbox,
  mailboxSessionTag,
  postSessionNote,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { SubagentConfig, TaskResult } from '@wrongstack/core/types';

/** Config block for the explore-companion host wiring (FleetConfig.exploreCompanion). */
interface HostExploreCompanionConfig {
  /** Kill switch. Default true. */
  enabled?: boolean | undefined;
  /** Min gap between probes on the same subject (ms). Default 120_000. */
  cooldownMs?: number | undefined;
  /** Pending probe queue cap. Default 8. */
  maxPending?: number | undefined;
  /** Mailbox poll interval for explicit asks (ms). Default 5_000. */
  pollIntervalMs?: number | undefined;
}

interface HostExploreCompanionInput {
  director: Director;
  events: EventBus;
  sessionId: string;
  mailboxProjectDir: string;
  roster: Record<string, SubagentConfig>;
  config?: HostExploreCompanionConfig | undefined;
  subagentsAllowed?: (() => boolean) | undefined;
}

export function createHostExploreCompanion(
  input: HostExploreCompanionInput,
): ExploreCompanion | null {
  const { director, events, sessionId, mailboxProjectDir, roster, config } = input;
  if (config?.enabled === false) return null;

  const sessionTag = mailboxSessionTag(sessionId);
  const mailbox = () => getSharedProjectMailbox(mailboxProjectDir, events);
  const template = roster[DEFAULT_EXPLORE_COMPANION_AGENT_ID];

  let residentId: string | undefined;

  /** Spawn (or reuse) the resident companion and return its subagent id. */
  const ensureResident = async (): Promise<string> => {
    if (input.subagentsAllowed?.() === false) {
      throw new Error('Subagents are disabled for this session.');
    }
    if (residentId) {
      const alive = director.status().subagents.some((s) => s.id === residentId);
      if (alive) return residentId;
      residentId = undefined;
    }
    if (!template) throw new Error('explore-companion role missing from roster');
    const subagentId = await director.spawn({
      ...template,
      id: `explore-companion-${sessionTag}`,
      name: 'Explore Companion',
      // The resident belongs to the conversation it explores for. Without the
      // stamp the coordinator files it under the host's own session, and every
      // WebUI tab but the first would see its companion's activity in tab 1.
      originSessionId: sessionId,
    });
    residentId = subagentId;
    return subagentId;
  };

  const options: ExploreCompanionOptions = {
    events,
    mailbox: mailbox(),
    leaderSessionId: sessionId,
    leaderAgentId: 'leader',
    onProbe: async (probe) => {
      const subagentId = await ensureResident();
      const taskId = randomUUID();
      await director.assignInternal({
        id: taskId,
        description: buildProbeTaskText(probe),
        subagentId,
      });
      return { subagentId, taskId };
    },
    cooldownMs: config?.cooldownMs,
    maxPending: config?.maxPending,
    pollIntervalMs: config?.pollIntervalMs,
    companionAgentId: `${DEFAULT_EXPLORE_COMPANION_AGENT_ID}@${sessionTag}`,
  };

  const companion = new ExploreCompanion(options);
  const offCompleted = director.on('task.completed', ({ result }) => {
    if (result.subagentId !== residentId) return;
    forwardExploreFindings({
      result,
      from: options.companionAgentId ?? `${DEFAULT_EXPLORE_COMPANION_AGENT_ID}@${sessionTag}`,
      sessionId,
      events,
    });
  });
  const stopWatching = companion.stop.bind(companion);
  Object.assign(companion, {
    stop(): void {
      offCompleted();
      stopWatching();
    },
  });
  companion.start();
  return companion;
}

function forwardExploreFindings(input: {
  result: TaskResult;
  from: string;
  sessionId: string;
  events: EventBus;
}): void {
  const { result, from, sessionId, events } = input;
  const raw = result.report
    ? formatSubagentStructuredReport(result.report)
    : typeof result.result === 'string'
      ? result.result
      : undefined;
  if (!raw?.trim()) return;
  try {
    postSessionNote({
      sessionId,
      from,
      to: 'leader',
      kind: 'result',
      subject: '[explore]',
      body: raw,
      events,
    });
  } catch {
    // Forwarding must never disturb the leader or the resident.
  }
}
