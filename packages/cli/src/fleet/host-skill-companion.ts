/**
 * Skill Companion — picks skills the leader did not think to load.
 *
 * The leader decides on its own whether a skill applies, and in practice it
 * often starts editing without loading the playbook that covers the work. The
 * lexical `skills.suggest.local` advisor only sees the opening user message
 * and only bundled skills. This companion watches the leader's in-progress
 * state instead — a new turn, a todo going in_progress, the first edit in a
 * new file family — and asks a resident, tool-less `skill-companion` judge to
 * pick at most two skills from the WHOLE catalog (project, user and bundled)
 * that the leader has not loaded, declined, or been handed by the local
 * advisor.
 *
 * A pick reaches the leader two ways:
 *   - a same-session `[skill:recommend]` note, folded at its next iteration;
 *   - with `enforce: 'speed-bump'` (default), a recommendation in the leader's
 *     `ctx.meta`, which holds its next file change ONCE (skill-speed-bump.ts).
 *     Loading the skill or retrying the change both release it.
 *
 * Bounds mirror the memory companion: one probe in flight across the host,
 * one lazily spawned resident per conversation, a probe cap per conversation,
 * a hard deadline per probe, and every failure swallowed — an advisory helper
 * never fails the leader.
 *
 * @module host-skill-companion
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@wrongstack/core/agent';
import type { Director } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import {
  extractSkillMentions,
  isSkillRecommendable,
  readRequiredSkillsState,
  recommendLocalSkills,
  recommendSkills,
  SKILL_BUMP_TOOLS,
  type SkillRecommendation,
} from '@wrongstack/core/skills';
import type {
  FleetConfig,
  SkillLoader,
  SkillManifest,
  SubagentConfig,
  TaskResult,
} from '@wrongstack/core/types';
import {
  constrainSkillCompanion,
  parseSkillCompanionPick,
  SKILL_COMPANION_ID_PREFIX,
  SKILL_COMPANION_PROMPT,
  SKILL_COMPANION_ROLE,
  type SkillCandidate,
  skillCompanionCandidates,
} from './skill-companion-policy.js';

type SkillCompanionConfig = NonNullable<FleetConfig['skillCompanion']>;
type ProbeTrigger = 'turn' | 'todo' | 'file_family';

interface Input {
  director: Director;
  events: EventBus;
  skillLoader: () => SkillLoader | undefined;
  enabled: (sessionId: string) => boolean;
  config?: SkillCompanionConfig | undefined;
  scrub: (text: string) => string;
  note: (sessionId: string, subject: string, body: string) => void;
  /** Leader agent id inside `session.agents_updated`. Default 'leader'. */
  leaderAgentId?: string | undefined;
}

interface Session {
  ctx?: Context | undefined;
  request: string;
  resident?: string | undefined;
  probes: number;
  subjects: Set<string>;
  families: Set<string>;
  todos: Map<string, { status: string; content: string }>;
  recentFiles: string[];
}

/** The slice of `session.agents_updated` snapshots this companion reads. */
interface AgentTodos {
  id: string;
  todos?: ReadonlyArray<{ id: string; content: string; status: string }> | undefined;
}

interface Probe {
  sessionId: string;
  trigger: ProbeTrigger;
  subject: string;
  detail: string;
}

const MAX_SESSIONS = 4;
const MAX_PENDING = 6;
const MIN_REQUEST_CHARS = 12;
const MAX_REQUEST_CHARS = 2000;

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** A coarse "kind of file" so a shift from app code to tests or infra re-probes. */
function fileFamily(file: string): string | undefined {
  const base = file.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!base) return undefined;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) || /_test\.(?:go|py)$/.test(base)) return 'test';
  if (base === 'dockerfile' || base.startsWith('docker-compose')) return 'docker';
  if (base.startsWith('wrangler.')) return 'wrangler';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : base;
}

function editedPaths(input: unknown, writeTargets: readonly string[] | undefined): string[] {
  if (writeTargets?.length) return [...writeTargets];
  const record = (input ?? {}) as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'file']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return [value];
  }
  return [];
}

