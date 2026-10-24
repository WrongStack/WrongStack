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
  SubagentRunContext,
  Tool,
} from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import { type Context, consumeBtwNotes } from '@wrongstack/core/agent';
import { subjectForToolInput } from '@wrongstack/core/utils';
import { isRestrictedMode } from '../boot/restricted-mode.js';
import { wrongstackAcpPermissionPolicy } from '../fleet/acp-permission-bridge.js';
import { recordAcpRateLimit } from '../fleet/acp-quota-reading.js';
import { acpBtwBlock, startAcpTurnReminders } from '../fleet/acp-turn-reminders.js';
import { wrongstackBridgeSetup } from '../fleet/acp-wrongstack-bridge.js';
import { confirmThroughEvents, rememberConfirmAnswer } from './acp-leader-confirm.js';
import { LeaderContext, publishLeaderContext } from './acp-leader-context.js';
import {
  FLEET_SERVER_NAME,
  FLEET_TOOLS,
  type FleetEndpoint,
  fleetNote,
  fleetToolName,
  startFleetEndpoint,
} from './acp-leader-fleet.js';
import { ACP_LEADER_PROVIDER_ID, acpLeaderHost, trackAcpLeader } from './acp-leader-host.js';
import { readLeaderSession, writeLeaderSession } from './acp-leader-resume.js';
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

export { ACP_LEADER_PROVIDER_ID };

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

type AcpModule = typeof import('@wrongstack/acp');

interface LeaderSession {
  agentId: string;
  session: ACPSession;
  context: LeaderContext;
  promptPrefix?: string | undefined;
  /** This session's fleet tools endpoint, when the leader has fleet tools. */
  fleet?: FleetEndpoint | undefined;
  /**
   * The agent already has this conversation: it resumed its earlier session,
   * or had a turn here. Until then its first turn carries the earlier one.
   */
  joined?: boolean;
}

/** A fleet call's identity: its session, tool and input, keys in a stable order. */
function fleetGrantKey(sessionId: string, tool: string, input: unknown): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
          )
        : value;
  return JSON.stringify([sessionId, tool, stable(input)]);
}

/** `provider/model` → its parts; a bare id or the ACP provider itself is unusable here. */
function parseSideModel(ref: string | undefined): { provider: string; model: string } | undefined {
  const slash = ref?.indexOf('/') ?? -1;
  if (!ref || slash <= 0 || slash === ref.length - 1) return undefined;
  const provider = ref.slice(0, slash);
  if (provider === ACP_LEADER_PROVIDER_ID) return undefined;
  return { provider, model: ref.slice(slash + 1) };
}

/**
 * The side model the user set for an agent leader (`acp.leader.sideModel`),
 * without falling back to the fallback chain: a leader that can answer side
 * requests itself (WrongForge) must not hand them to `fallbackModels[0]`.
 */
export function explicitLeaderSideModel(
  config: Config,
): { provider: string; model: string } | undefined {
  return parseSideModel(config.acp?.leader?.sideModel);
}

export function leaderSideModel(config: Config): { provider: string; model: string } | undefined {
  return (
    explicitLeaderSideModel(config) ??
    parseSideModel(config.fallbackBridge) ??
    parseSideModel(config.fallbackModels?.[0])
  );
}

