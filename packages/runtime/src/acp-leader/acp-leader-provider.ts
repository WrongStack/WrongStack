/**
 * An ACP agent (Claude Code) as the session's leader — docs/plans/acp-leader-mode.md.
 *
 * Picked like a model: `--provider acp --model claude-code`. The leader's loop
 * stays WrongStack's: each leader turn is one `stream()` call, which becomes
 * one turn of a persistent agent session (one per WrongStack session) and
 * streams the agent's reply back as text. The agent runs its own tools, so the
 * stream never carries `tool_use` and every turn ends after one iteration;
 * the loop, history, sessions, accounting and interrupts work unchanged.
 *
 * Only the leader's own turns reach the agent. Side requests (`complete()`:
 * titles, summaries, next-step suggestions, the refiner) and a WrongStack
 * subagent that inherits the leader's model (a request whose thread is not
 * the owning conversation) go to `acp.leader.sideModel`: sent to the agent,
 * they would arrive in the user's session as prompts.
 *
 * `@wrongstack/acp` is loaded on first use: it must stay off the boot graph.
 *
 * Beside this file: what a session is given when it starts
 * (`acp-leader-session-setup.ts`), its prompt blocks (`acp-leader-prompt.ts`),
 * its call approvals (`acp-leader-approvals.ts`) and the side-model rules
 * (`acp-leader-side-model.ts`).
 */