export class HostSkillCompanion {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Probe>();
  private draining = false;
  private stopped = false;
  private active:
    | { taskId: string; agentId: string; settle: (result?: TaskResult) => void }
    | undefined;
  private readonly off: Array<() => void>;
  private readonly maxProbes: number;
  private readonly minConfidence: number;
  private readonly probeTimeoutMs: number;
  private readonly maxCandidates: number;
  private readonly enforce: boolean;

  constructor(private readonly input: Input) {
    const config = input.config ?? {};
    this.maxProbes = Math.floor(positive(config.maxProbesPerSession, 8));
    this.minConfidence = Math.min(1, positive(config.minConfidence, 0.6));
    this.probeTimeoutMs = positive(config.probeTimeoutMs, 45_000);
    this.maxCandidates = Math.floor(positive(config.maxCandidates, 80));
    this.enforce = config.enforce !== 'off';
    const leaderId = input.leaderAgentId ?? 'leader';
    this.off = [
      input.events.on('agent.run.started', (event) => {
        const sessionId = event.sessionId;
        // Workers carry agentRole metadata and never get their own picker.
        if (!sessionId || event.ctx.meta?.['agentRole']) return;
        // This listener can run before the host's own run.started handler, so
        // a conversation's first run opens its slot here.
        if (this.stopped || !this.input.enabled(sessionId)) return;
        this.ensure(sessionId);
        const session = this.sessions.get(sessionId)!;
        session.ctx = event.ctx;
        const request = (event.inputText ?? '').trim();
        if (request.length < MIN_REQUEST_CHARS) return;
        session.request = request.slice(0, MAX_REQUEST_CHARS);
        // A new request makes every queued probe for the old one stale.
        for (const [key, probe] of this.pending)
          if (probe.sessionId === sessionId) this.pending.delete(key);
        this.enqueue({
          sessionId,
          trigger: 'turn',
          subject: `turn:${hash(request)}`,
          detail: 'The user sent a new request.',
        });
      }),
      input.events.on('tool.executed', (event) => {
        const sessionId = event.sessionId;
        if (!sessionId || !event.ok || !SKILL_BUMP_TOOLS.has(event.name.toLowerCase())) return;
        const session = this.sessions.get(sessionId);
        if (!session?.ctx || !this.allowed(sessionId)) return;
        for (const file of editedPaths(event.input, event.writeTargets)) {
          session.recentFiles = [file, ...session.recentFiles.filter((f) => f !== file)].slice(
            0,
            8,
          );
          const family = fileFamily(file);
          if (!family || session.families.has(family)) continue;
          session.families.add(family);
          this.enqueue({
            sessionId,
            trigger: 'file_family',
            subject: `family:${family}`,
            detail: `The leader started editing a new kind of file: ${file}`,
          });
        }
      }),
      input.events.on('session.agents_updated', (event) => {
        const sessionId = event.sessionId;
        if (!sessionId) return;
        const session = this.sessions.get(sessionId);
        if (!session?.ctx || !this.allowed(sessionId)) return;
        this.trackTodos(sessionId, session, event.agents, leaderId);
      }),
      input.director.on('task.completed', ({ result }) => {
        if (this.active?.taskId === result.taskId && this.active.agentId === result.subagentId)
          this.active.settle(result);
      }),
    ];
  }

