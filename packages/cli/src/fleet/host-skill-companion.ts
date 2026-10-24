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
 * Deterministic rules run before and around the judge: the frontmatter
 * `paths` of every raisable skill are armed in the leader's meta, and the
 * tool executor holds a change to a matching file before it runs, without a
 * model call (core skills/skill-path-rules.ts); candidates are
 * ranked by word overlap with the work before the `maxCandidates` cut; and a
 * todo or file-family probe whose overlap the judge already answered "nothing
 * fits" for is not asked again.
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
import { basename } from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  FleetConfig,
  SkillLoader,
  SkillManifest,
  SubagentConfig,
  TaskResult,
} from '@wrongstack/contracts/types';
import { type Context, keepsOwnContext } from '@wrongstack/core/agent';
import type { Director } from '@wrongstack/core/coordination';
import {
  armSkillPathRules,
  declaredPathMatch,
  extractSkillMentions,
  isSkillRecommendable,
  readRequiredSkillsState,
  readSkillCompanionState,
  recommendLocalSkills,
  recommendSkills,
  SKILL_BUMP_TOOLS,
  SKILL_COMPANION_META_KEY,
  type SkillRecommendation,
  skillPromptExclusionReasons,
} from '@wrongstack/core/skills';
import {
  isSkillSuppressed,
  loadSkillOutcomes,
  recordSkillOutcomes,
  type SkillOutcomes,
} from './skill-companion-outcomes.js';
import {
  constrainSkillCompanion,
  DEFAULT_SKILL_COMPANION_BUDGET,
  isProofDrivenBugHuntRequest,
  parseSkillCompanionPick,
  SKILL_COMPANION_ID_PREFIX,
  SKILL_COMPANION_PROMPT,
  SKILL_COMPANION_ROLE,
  type SkillCandidate,
  skillCompanionCandidates,
} from './skill-companion-policy.js';
import {
  editedPaths,
  evidenceSignature,
  fileFamily,
  rankSkillCandidates,
  workTerms,
} from './skill-companion-signals.js';

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
  /** Where outcomes are learned (skill-companion-outcomes.ts). Absent: no learning. */
  projectRoot?: string | undefined;
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
  /** Skills the post-edit `paths` rule already noted; once per conversation. */
  declared: Set<string>;
  /** Lexical evidence the judge already answered "nothing fits" for. */
  emptyEvidence: Set<string>;
  /** Recommendations whose outcome is already recorded. */
  settled: Set<string>;
}