/** A leader turn: the request's thread is its own conversation (a subagent's is not). */
export function isLeaderTurn(req: Request): boolean {
  const { sessionId, threadId } = req.cache ?? {};
  return !sessionId || !threadId || sessionId === threadId;
}

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
  private readonly sideProviders = new Map<string, Provider>();
  /**
   * Fleet calls the user already approved through the agent's permission
   * request, by session, tool and input: the call that follows runs on that
   * approval instead of asking again.
   */
  private readonly fleetGrants = new Map<string, number>();

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
    const stopReminders =
      leader.session.canSteer() && hostContext?.meta
        ? startAcpTurnReminders({
            context: hostContext,
            steer: (text) => leader.session.steer(text),
          })
        : undefined;
    const turn = leader.session
      .prompt([acp.textContent(this.promptText(leader, req))], opts.signal, onProgress)
      .then(
        (result) => {
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
    const earlier = leader.joined ? undefined : earlierConversation(req.messages);
    leader.joined = true;
    const prompt = earlier ? `${earlier}\n\n${latest}` : latest;
    const context = acpLeaderHost()?.context(req.cache?.sessionId) as Context | undefined;
    const notes = context?.meta ? consumeBtwNotes(context) : [];
    const withNotes = notes.length > 0 ? `${prompt}\n\n${acpBtwBlock(notes)}` : prompt;
    return leader.promptPrefix ? `${leader.promptPrefix}\n\n${withNotes}` : withNotes;
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

  private dropFleetGrants(sessionId: string): void {
    for (const grantKey of this.fleetGrants.keys()) {
      try {
        const parsed = JSON.parse(grantKey) as unknown;
        if (Array.isArray(parsed) && parsed[0] === sessionId) {
          this.fleetGrants.delete(grantKey);
        }
      } catch {
        // ignore
      }
    }
  }

  private drop(key: string, leader: LeaderSession): void {
    this.sessions.delete(key);
    this.dropFleetGrants(key);
    void leader.session.close().catch(() => {});
    void leader.fleet?.close().catch(() => {});
  }

  /** The persistent agent session for this conversation, started on first use. */
  private sessionFor(key: string, agentId: string): Promise<LeaderSession> {
    const existing = this.sessions.get(key);
    if (existing) {
      return existing.then((leader) => {
        if (leader.agentId === agentId) return leader;
        // `/model acp/<other agent>` mid-session: a different agent, a new session.
        this.drop(key, leader);
        return this.sessionFor(key, agentId);
      });
    }
    const starting = this.startSession(key, agentId);
    this.sessions.set(key, starting);
    starting.catch(() => {
      if (this.sessions.get(key) === starting) this.sessions.delete(key);
    });
    return starting;
  }

  /**
   * Ask the user about one of the agent's calls on the prompt the surface
   * has: the REPL's own, or the TUI/WebUI approval prompt in the session's tab.
   */
  private async confirm(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
    request: { toolCallId: string | undefined; signal: AbortSignal },
  ): Promise<boolean> {
    const approved = await this.ask(sessionId, tool, input, request);
    // A fleet tool runs in this process right after; that run must not ask again.
    if (approved && FLEET_TOOLS.includes(tool.name)) {
      const key = fleetGrantKey(sessionId, tool.name, input);
      this.fleetGrants.set(key, (this.fleetGrants.get(key) ?? 0) + 1);
    }
    return approved;
  }

  /**
   * A fleet call the policy wants confirmed: the approval the user gave the
   * agent's permission request for it, once, or a question now (an agent
   * whose own settings let it call the tool without asking).
   */
  private async approveFleetCall(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    const key = fleetGrantKey(sessionId, tool.name, input);
    const granted = this.fleetGrants.get(key) ?? 0;
    if (granted > 0) {
      if (granted === 1) this.fleetGrants.delete(key);
      else this.fleetGrants.set(key, granted - 1);
      return true;
    }
    return this.ask(sessionId, tool, input, {
      toolCallId: undefined,
      signal: new AbortController().signal,
    });
  }

  private async ask(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
    request: { toolCallId: string | undefined; signal: AbortSignal },
  ): Promise<boolean> {
    const host = acpLeaderHost();
    const suggestedPattern =
      subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields) ?? tool.name;
    const toolUseId = request.toolCallId ?? `acp-${Date.now()}`;
    if (host?.confirmAwaiter) {
      const answer = await host.confirmAwaiter(tool, input, toolUseId, suggestedPattern);
      await rememberConfirmAnswer(
        {
          tool,
          input,
          suggestedPattern,
          permission: host.permission(sessionId),
          context: host.context(sessionId),
        },
        answer,
      );
      return answer !== 'no' && answer !== 'deny';
    }
    if (!host?.confirmThroughEvents) return false;
    return confirmThroughEvents({
      events: host.events,
      sessionId,
      tool,
      input,
      toolUseId,
      suggestedPattern,
      signal: request.signal,
      permission: host.permission(sessionId),
      context: host.context(sessionId),
    });
  }

  private async startSession(key: string, agentId: string): Promise<LeaderSession> {
    const acp = await this.loadAcp();
    const config = this.config();
    const host = acpLeaderHost();
    const projectRoot = host?.projectRoot ?? process.cwd();
    const cmd = acp.resolveAcpAgentCommand(agentId, config.acp?.agents);
    if (!cmd) {
      throw new ProviderError(
        `Unknown ACP agent "${agentId}". Run /acp to see the agents installed here.`,
        400,
        false,
        this.id,
        { kind: 'invalid_request' },
      );
    }
    // The bridge's MCP servers and the leader note. The bridge builds them for
    // a fleet run; the leader has no task or budget, only an identity.
    const leaderCtx = {
      subagentId: 'leader',
      config: { id: 'leader', name: agentId, role: 'leader' },
      sessionId: key,
    } as unknown as SubagentRunContext;
    const setup = wrongstackBridgeSetup(
      agentId,
      projectRoot,
      config.acp?.bridge,
      'leader',
    )?.({ id: 'leader', description: '' }, leaderCtx);
    const fleet = host
      ? await startFleetEndpoint(host, {
          sessionId: key,
          approve: (tool, input) => this.approveFleetCall(key, tool, input),
        }).catch(() => undefined)
      : undefined;
    const mcpServers = [
      ...(setup?.mcpServers ?? []),
      ...(fleet
        ? [
            {
              type: 'http' as const,
              name: FLEET_SERVER_NAME,
              url: fleet.url,
              headers: [{ name: 'Authorization', value: `Bearer ${fleet.token}` }],
            },
          ]
        : []),
    ];
    const meta = setup?.meta as { systemPrompt?: { append?: string } } | undefined;
    const sessionMeta =
      meta?.systemPrompt?.append !== undefined
        ? {
            ...meta,
            systemPrompt: {
              ...meta.systemPrompt,
              append: meta.systemPrompt.append + (fleet ? `\n${fleetNote(fleet.tools)}` : ''),
            },
          }
        : meta;
    const permissionPolicy = host
      ? wrongstackAcpPermissionPolicy({
          evaluate: (tool, input) => host.permission(key).evaluate(tool, input, host.context(key)),
          // A fleet tool is decided as the leader tool it runs, not as an MCP proxy.
          getTool: (name) => host.getTool(fleetToolName(name) ?? name),
          projectRoot,
          allowMcp: !isRestrictedMode({}),
          ...(host.confirmAwaiter || host.confirmThroughEvents
            ? {
                confirm: (tool, call, request) => this.confirm(key, tool, call.input, request),
              }
            : {}),
        })
      : undefined;
    // A WrongStack session this agent led before (a resume): continue the
    // agent's own conversation rather than starting it over from a recap.
    const stateDir = host?.stateDir;
    const resumeSessionId = stateDir
      ? await readLeaderSession(stateDir, key, agentId).catch(() => undefined)
      : undefined;
    let session: ACPSession | undefined;
    let opened: { sessionId: string; resumed: boolean };
    try {
      session = await acp.ACPSession.start({
        command: cmd.command,
        ...(cmd.args ? { args: cmd.args } : {}),
        ...(cmd.env ? { env: cmd.env } : {}),
        cwd: projectRoot,
        projectRoot,
        role: agentId,
        ...(permissionPolicy ? { permissionPolicy } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(sessionMeta ? { sessionMeta } : {}),
        // Claude asks before edits and commands only in `default`.
        ...(permissionPolicy
          ? { initialModeId: 'default', requireInitialMode: agentId === 'claude-code' }
          : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      // Open it now: whether the agent continued its earlier session decides
      // whether the first turn has to carry the earlier conversation.
      opened = await session.openSession();
    } catch (err) {
      // An agent that never started (not installed, failed handshake) must not
      // leave this session's fleet endpoint listening.
      void session?.close().catch(() => undefined);
      void fleet?.close().catch(() => undefined);
      throw err;
    }
    if (stateDir) {
      void writeLeaderSession(stateDir, key, { agentId, agentSessionId: opened.sessionId });
    }
    return {
      agentId,
      session,
      context: new LeaderContext(),
      fleet,
      joined: opened.resumed,
      ...(setup?.promptPrefix ? { promptPrefix: setup.promptPrefix } : {}),
    };
  }

  /** Close every agent session (process shutdown). */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.fleetGrants.clear();
    await Promise.all(
      all.map((p) =>
        p
          .then((leader) => {
            void leader.fleet?.close().catch(() => undefined);
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