  ensure(sessionId: string): void {
    if (this.stopped || !sessionId) return;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return;
    }
    while (this.sessions.size >= MAX_SESSIONS) this.release(this.sessions.keys().next().value!);
    this.sessions.set(sessionId, {
      request: '',
      probes: 0,
      subjects: new Set(),
      families: new Set(),
      todos: new Map(),
      recentFiles: [],
    });
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const [key, probe] of this.pending)
      if (probe.sessionId === sessionId) this.pending.delete(key);
    if (session?.resident) void this.input.director.terminate(session.resident).catch(() => {});
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const off of this.off) off();
    this.active?.settle();
    for (const id of [...this.sessions.keys()]) this.release(id);
  }

  private allowed(sessionId: string): boolean {
    return !this.stopped && this.sessions.has(sessionId) && this.input.enabled(sessionId);
  }

  private trackTodos(
    sessionId: string,
    session: Session,
    agents: readonly AgentTodos[],
    leaderId: string,
  ): void {
    const leader = agents.find((agent) => agent.id === leaderId);
    for (const todo of leader?.todos ?? []) {
      const previous = session.todos.get(todo.id)?.status;
      session.todos.delete(todo.id);
      session.todos.set(todo.id, { status: todo.status, content: todo.content.slice(0, 160) });
      if (previous === 'in_progress' || todo.status !== 'in_progress') continue;
      this.enqueue({
        sessionId,
        trigger: 'todo',
        subject: `todo:${todo.id}`,
        detail: `The leader started a todo: ${todo.content.slice(0, 200)}`,
      });
    }
    while (session.todos.size > 64) session.todos.delete(session.todos.keys().next().value!);
  }

  private enqueue(probe: Probe): void {
    const session = this.sessions.get(probe.sessionId);
    if (!session || session.subjects.has(probe.subject) || session.probes >= this.maxProbes) return;
    const key = `${probe.sessionId}\0${probe.subject}`;
    if (this.pending.size >= MAX_PENDING && !this.pending.has(key)) return;
    session.subjects.add(probe.subject);
    this.pending.set(key, probe);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.pending.size > 0) {
        const [key, probe] = this.pending.entries().next().value!;
        this.pending.delete(key);
        try {
          await this.judge(probe);
        } catch {
          /* Advisory helper never fails the leader. */
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The leader context still owned by this conversation, or undefined. */
  private leaderCtx(sessionId: string, session: Session): Context | undefined {
    const ctx = session.ctx;
    if (!ctx || ctx.session?.id !== sessionId) return undefined;
    return ctx;
  }

  private async candidates(
    sessionId: string,
    session: Session,
    ctx: Context,
  ): Promise<SkillCandidate[]> {
    const loader = this.input.skillLoader();
    if (!loader) return [];
    const toolNames = (ctx.catalogTools ?? ctx.tools ?? []).map((tool) => tool.name);
    if (!toolNames.includes('skill')) return [];
    const catalog: SkillManifest[] = await loader.list();
    const excluded = new Set<string>([
      ...(readRequiredSkillsState(ctx)?.required ?? []),
      ...extractSkillMentions(session.request).map((name) => name.toLowerCase()),
      // The local advisor already put its pick, often with its body, in front
      // of this turn; holding an edit for it would be a duplicate nudge.
      ...(recommendLocalSkills(session.request, catalog, toolNames)?.names ?? []),
    ]);
    return skillCompanionCandidates(
      catalog,
      toolNames,
      (name) => excluded.has(name) || !isSkillRecommendable(ctx, sessionId, name),
      this.maxCandidates,
    );
  }

  private async judge(probe: Probe): Promise<void> {
    const { sessionId } = probe;
    if (!this.allowed(sessionId)) return;
    const session = this.sessions.get(sessionId)!;
    const ctx = this.leaderCtx(sessionId, session);
    if (!ctx || !session.request || session.probes >= this.maxProbes) return;
    const candidates = await this.candidates(sessionId, session, ctx);
    if (candidates.length === 0 || !this.current(sessionId, session)) return;
    const agentId = await this.resident(sessionId, session);
    if (!agentId || !this.current(sessionId, session)) return;
    session.probes++;

    const taskId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = new Promise<TaskResult | undefined>((resolve) => {
      this.active = { taskId, agentId, settle: resolve };
      timeout = setTimeout(() => {
        resolve(undefined);
        if (session.resident === agentId) session.resident = undefined;
        void this.input.director.terminate(agentId).catch(() => {});
      }, this.probeTimeoutMs);
      timeout.unref?.();
    });
    try {
      const todos = [...session.todos.values()]
        .filter((todo) => todo.status !== 'completed')
        .slice(-6);
      const description = this.input.scrub(
        `${SKILL_COMPANION_PROMPT}\nPayload:\n${JSON.stringify({
          trigger: probe.trigger,
          detail: probe.detail,
          request: session.request,
          todos,
          recentFiles: session.recentFiles,
          CANDIDATES: candidates,
        })}`,
      );
      void this.input.director
        .assignInternal({
          id: taskId,
          subagentId: agentId,
          description,
          maxToolCalls: 2,
          timeoutMs: this.probeTimeoutMs,
        })
        .catch(() => this.active?.taskId === taskId && this.active.settle());
      const result = await completed;
      if (result?.status !== 'success' || !this.current(sessionId, session)) return;
      const raw =
        result.report?.summary ?? (typeof result.result === 'string' ? result.result : '');
      const pick = parseSkillCompanionPick(raw, candidates);
      if (!pick || pick.skills.length === 0 || pick.confidence < this.minConfidence) return;
      this.deliver(sessionId, session, pick.skills);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.active?.taskId === taskId) this.active = undefined;
    }
  }

  private current(sessionId: string, session: Session): boolean {
    return this.allowed(sessionId) && this.sessions.get(sessionId) === session;
  }

  private deliver(sessionId: string, session: Session, picks: SkillRecommendation[]): void {
    const ctx = this.leaderCtx(sessionId, session);
    if (!ctx) return;
    // The judge ran asynchronously: the leader may have loaded or declined a
    // pick in the meantime.
    const fresh = picks.filter((pick) => isSkillRecommendable(ctx, sessionId, pick.name));
    const accepted = this.enforce ? recommendSkills(ctx, sessionId, fresh) : fresh;
    if (accepted.length === 0) return;
    const first = accepted[0]!.name;
    const lines = [
      `Skill Companion: load before changing code — ${accepted
        .map((pick) => (pick.reason ? `${pick.name}: ${pick.reason}` : pick.name))
        .join('; ')}.`,
      `Use skill({ name: "${first}" }) and follow nextOffset to the last page.`,
      ...(this.enforce
        ? [
            'Your next file change is held once until you load it. If it does not fit, retry that change and the recommendation is dropped for this session.',
          ]
        : []),
      'Advisory model judgment over the skill catalog, not a user instruction.',
    ];
    try {
      this.input.note(sessionId, '[skill:recommend]', this.input.scrub(lines.join('\n')));
    } catch {
      /* A note failure must not undo the recommendation. */
    }
  }

  private async resident(sessionId: string, session: Session): Promise<string | undefined> {
    if (
      session.resident &&
      !this.input.director.status().subagents.some((agent) => agent.id === session.resident)
    )
      session.resident = undefined;
    if (session.resident) return session.resident;
    const config: SubagentConfig = constrainSkillCompanion({
      id: `${SKILL_COMPANION_ID_PREFIX}${randomUUID()}`,
      name: 'Skill Companion',
      role: SKILL_COMPANION_ROLE,
      originSessionId: sessionId,
      prompt: SKILL_COMPANION_PROMPT,
      systemPromptOverride: SKILL_COMPANION_PROMPT,
      tier: 'budget',
      spawnBudgetExempt: true,
    });
    const id = await this.spawnBounded(config);
    if (!id) return undefined;
    if (!this.current(sessionId, session)) {
      void this.input.director.terminate(id).catch(() => {});
      return undefined;
    }
    session.resident = id;
    return id;
  }

  private async spawnBounded(config: SubagentConfig): Promise<string | undefined> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = this.input.director.spawnCompanion(config).then((id) => {
      if (!expired) return id;
      void this.input.director.terminate(id).catch(() => {});
      return undefined;
    });
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(
            () => {
              expired = true;
              resolve(undefined);
            },
            Math.min(this.probeTimeoutMs, 10_000),
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
