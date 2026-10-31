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
 * Probes are `assignInternal`ed off the leader's path; the observer waits
 * for completion before dispatching another. Internal tasks stay out of the task surface
 * (same treatment as shadow passes). When the resident `submit_result`s,
 * this host posts a same-session `session.note` so the leader folds the
 * findings at its next iteration. Mailbox stays the durable cross-session
 * channel; it is not the in-session talk path.
 *
 * @module host-explore-companion
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  FleetConfig,
  SubagentConfig,
  SubagentStructuredReport,
  TaskResult,
} from '@wrongstack/contracts/types';
import {
  applyRosterBudget,
  buildProbeTaskText,
  DEFAULT_EXPLORE_COMPANION_AGENT_ID,
  type Director,
  ExploreCompanion,
  type ExploreCompanionOptions,
  type ExploreProbe,
  getSharedProjectMailbox,
  mailboxSessionTag,
  postSessionNote,
} from '@wrongstack/coordination';

interface HostExploreCompanionInput {
  director: Director;
  events: EventBus;
  sessionId: string;
  mailboxProjectDir: string;
  roster: Record<string, SubagentConfig>;
  config?: FleetConfig['exploreCompanion'];
  companionsAllowed?: (() => boolean) | undefined;
  projectRoot?: string | undefined;
  scrub?: ((text: string) => string) | undefined;
}