type Eligibility = {
  catalog: SkillManifest[];
  toolNames: string[];
  excluded: (name: string) => boolean;
};

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
const MAX_EMPTY_EVIDENCE = 32;

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class HostSkillCompanion {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Probe>();
  private draining = false;
  private stopped = false;
  private active:
    | {
        sessionId: string;
        taskId: string;
        agentId: string;
        settle: (result?: TaskResult) => void;
      }
    | undefined;
  private readonly off: Array<() => void>;
  private readonly maxProbes: number;
  private readonly minConfidence: number;
  private readonly probeTimeoutMs: number;
  private readonly maxCandidates: number;
  private readonly enforce: boolean;
  private readonly pathRules: boolean;
  private readonly learn: boolean;
  private outcomes: SkillOutcomes | undefined;

  constructor(private readonly input: Input) {
    const config = input.config ?? {};
    this.maxProbes = Math.floor(positive(config.maxProbesPerSession, 8));
    this.minConfidence = Math.min(1, positive(config.minConfidence, 0.6));
    this.probeTimeoutMs = positive(config.probeTimeoutMs, DEFAULT_SKILL_COMPANION_BUDGET.timeoutMs);
    this.maxCandidates = Math.floor(positive(config.maxCandidates, 80));
    this.enforce = config.enforce !== 'off';
    this.pathRules = config.pathRules !== false;
    this.learn = config.learnOutcomes !== false;
    const leaderId = input.leaderAgentId ?? 'leader';
    this.off = [
      input.events.on('agent.run.started', (event) => {
        const sessionId = event.sessionId;
        // Workers carry agentRole metadata and never get their own picker.
        if (!sessionId || event.ctx.meta?.['agentRole']) return;
        // Proof-driven hunts already load their four-skill pipeline. Retire
        // this session's picker before any turn, todo or edit can re-probe it.
        // An agent leading the session (ACP, WrongForge) picks its own skills
        // and is never held for a recommendation (tool-executor.ts), so a
        // probe would only spend a side model on a note it cannot act on.
        // The picker comes back with the first turn a WrongStack model runs.
        if (
          keepsOwnContext(event.ctx.provider) ||
          isProofDrivenBugHuntRequest(event.inputText ?? '')
        ) {
          this.release(sessionId);
          if (event.ctx.meta) delete event.ctx.meta[SKILL_COMPANION_META_KEY];
          return;
        }
        // This listener can run before the host's own run.started handler, so
        // a conversation's first run opens its slot here.
        if (this.stopped || !this.input.enabled(sessionId)) return;
        this.ensure(sessionId);
        const session = this.sessions.get(sessionId)!;
        session.ctx = event.ctx;
        // The previous turn's loads and refusals settle its recommendations.
        this.harvest(sessionId, session);
        const request = (event.inputText ?? '').trim();
        const judged = request.length >= MIN_REQUEST_CHARS;
        if (judged || (!session.request && request)) {
          session.request = request.slice(0, MAX_REQUEST_CHARS);
        }
        // Declared paths need no request: arm them for every turn, "continue"
        // included, so the executor holds the matching edit itself.
        void this.armPathRules(sessionId, session).catch(() => {});
        if (!judged) return;
        // A new request makes every queued probe for the old one stale.
        for (const [key, probe] of this.pending) {
          if (probe.sessionId === sessionId) {
            this.pending.delete(key);
            session.subjects.delete(probe.subject);
            if (probe.subject.startsWith('family:')) {
              session.families.delete(probe.subject.slice('family:'.length));
            }
          }
        }
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
        const files = editedPaths(event.input, event.writeTargets);
        for (const file of files)
          session.recentFiles = [file, ...session.recentFiles.filter((f) => f !== file)].slice(
            0,
            8,
          );
        void this.onEdit(sessionId, session, files).catch(() => {});
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
      ...(typeof input.director.onSessionTerminate === 'function'
        ? [
            input.director.onSessionTerminate((terminatedSessionId) => {
              const session = this.sessions.get(terminatedSessionId);
              if (session) session.resident = undefined;
              for (const [key, probe] of this.pending) {
                if (probe.sessionId === terminatedSessionId) {
                  this.pending.delete(key);
                  session?.subjects.delete(probe.subject);
                  if (probe.subject.startsWith('family:')) {
                    session?.families.delete(probe.subject.slice('family:'.length));
                  }
                }
              }
              if (this.active?.sessionId === terminatedSessionId) {
                this.active.settle();
              }
            }),
          ]
        : []),
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
      declared: new Set(),
      emptyEvidence: new Set(),
      settled: new Set(),
    });
  }

  release(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) this.harvest(sessionId, session);
    this.sessions.delete(sessionId);
    for (const [key, probe] of this.pending)
      if (probe.sessionId === sessionId) this.pending.delete(key);
    if (
      this.active?.sessionId === sessionId ||
      (session?.resident && this.active?.agentId === session.resident)
    )
      this.active.settle();
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
      const content = todo.content.trim();
      session.todos.delete(todo.id);
      session.todos.set(todo.id, { status: todo.status, content: content.slice(0, 160) });
      if (previous === 'in_progress' || todo.status !== 'in_progress' || !content) continue;
      this.enqueue({
        sessionId,
        trigger: 'todo',
        subject: `todo:${todo.id}`,
        detail: `The leader started a todo: ${content.slice(0, 200)}`,
      });
    }
    while (session.todos.size > 64) session.todos.delete(session.todos.keys().next().value!);
  }

  private enqueue(probe: Probe): boolean {
    const session = this.sessions.get(probe.sessionId);
    if (!session || session.subjects.has(probe.subject) || session.probes >= this.maxProbes)
      return false;
    const key = `${probe.sessionId}\0${probe.subject}`;
    if (this.pending.size >= MAX_PENDING && !this.pending.has(key)) return false;
    session.subjects.add(probe.subject);
    this.pending.set(key, probe);
    void this.drain();
    return true;
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

  /** The catalog and the names this session must not be offered, or undefined. */
  private async eligibility(
    sessionId: string,
    session: Session,
    ctx: Context,
  ): Promise<Eligibility | undefined> {
    const loader = this.input.skillLoader();
    if (!loader) return undefined;
    const toolNames = (ctx.catalogTools ?? ctx.tools ?? []).map((tool) => tool.name);
    if (!toolNames.includes('skill')) return undefined;
    const catalog: SkillManifest[] = await loader.list();
    const names = new Set<string>([
      ...(readRequiredSkillsState(ctx)?.required ?? []),
      ...extractSkillMentions(session.request).map((name) => name.toLowerCase()),
      // The local advisor already put its pick, often with its body, in front
      // of this turn; holding an edit for it would be a duplicate nudge.
      ...(recommendLocalSkills(session.request, catalog, toolNames)?.names ?? []),
    ]);
    return {
      catalog,
      toolNames,
      excluded: (name) =>
        names.has(name) || !isSkillRecommendable(ctx, sessionId, name) || this.suppressed(name),
    };
  }

  /** Turned down often and lately in this project (skill-companion-outcomes.ts). */
  private suppressed(name: string): boolean {
    const root = this.input.projectRoot;
    if (!root || !this.learn) return false;
    this.outcomes ??= loadSkillOutcomes(root);
    return isSkillSuppressed(this.outcomes.skills[name]);
  }

  /** Record recommendations the leader has since loaded or refused. */
  private harvest(sessionId: string, session: Session): void {
    const root = this.input.projectRoot;
    const ctx = this.leaderCtx(sessionId, session);
    if (!root || !this.learn || !ctx) return;
    const state = readSkillCompanionState(ctx);
    if (state?.sessionId !== sessionId) return;
    const settle = (names: readonly string[]) =>
      names.filter((name) => state.raised.includes(name) && !session.settled.has(name));
    const accepted = settle(state.loaded);
    const declined = settle(state.declined);
    for (const name of [...accepted, ...declined]) session.settled.add(name);
    const next = recordSkillOutcomes(root, { accepted, declined });
    if (next) this.outcomes = next;
  }

  private async candidates(
    sessionId: string,
    session: Session,
    ctx: Context,
    probeDetail?: string,
  ): Promise<SkillCandidate[]> {
    const eligible = await this.eligibility(sessionId, session, ctx);
    if (!eligible) return [];
    const all = skillCompanionCandidates(
      eligible.catalog,
      eligible.toolNames,
      eligible.excluded,
      Number.POSITIVE_INFINITY,
    );
    const openTodos = [...session.todos.values()]
      .filter((todo) => todo.status !== 'completed')
      .map((todo) => todo.content);
    const terms = workTerms(
      [session.request, ...(probeDetail ? [probeDetail] : []), ...openTodos],
      session.recentFiles,
    );
    return rankSkillCandidates(all, terms, this.maxCandidates);
  }

  /**
   * Arm the declared `paths` of every skill the companion may raise in this
   * session, so the executor holds the matching change before it runs
   * (skill-speed-bump.ts). Without enforcement there is no hold to arm; the
   * post-edit note in {@link declaredPaths} carries the recommendation.
   */
  private async armPathRules(sessionId: string, session: Session): Promise<void> {
    const ctx = this.leaderCtx(sessionId, session);
    if (!this.enforce || !this.pathRules || !ctx) return;
    const eligible = await this.eligibility(sessionId, session, ctx);
    if (!eligible || !this.current(sessionId, session)) return;
    const rules = eligible.catalog
      .filter(
        (skill) =>
          skill.paths?.length &&
          !eligible.excluded(skill.name.trim().toLowerCase()) &&
          skillPromptExclusionReasons(skill, eligible.toolNames).length === 0,
      )
      .map((skill) => ({ name: skill.name, globs: skill.paths! }));
    armSkillPathRules(ctx, sessionId, rules);
  }

  /**
   * An edit landed: a skill whose declared `paths` cover the file is
   * recommended outright; files a declared rule covers do not go to the judge
   * as a new file family.
   */
  private async onEdit(sessionId: string, session: Session, files: string[]): Promise<void> {
    const covered = await this.declaredPaths(sessionId, session, files);
    if (!this.current(sessionId, session)) return;
    for (const file of files) {
      if (covered.has(file)) continue;
      const family = fileFamily(file);
      if (!family || session.families.has(family)) continue;
      const queued = this.enqueue({
        sessionId,
        trigger: 'file_family',
        subject: `family:${family}`,
        detail: `The leader started editing a new kind of file: ${file}`,
      });
      if (queued) session.families.add(family);
    }
  }

  private async declaredPaths(
    sessionId: string,
    session: Session,
    files: readonly string[],
  ): Promise<Set<string>> {
    const covered = new Set<string>();
    const ctx = this.leaderCtx(sessionId, session);
    if (!this.pathRules || !ctx || files.length === 0) return covered;
    const eligible = await this.eligibility(sessionId, session, ctx);
    if (!eligible || !this.current(sessionId, session)) return covered;
    // The executor already raised what an armed rule matched; this catches an
    // edit that ran before arming finished, and every edit when not enforcing.
    const open = new Set(readSkillCompanionState(ctx)?.recommended.map((rec) => rec.name));
    const picks: SkillRecommendation[] = [];
    for (const skill of eligible.catalog) {
      if (!skill.paths?.length) continue;
      if (skillPromptExclusionReasons(skill, eligible.toolNames).length > 0) continue;
      const name = skill.name.trim().toLowerCase();
      const raisable =
        picks.length < 2 &&
        !open.has(name) &&
        !session.declared.has(name) &&
        !eligible.excluded(name);
      for (const file of files) {
        const glob = declaredPathMatch(skill, file, ctx.projectRoot, ctx.workingDir ?? ctx.cwd);
        if (!glob) continue;
        // A declared skill covers its files even once loaded or declined.
        covered.add(file);
        if (raisable)
          picks.push({
            name,
            reason: `declares paths ${glob}, matched ${basename(file)}`,
            declared: true,
          });
        break;
      }
    }
    // Once per skill per conversation: a declined declared pick stays declined.
    for (const pick of picks) session.declared.add(pick.name);
    if (picks.length > 0) this.deliver(sessionId, session, picks, 'paths');
    return covered;
  }

  private async judge(probe: Probe): Promise<void> {
    const { sessionId } = probe;
    if (!this.allowed(sessionId)) return;
    const session = this.sessions.get(sessionId)!;
    const ctx = this.leaderCtx(sessionId, session);
    if (!ctx || (probe.trigger === 'turn' && !session.request) || session.probes >= this.maxProbes)
      return;
    const candidates = await this.candidates(sessionId, session, ctx, probe.detail);
    if (candidates.length === 0 || !this.current(sessionId, session)) return;
    // Same lexical evidence the judge already found nothing in: a todo or a
    // new file family that adds no new overlap gets the same answer. A new
    // user turn always reaches the judge.
    const evidence = evidenceSignature(candidates);
    if (probe.trigger !== 'turn' && evidence && session.emptyEvidence.has(evidence)) return;
    const agentId = await this.resident(sessionId, session);
    if (!agentId || !this.current(sessionId, session)) return;
    session.probes++;

    const taskId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = new Promise<TaskResult | undefined>((resolve) => {
      this.active = { sessionId, taskId, agentId, settle: resolve };
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
          maxToolCalls: DEFAULT_SKILL_COMPANION_BUDGET.maxToolCalls,
          timeoutMs: this.probeTimeoutMs,
        })
        .catch(() => this.active?.taskId === taskId && this.active.settle());
      const result = await completed;
      if (result?.status !== 'success') {
        if (session.resident === agentId) session.resident = undefined;
        void this.input.director.terminate(agentId).catch(() => {});
        return;
      }
      if (!this.current(sessionId, session)) return;
      const rawCandidates = [
        result.report?.summary,
        typeof result.result === 'string' ? result.result : undefined,
        result.report?.findings?.length ? result.report.findings.join('\n') : undefined,
      ];
      let pick: ReturnType<typeof parseSkillCompanionPick>;
      for (const rawCandidate of rawCandidates) {
        if (!rawCandidate) continue;
        pick = parseSkillCompanionPick(rawCandidate, candidates);
        if (pick) break;
      }
      if (!pick) return;
      if (pick.skills.length === 0 || pick.confidence < this.minConfidence) {
        if (evidence) {
          session.emptyEvidence.add(evidence);
          if (session.emptyEvidence.size > MAX_EMPTY_EVIDENCE)
            session.emptyEvidence.delete(session.emptyEvidence.values().next().value!);
        }
        return;
      }
      this.deliver(sessionId, session, pick.skills, 'judge');
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.active?.taskId === taskId) this.active = undefined;
    }
  }

  private current(sessionId: string, session: Session): boolean {
    return this.allowed(sessionId) && this.sessions.get(sessionId) === session;
  }

  private deliver(
    sessionId: string,
    session: Session,
    picks: SkillRecommendation[],
    source: 'judge' | 'paths',
  ): void {
    const ctx = this.leaderCtx(sessionId, session);
    if (!ctx) return;
    // The judge ran asynchronously: the leader may have loaded or declined a
    // pick in the meantime.
    const fresh = picks.filter((pick) => isSkillRecommendable(ctx, sessionId, pick.name));
    // A judge answer replaces the previous judge answer but never a declared
    // match, which is the skill author's own statement; a declared match goes
    // first and keeps whatever is still open.
    const state = readSkillCompanionState(ctx);
    const open = (state?.sessionId === sessionId ? state.recommended : []).filter(
      (rec) => source === 'paths' || rec.declared,
    );
    const ordered = source === 'paths' ? [...fresh, ...open] : [...open, ...fresh];
    const accepted = (this.enforce ? recommendSkills(ctx, sessionId, ordered) : fresh).filter(
      (rec) => fresh.some((pick) => pick.name === rec.name),
    );
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
      source === 'paths'
        ? "Deterministic match on the skill's declared paths, not a user instruction."
        : 'Advisory model judgment over the skill catalog, not a user instruction.',
    ];
    try {
      this.input.note(sessionId, '[skill:recommend]', this.input.scrub(lines.join('\n')));
    } catch {
      /* A note failure must not undo the recommendation. */
    }
  }

  private async resident(sessionId: string, session: Session): Promise<string | undefined> {
    if (session.resident) {
      const alive = this.input.director
        .status()
        .subagents.some(
          (agent) =>
            agent.id === session.resident && agent.status !== 'stopped' && agent.status !== 'error',
        );
      if (!alive) {
        const staleResident = session.resident;
        session.resident = undefined;
        void this.input.director.terminate(staleResident).catch(() => {});
      }
    }
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
      timeoutMs: this.probeTimeoutMs,
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