import { type ACPProgressEvent, type ACPSession, findAgentDescriptor } from '@wrongstack/acp';
import type {
  AgentContextUsage,
  Capabilities,
  Config,
  Provider,
  ProviderFactory,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import type {
  AcpChildSession,
  AcpNativeModeChoice,
  AcpNativeModeSelector,
  AcpNativeRuntimeResult,
  AcpRuntimeEdit,
  AcpRuntimeSelections,
  AcpRuntimeValues,
  AcpSessionPlan,
} from '@wrongstack/contracts/types/acp-runtime';
import type { TodoItem } from '@wrongstack/contracts/types/todo';
import { type Context, consumeBtwNotes } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import { acpBtwBlock, recordAcpRateLimit, startAcpTurnReminders } from '@wrongstack/fleet';
import { LeaderApprovals } from './acp-leader-approvals.js';
import { advertisedNativeCommand } from './acp-leader-commands.js';
import { LeaderContext, publishLeaderContext } from './acp-leader-context.js';
import { FLEET_SERVER_NAME } from './acp-leader-fleet.js';
import {
  ACP_LEADER_PROVIDER_ID,
  acpLeaderHost,
  trackAcpLeader,
  untrackAcpLeader,
} from './acp-leader-host.js';
import { nativeCommandText, promptBlocks } from './acp-leader-prompt.js';
import { readLeaderSession, writeLeaderSession } from './acp-leader-resume.js';
import type { AcpModule, LeaderSession } from './acp-leader-session.js';
import { prepareLeaderSession } from './acp-leader-session-setup.js';
import { explicitLeaderSideModel, isLeaderTurn, leaderSideModel } from './acp-leader-side-model.js';
import { externalSkillDirective, externalSkillLoader } from './acp-leader-skills.js';
import {
  agentTurnError,
  earlierConversation,
  latestUserText,
  StreamQueue,
  TextBlocks,
  ToolCardRelay,
  turnStopReason,
  turnUsage,
} from './acp-leader-stream.js';

export { ACP_LEADER_PROVIDER_ID, explicitLeaderSideModel, isLeaderTurn, leaderSideModel };

const CAPABILITIES: Capabilities = {
  tools: true,
  parallelTools: false,
  vision: false,
  streaming: true,
  promptCache: false,
  systemPrompt: true,
  jsonMode: false,
  reasoning: false,
  // Per agent: the catalog's declared window, 0 (unknown) otherwise.
  maxContext: 0,
  maxOutput: 32_000,
  cacheControl: 'none',
  topK: false,
  frequencyPenalty: false,
  presencePenalty: false,
  seed: false,
  structuredOutput: false,
  logprobs: false,
  audio: false,
  multipleCompletions: false,
  // The agent runs its own conversation and compacts it itself.
  keepsOwnContext: true,
};

export interface AcpLeaderProviderOptions {
  id?: string | undefined;
  /** The config at boot; the bound host's live config wins once available. */
  bootConfig: Config;
  /** Build a WrongStack provider by id, for side requests. */
  buildProvider(providerId: string, config: Config): Provider | undefined;
}

export class AcpLeaderProvider implements Provider {
  readonly id: string;
  private caps: { agentId: string; value: Capabilities } | undefined;
  private acp: AcpModule | undefined;
  private readonly sessions = new Map<string, Promise<LeaderSession>>();
  private readonly sessionLeaders = new WeakMap<Promise<LeaderSession>, LeaderSession>();
  private readonly sideProviders = new Map<string, Provider>();
  /** The leader agent's calls the user has to approve, and the fleet calls already approved. */
  private readonly approvals = new LeaderApprovals();
  private closed = false;

  constructor(private readonly opts: AcpLeaderProviderOptions) {
    this.id = opts.id ?? ACP_LEADER_PROVIDER_ID;
    trackAcpLeader(this);
  }

  private config(): Config {
    return acpLeaderHost()?.getConfig() ?? this.opts.bootConfig;
  }

  /**
   * The leading agent's capabilities. One object per agent, so a host that
   * refines a field in place keeps it until the user picks another agent.
   */
  get capabilities(): Capabilities {
    const agentId = this.config().model;
    if (this.caps?.agentId !== agentId) {
      const maxContext = findAgentDescriptor(agentId)?.contextWindow ?? CAPABILITIES.maxContext;
      this.caps = { agentId, value: { ...CAPABILITIES, maxContext } };
    }
    return this.caps.value;
  }

  async supportsVisionFor(model: string, sessionId: string): Promise<boolean> {
    const acp = await this.loadAcp();
    try {
      const leader = await this.sessionFor(sessionId, model);
      return leader.session.getCapabilities().promptCapabilities?.image === true;
    } catch (error) {
      throw agentTurnError(error, model, acp.classifyAgentFailure).error;
    }
  }

  async listNativeCommands(model: string, sessionId: string) {
    const acp = await this.loadAcp();
    try {
      const leader = await this.sessionFor(sessionId, model);
      return leader.session.getAvailableCommands().map(({ name, description, input }) => ({
        name,
        description,
        ...(input?.hint ? { inputHint: input.hint } : {}),
      }));
    } catch (error) {
      throw agentTurnError(error, model, acp.classifyAgentFailure).error;
    }
  }

  async listNativePlans(model: string, sessionId: string): Promise<AcpSessionPlan[]> {
    const leader = await this.sessions.get(sessionId);
    return leader?.agentId === model ? leader.session.getSessionPlans() : [];
  }

  async listNativeChildren(model: string, sessionId: string): Promise<AcpChildSession[]> {
    const leader = await this.sessions.get(sessionId);
    return leader?.agentId === model ? leader.session.getChildSessions() : [];
  }

  private projectPlanTodos(sessionId: string, plans: AcpSessionPlan[]): void {
    const host = acpLeaderHost();
    const ctx = host?.context(sessionId) as Context | undefined;
    if (!host || !ctx?.state || (ctx.provider && ctx.provider.id !== this.id)) return;
    const prefix = 'acp-plan-';
    const previous = ctx.todos.filter((todo) => todo.id.startsWith(prefix));
    const fromPlans = plans
      .flatMap((plan): TodoItem[] =>
        plan.type === 'items'
          ? plan.entries.map((entry, index) => ({
              id: `${prefix}${plan.planId === null ? index + 1 : JSON.stringify([plan.planId, index])}`,
              content: entry.content,
              status: entry.status,
            }))
          : [],
      )
      .slice(0, 512);
    if (
      previous.length === fromPlans.length &&
      previous.every((row, index) => {
        const next = fromPlans[index];
        return (
          next && row.id === next.id && row.content === next.content && row.status === next.status
        );
      })
    ) {
      return;
    }
    ctx.state.replaceTodos([
      ...ctx.todos.filter((todo) => !todo.id.startsWith(prefix)),
      ...fromPlans,
    ]);
    host.events.emit('provider.todos_updated', {
      sessionId,
      ctx,
      todos: [...ctx.todos],
      revision: ctx.state.revision,
    });
  }

  async configureNativeRuntime(
    model: string,
    sessionId: string,
    edit?: AcpRuntimeEdit,
  ): Promise<AcpNativeRuntimeResult> {
    const acp = await this.loadAcp();
    const leader = await this.sessionFor(sessionId, model);
    return this.withRuntimeUpdate(leader, async () => {
      const current = leader.session.getConfigOptions();
      if (!edit) return { options: current };
      const previous = this.desiredRuntime(model, sessionId);
      const { values, save } = edit(current);
      try {
        const unavailableRestores: AcpRuntimeValues = {};
        const options = await this.applyRuntime(
          acp,
          leader,
          this.effectiveRuntime(model, values),
          (id, value) => {
            unavailableRestores[id] = value;
          },
        );
        await save();
        return { options, unavailableRestores };
      } catch (error) {
        try {
          await this.applyRuntime(acp, leader, previous);
        } catch (rollbackError) {
          throw new Error(
            `${toErrorMessage(error)}. Restoring the agent settings failed: ${toErrorMessage(rollbackError)}`,
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  async configureNativeMode(
    model: string,
    sessionId: string,
    choice?: AcpNativeModeChoice,
  ): Promise<AcpNativeModeSelector[]> {
    const acp = await this.loadAcp();
    const leader = await this.sessionFor(sessionId, model);
    const supported = acp.resolveAcpClientProfile(model).leaderModes;
    const selectors = () =>
      leader.session.getSessionModeOptions().map((option) => {
        const allowed =
          supported && Object.hasOwn(supported, option.id) ? supported[option.id] : undefined;
        return {
          ...option,
          selectableValues: option.options
            .map((choice) => choice.value)
            .filter((value) => allowed?.includes(value)),
        };
      });
    return this.withRuntimeUpdate(leader, async () => {
      const current = selectors();
      if (!choice) return current;
      const matching = current.filter(
        (option) =>
          (!choice.optionId || option.id === choice.optionId) &&
          option.options.some((value) => value.value === choice.value),
      );
      const selected = matching[0];
      if (!selected) throw new Error('This ACP agent does not offer that mode.');
      if (matching.length > 1) throw new Error('Specify a mode selector ID. See /acp mode.');
      if (!selected.selectableValues.includes(choice.value)) {
        throw new Error(
          'WrongStack cannot switch to that mode. See /acp mode for selectable values.',
        );
      }
      await leader.session.setSessionModeOption(selected.id, choice.value);
      return selectors();
    });
  }

  private async withRuntimeUpdate<T>(leader: LeaderSession, run: () => Promise<T>): Promise<T> {
    const pending = (leader.runtimeUpdate ?? Promise.resolve()).then(run, run);
    leader.runtimeUpdate = pending;
    try {
      return await pending;
    } finally {
      if (leader.runtimeUpdate === pending) leader.runtimeUpdate = undefined;
    }
  }

  private desiredRuntime(model: string, sessionId: string): AcpRuntimeValues {
    const context = acpLeaderHost()?.context(sessionId) as Context | undefined;
    const selections = context?.meta?.['acpRuntime'] as AcpRuntimeSelections | undefined;
    return this.effectiveRuntime(model, selections?.[model]);
  }

  private effectiveRuntime(model: string, values?: AcpRuntimeValues): AcpRuntimeValues {
    return values && Object.keys(values).length > 0
      ? { ...values }
      : { ...(this.config().modelRuntime?.acp?.[model] ?? {}) };
  }

  private async applyRuntime(
    acp: AcpModule,
    leader: LeaderSession,
    values: AcpRuntimeValues,
    onUnavailableRestore?: (id: string, value: string) => void,
  ) {
    const configured = Object.keys(values).length > 0;
    if (!configured && !leader.runtimeConfigured) return leader.session.getConfigOptions();
    leader.runtimeConfigured = true;
    const options = await acp.applyAcpRuntimeValues(leader.session, values, onUnavailableRestore);
    leader.runtimeConfigured = configured;
    return options;
  }

  /** The WrongStack provider and request for anything that is not a leader turn. */
  private side(req: Request): { provider: Provider; req: Request } {
    const ref = leaderSideModel(this.config());
    let provider = ref ? this.sideProviders.get(ref.provider) : undefined;
    if (ref && !provider) {
      provider = this.opts.buildProvider(ref.provider, this.config());
      if (provider) this.sideProviders.set(ref.provider, provider);
    }
    if (!ref || !provider) {
      throw new ProviderError(
        'The ACP leader answers only its own turns. Set acp.leader.sideModel (provider/model) ' +
          'for side requests such as titles, summaries and WrongStack subagents.',
        400,
        false,
        this.id,
        { kind: 'invalid_request' },
      );
    }
    return { provider, req: { ...req, model: ref.model } };
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const side = this.side(req);
    return side.provider.complete(side.req, opts);
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    if (!isLeaderTurn(req)) {
      const side = this.side(req);
      yield* side.provider.stream(side.req, opts);
      return;
    }
    const agentId = req.model;
    const key = req.cache?.sessionId ?? 'default';
    const acp = await this.loadAcp();
    let leader: LeaderSession;
    try {
      leader = await this.sessionFor(key, agentId);
    } catch (err) {
      // Starting the agent failed (not installed, not logged in, no session):
      // a typed error the loop and the fallback chain understand.
      throw agentTurnError(err, agentId, acp.classifyAgentFailure).error;
    }

    const queue = new StreamQueue();
    const blocks = new TextBlocks(queue);
    // A tool call ends a run of text: the next words are a new block, as a
    // model's reply after a tool result would be.
    const onProgress = this.progress(leader, req.cache?.sessionId, {
      text: (text) => blocks.text(text),
      toolCall: () => blocks.close(),
    });

    yield { type: 'message_start', model: agentId };
    const hostContext = acpLeaderHost()?.context(key) as Context | undefined;
    if (
      leader.runtimeUpdate ||
      leader.runtimeConfigured ||
      Object.keys(this.desiredRuntime(agentId, key)).length > 0
    ) {
      await this.withRuntimeUpdate(leader, () =>
        this.applyRuntime(acp, leader, this.desiredRuntime(agentId, key)),
      );
    }
    const commandText = nativeCommandText(req.messages);
    const nativeCommand = commandText
      ? advertisedNativeCommand(commandText, leader.session.getAvailableCommands?.() ?? [])
      : undefined;
    const prompt = nativeCommand
      ? [acp.textContent(commandText)]
      : await promptBlocks(acp, leader, req, () => this.promptText(leader, req), this.id);
    const stopReminders =
      !nativeCommand && leader.session.canSteer() && hostContext?.meta
        ? startAcpTurnReminders({
            agentId: leader.agentId,
            context: hostContext,
            steer: (text) => leader.session.steer(text),
          })
        : undefined;
    const turn = leader.session.prompt(prompt, opts.signal, onProgress).then(
      (result) => {
        if (nativeCommand && result.stopReason === 'end_turn' && !result.hasText) {
          blocks.text(`Agent command /${nativeCommand.name} completed.`);
        }
        if (!nativeCommand && result.stopReason !== 'cancelled') leader.joined = true;
        blocks.close();
        if (result.usage) this.observeContext(leader, req.cache?.sessionId, result.usage);
        const agentContext = leader.context.current;
        queue.push({
          type: 'message_stop',
          stopReason: turnStopReason(result),
          usage: turnUsage(result),
          ...(agentContext ? { agentContext } : {}),
        });
        queue.end();
      },
      (err: unknown) => {
        blocks.close();
        const { error, dead } = agentTurnError(err, agentId, acp.classifyAgentFailure);
        if (dead) this.drop(key, leader);
        queue.fail(error);
      },
    );
    try {
      yield* queue.drain();
    } finally {
      stopReminders?.();
      await turn;
    }
  }

  /** The turn's prompt; an agent joining a conversation under way gets the turns before it. */
  private promptText(leader: LeaderSession, req: Request): string {
    const latest = externalSkillDirective(
      latestUserText(req.messages),
      externalSkillLoader(leader.fleet?.tools, `mcp__${FLEET_SERVER_NAME}__`),
    );
    const wasJoined = leader.joined;
    const earlier = wasJoined ? undefined : earlierConversation(req.messages);
    const prompt = earlier ? `${earlier}\n\n${latest}` : latest;
    const context = acpLeaderHost()?.context(req.cache?.sessionId) as Context | undefined;
    const notes = context?.meta ? consumeBtwNotes(context) : [];
    const withNotes =
      notes.length > 0 ? `${prompt}\n\n${acpBtwBlock(notes, leader.agentId)}` : prompt;
    return !wasJoined && leader.promptPrefix ? `${leader.promptPrefix}\n\n${withNotes}` : withNotes;
  }

  /**
   * `/compact` on this route: the agent compacts its own conversation. No
   * agent started yet means there is nothing in its context to compact.
   */
  async compactOwnContext(opts: {
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AgentContextUsage | undefined> {
    const pending = this.sessions.get(opts.sessionId);
    if (!pending) return undefined;
    const leader = await pending;
    const acp = await this.loadAcp();
    await leader.session.prompt(
      [acp.textContent('/compact')],
      opts.signal,
      this.progress(leader, opts.sessionId),
    );
    return leader.context.current;
  }

  /** The progress handler of one agent turn: text, tool cards, rate limits and context. */
  private progress(
    leader: LeaderSession,
    sessionId: string | undefined,
    on: { text?: (text: string) => void; toolCall?: () => void } = {},
  ): (event: ACPProgressEvent) => void {
    const tools = new ToolCardRelay(acpLeaderHost()?.events, {
      sessionId,
      model: leader.agentId,
    });
    return (event) => {
      switch (event.type) {
        case 'message':
          on.text?.(event.text);
          return;
        case 'thought': {
          const host = acpLeaderHost();
          const ctx = host?.context(sessionId);
          if (host && ctx && event.text) {
            host.events.emit('provider.thinking_delta', {
              sessionId,
              ctx,
              text: event.text,
            });
          }
          return;
        }
        case 'tool_call':
        case 'tool_call_update': {
          if (event.type === 'tool_call') on.toolCall?.();
          tools.update(event.toolCall);
          const compacted = leader.context.toolCall(event.toolCall);
          if (compacted) this.publishContext(sessionId, compacted);
          return;
        }
        case 'usage':
          this.observeContext(leader, sessionId, event.usage);
          return;
        case 'rate_limit':
          recordAcpRateLimit(leader.agentId, event.info);
          return;
        default:
          return;
      }
    };
  }

  /** A context reading from the agent: its window is the route's, and the fill shows at once. */
  private observeContext(
    leader: LeaderSession,
    sessionId: string | undefined,
    usage: { used: number; size: number },
  ): void {
    const reading = leader.context.usage(usage);
    // The agent knows its model's window (Claude: 200k, or 1M on a [1m] model);
    // refined in place, as the capabilities object is per agent.
    if (reading.size > 0 && leader.agentId === this.config().model) {
      this.capabilities.maxContext = reading.size;
    }
    this.publishContext(sessionId, reading);
  }

  private publishContext(sessionId: string | undefined, reading: AgentContextUsage): void {
    publishLeaderContext(acpLeaderHost()?.events, sessionId, reading, this.capabilities.maxContext);
  }

  private async loadAcp(): Promise<AcpModule> {
    this.acp ??= await import('@wrongstack/acp');
    return this.acp;
  }

  private drop(key: string, leader: LeaderSession): void {
    const current = this.sessions.get(key);
    if (!current || this.sessionLeaders.get(current) !== leader) return;
    this.sessions.delete(key);
    this.approvals.dropSession(key);
    void leader.session.close().catch(() => {});
    void leader.fleet?.close().catch(() => {});
    void Promise.resolve(leader.projectMcp?.revoke()).catch(() => {});
  }

  /** The persistent agent session for this conversation, started on first use. */
  private sessionFor(key: string, agentId: string): Promise<LeaderSession> {
    if (this.closed) return Promise.reject(new Error('ACP leader provider is closed'));
    const existing = this.sessions.get(key);
    if (existing) {
      return existing.then((leader) => {
        if (leader.agentId === agentId && !this.closed) return leader;
        // `/model acp/<other agent>` mid-session: a different agent, a new session.
        if (this.sessions.get(key) === existing) this.drop(key, leader);
        return this.sessionFor(key, agentId);
      });
    }
    const starting = this.startSession(key, agentId).then((leader) => {
      this.sessionLeaders.set(starting, leader);
      if (this.sessions.get(key) === starting) {
        this.projectPlanTodos(key, leader.session.getSessionPlans?.() ?? []);
      }
      return leader;
    });
    this.sessions.set(key, starting);
    starting.catch(() => {
      if (this.sessions.get(key) === starting) this.sessions.delete(key);
    });
    return starting;
  }

  private async startSession(key: string, agentId: string): Promise<LeaderSession> {
    const acp = await this.loadAcp();
    const host = acpLeaderHost();
    const config = this.config();
    const prepared = await prepareLeaderSession({
      acp,
      key,
      agentId,
      providerId: this.id,
      config,
      host,
      approvals: this.approvals,
    });
    if (this.closed) {
      await prepared.close();
      throw new Error('ACP leader provider is closed');
    }
    // A WrongStack session this agent led before (a resume): continue the
    // agent's own conversation rather than starting it over from a recap.
    const stateDir = host?.stateDir;
    const resumeSessionId = stateDir
      ? await readLeaderSession(stateDir, key, agentId).catch(() => undefined)
      : undefined;
    if (this.closed) {
      await prepared.close();
      throw new Error('ACP leader provider is closed');
    }
    let session: ACPSession | undefined;
    let opened: { sessionId: string; resumed: boolean };
    try {
      session = await acp.ACPSession.start({
        command: prepared.cmd.command,
        ...(prepared.cmd.args ? { args: prepared.cmd.args } : {}),
        ...(prepared.cmd.env ? { env: prepared.cmd.env } : {}),
        cwd: prepared.projectRoot,
        projectRoot: prepared.projectRoot,
        // Same reach as the leader's own file tools (features.allowOutsideProjectRoot),
        // and only behind the bridge policy: reads outside the project are put
        // to it, and without it nothing applies the sensitive-path rules.
        allowOutsideProjectRoot:
          prepared.permissionPolicy !== undefined &&
          (config.features?.allowOutsideProjectRoot ??
            !(config.tools?.restrictToProjectRoot ?? false)),
        role: agentId,
        observeSubagents: !host?.confirmAwaiter,
        onPlansChanged: (plans) => {
          const live = this.sessions.get(key);
          if (live && this.sessionLeaders.get(live)?.session === session) {
            this.projectPlanTodos(key, plans);
          }
        },
        ...(prepared.permissionPolicy ? { permissionPolicy: prepared.permissionPolicy } : {}),
        ...(prepared.elicitForm ? { elicitForm: prepared.elicitForm } : {}),
        ...(prepared.mcpServers.length > 0 ? { mcpServers: prepared.mcpServers } : {}),
        ...(prepared.sessionMeta ? { sessionMeta: prepared.sessionMeta } : {}),
        // Claude asks before edits and commands only in `default`.
        ...(prepared.permissionPolicy
          ? {
              initialModeId: 'default',
              requireInitialMode:
                acp.resolveAcpClientProfile(agentId).initialMode?.require ?? false,
            }
          : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      if (this.closed) {
        throw new Error('ACP leader provider is closed');
      }
      // Open it now: whether the agent continued its earlier session decides
      // whether the first turn has to carry the earlier conversation.
      opened = await session.openSession();
      if (this.closed) {
        throw new Error('ACP leader provider is closed');
      }
    } catch (err) {
      // An agent that never started (not installed, failed handshake) must not
      // leave this session's endpoints listening.
      void session?.close().catch(() => undefined);
      await prepared.close();
      throw err;
    }
    if (stateDir) {
      void writeLeaderSession(stateDir, key, { agentId, agentSessionId: opened.sessionId });
    }
    return {
      agentId,
      session,
      context: new LeaderContext(),
      fleet: prepared.fleet,
      projectMcp: prepared.projectMcp,
      joined: opened.resumed,
      ...(prepared.promptPrefix ? { promptPrefix: prepared.promptPrefix } : {}),
    };
  }

  /** Close every agent session (process shutdown). */
  async closeAll(): Promise<void> {
    this.closed = true;
    untrackAcpLeader(this);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      all.map((p) =>
        p
          .then((leader) => {
            void leader.fleet?.close().catch(() => undefined);
            void Promise.resolve(leader.projectMcp?.revoke()).catch(() => undefined);
            return leader.session.close({ graceMs: 500 });
          })
          .catch(() => undefined),
      ),
    );
  }
}

/**
 * Registered with the provider registry at boot. Inert unless the leader
 * names it (`--provider acp`, `/model acp/claude-code`).
 */
export function createAcpLeaderProviderFactory(
  opts: Omit<AcpLeaderProviderOptions, 'id'>,
): ProviderFactory {
  return {
    type: ACP_LEADER_PROVIDER_ID,
    // Routing metadata only: the provider does no wire conversion.
    family: 'openai-compatible',
    create: (cfg) =>
      new AcpLeaderProvider({
        ...opts,
        id: (cfg as { type?: string }).type || ACP_LEADER_PROVIDER_ID,
      }),
  };
}