interface ActiveProbe {
  probe: ExploreProbe;
  taskId: string;
  subagentId?: string;
  done: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

export function createHostExploreCompanion(
  input: HostExploreCompanionInput,
): ExploreCompanion | null {
  const { director, events, sessionId, mailboxProjectDir, roster, config } = input;
  if (config?.enabled === false) return null;

  const sessionTag = mailboxSessionTag(sessionId);
  const mailbox = () => getSharedProjectMailbox(mailboxProjectDir, events);
  const template = roster[DEFAULT_EXPLORE_COMPANION_AGENT_ID];
  const budget = template ? applyRosterBudget(template) : undefined;

  let residentId: string | undefined;
  let active: ActiveProbe | undefined;
  let stopped = false;
  let retiring: Promise<void> = Promise.resolve();
  const probeTimeoutMs = positive(
    config?.probeTimeoutMs,
    positive(template?.timeoutMs, 18_000_000),
  );
  const maxToolCalls = positive(
    config?.maxToolCallsPerProbe,
    positive(budget?.maxToolCalls, 300_000),
  );
  const maxIterations = positive(
    config?.maxToolCallsPerProbe,
    positive(budget?.maxIterations, 100_000),
  );
  // Lands in the leader's context: five cited one-liners and a next read.
  const maxFindingsChars = positive(config?.maxFindingsChars, 1_800);

  const retire = (id: string): void => {
    if (residentId === id) residentId = undefined;
    retiring = Promise.all([retiring, director.terminate(id).catch(() => {})]).then(() => {});
  };
  const settle = (job: ActiveProbe, terminate = false): void => {
    if (active !== job) return;
    active = undefined;
    clearTimeout(job.timer);
    if (terminate && job.subagentId) retire(job.subagentId);
    job.resolve();
  };

  /** Spawn (or reuse) the resident companion and return its subagent id. */
  const ensureResident = async (job: ActiveProbe): Promise<string> => {
    await retiring;
    if (stopped || active !== job || input.companionsAllowed?.() === false) {
      throw new Error('Subagent companions are disabled for this session.');
    }
    if (residentId) {
      const alive = director
        .status()
        .subagents.some(
          (s) => s.id === residentId && (s.status === 'idle' || s.status === 'running'),
        );
      if (alive) return residentId;
      retire(residentId);
      await retiring;
      if (stopped || active !== job)
        throw new Error('Explore Companion stopped during retirement.');
    }
    if (!template) throw new Error('explore-companion role missing from roster');
    const subagentId = await director.spawnCompanion({
      ...template,
      // Unique incarnation: late removal of an old resident cannot remove
      // its replacement, including after a registry eviction/recreation.
      id: `explore-companion-${sessionTag}-${randomUUID().slice(0, 8)}`,
      name: 'Explore Companion',
      // The resident belongs to the conversation it explores for. Without the
      // stamp the coordinator files it under the host's own session, and every
      // WebUI tab but the first would see its companion's activity in tab 1.
      originSessionId: sessionId,
      gracefulFinish: false,
      sealed: true,
      spawnBudgetExempt: true,
      timeoutMs: probeTimeoutMs,
      maxToolCalls,
      maxIterations,
    });
    if (stopped || active !== job || input.companionsAllowed?.() === false) {
      retire(subagentId);
      throw new Error('Explore Companion stopped during spawn.');
    }
    residentId = subagentId;
    return subagentId;
  };

  const options: ExploreCompanionOptions = {
    events,
    mailbox: mailbox(),
    leaderSessionId: sessionId,
    leaderAgentId: 'leader',
    onProbe: async (probe) => {
      const taskId = randomUUID();
      let resolve!: () => void;
      const done = new Promise<void>((finish) => {
        resolve = finish;
      });
      const job: ActiveProbe = {
        probe,
        taskId,
        done,
        resolve,
        timer: setTimeout(() => settle(job, true), probeTimeoutMs),
      };
      job.timer.unref?.();
      active = job;
      const execute = async (): Promise<void> => {
        const subagentId = await ensureResident(job);
        if (active !== job || stopped || input.companionsAllowed?.() === false) {
          retire(subagentId);
          return;
        }
        job.subagentId = subagentId;
        const text = buildProbeTaskText(probe);
        await director.assignInternal({
          id: taskId,
          description: input.scrub ? input.scrub(text) : text,
          subagentId,
        });
        await done;
      };
      try {
        // Completion owns the flight slot. Assignment/spawn never block the
        // leader, and even a hung adapter releases this slot at the deadline.
        await Promise.race([execute(), done]);
        return { subagentId: job.subagentId ?? '', taskId };
      } finally {
        settle(job, true);
      }
    },
    projectRoot: input.projectRoot,
    signals: config?.signals,
    maxProbeAgeMs: config?.maxProbeAgeMs,
    cooldownMs: config?.cooldownMs,
    maxPending: config?.maxPending,
    pollIntervalMs: config?.pollIntervalMs,
    companionAgentId: `${DEFAULT_EXPLORE_COMPANION_AGENT_ID}@${sessionTag}`,
  };

  const companion = new ExploreCompanion(options);
  const offSessionTerminate = director.onSessionTerminate?.((terminatedSessionId) => {
    if (terminatedSessionId !== sessionId) return;
    companion.clearPending();
    residentId = undefined;
    if (active) settle(active, false);
  });
  const offCompleted = director.on('task.completed', ({ result }) => {
    const job = active;
    if (!job || result.taskId !== job.taskId || result.subagentId !== job.subagentId) return;
    try {
      if (
        !stopped &&
        companion.isRunning() &&
        input.companionsAllowed?.() !== false &&
        result.status === 'success'
      ) {
        forwardExploreFindings({
          result,
          from: options.companionAgentId ?? `${DEFAULT_EXPLORE_COMPANION_AGENT_ID}@${sessionTag}`,
          sessionId,
          events,
          probe: job.probe,
          maxChars: maxFindingsChars,
          scrub: input.scrub,
        });
      }
    } finally {
      settle(job, result.status !== 'success');
    }
  });
  const stopWatching = companion.stop.bind(companion);
  Object.assign(companion, {
    stop(): void {
      if (stopped) return;
      stopped = true;
      offSessionTerminate?.();
      offCompleted();
      stopWatching();
      if (active) settle(active, true);
      else if (residentId) retire(residentId);
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
  probe: ExploreProbe;
  maxChars: number;
  scrub?: ((text: string) => string) | undefined;
}): void {
  const { result, from, sessionId, events, probe, maxChars } = input;
  try {
    const formattedReport = result.report ? formatExploreNote(result.report) : '';
    const raw = formattedReport || (typeof result.result === 'string' ? result.result : undefined);
    if (!raw?.trim()) return;
    const subject = `[explore] ${probe.source}: ${probe.subject}`;
    postSessionNote({
      sessionId,
      from,
      to: 'leader',
      kind: 'result',
      subject: (input.scrub ? input.scrub(subject) : subject).slice(0, 180),
      body: boundedFindings(input.scrub ? input.scrub(raw) : raw, maxChars),
      events,
    });
  } catch {
    // Forwarding must never disturb the leader or the resident.
  }
}

/**
 * Leader-facing rendering of a probe report. The generic report layout repeats
 * every cited path under "Files examined" and prints "(none)" placeholders;
 * here the findings already carry `path:line`, so only the answer is kept.
 */
export function formatExploreNote(report: SubagentStructuredReport): string {
  const summary = report.summary.trim();
  const findings = report.findings.map((f) => f.trim()).filter(Boolean);
  if (!summary && findings.length === 0) return '';
  const lines = [summary];
  for (const text of findings) {
    lines.push(`- ${text}`);
  }
  const next = report.suggested_next_steps.find((step) => step.trim());
  if (next) lines.push(`Next: ${next.trim()}`);
  lines.push(`(confidence ${report.confidence.toFixed(2)})`);
  return lines.filter(Boolean).join('\n');
}

function boundedFindings(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n[Explore result truncated]';
  return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix.slice(0, maxChars);
}
