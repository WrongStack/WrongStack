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
import {
  type ACPProgressEvent,
  type ACPSession,
  type AcpChildSource,
  type AcpFormElicitationHandler,
  findAgentDescriptor,
} from '@wrongstack/acp';
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
import { documentAsText, ProviderError } from '@wrongstack/contracts/types';
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
import {
  base64DecodedBytes,
  MAX_INCOMING_IMAGE_BYTES,
  MAX_INCOMING_IMAGES,
  sanitizeTerminalPreview,
  subjectForToolInput,
  toErrorMessage,
} from '@wrongstack/core/utils';
import {
  acpBtwBlock,
  recordAcpRateLimit,
  startAcpTurnReminders,
  wrongstackAcpPermissionPolicy,
  wrongstackBridgeSetup,
} from '@wrongstack/fleet';
import { assertSafeVisionUrl } from '../vision.js';
import { advertisedNativeCommand } from './acp-leader-commands.js';
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
import {
  ACP_LEADER_PROVIDER_ID,
  acpLeaderHost,
  trackAcpLeader,
  untrackAcpLeader,
} from './acp-leader-host.js';
import { readLeaderSession, writeLeaderSession } from './acp-leader-resume.js';
import { externalSkillDirective, externalSkillLoader } from './acp-leader-skills.js';
import {
  agentTurnError,
  earlierConversation,
  latestUserText,
  pendingUserMessages,
  StreamQueue,
  TextBlocks,
  ToolCardRelay,
  turnStopReason,
  turnUsage,
} from './acp-leader-stream.js';

export { ACP_LEADER_PROVIDER_ID };

/**
 * `--restricted` (CLI) sets this for the whole process and its children; MCP
 * servers are not started then, so the agent's own are refused as well. Read
 * from the environment so every host (CLI, standalone engine) answers alike.
 */
const RESTRICTED_PROCESS_ENV = 'WRONGSTACK_RESTRICTED';
const isRestrictedProcess = (): boolean => process.env[RESTRICTED_PROCESS_ENV] === '1';

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

function nativeCommandText(messages: Request['messages']): string {
  const content = pendingUserMessages(messages).at(-1)?.content;
  if (typeof content === 'string') return content.trim();
  if (!content?.every((block) => block.type === 'text')) return '';
  return content
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

/** Fit handoff images in the existing incoming-image budget after the active turn's attachments. */
function recentHistoryImages(
  acp: AcpModule,
  messages: Request['messages'],
  attachments: Parameters<ACPSession['prompt']>[0],
): Parameters<ACPSession['prompt']>[0] {
  const images: Parameters<ACPSession['prompt']>[0] = [];
  let remainingImages = MAX_INCOMING_IMAGES;
  let remainingBytes = MAX_INCOMING_IMAGE_BYTES;
  for (const block of attachments) {
    if (block.type === 'image') {
      remainingImages--;
      remainingBytes -= base64DecodedBytes(block.data);
    } else if (block.type === 'resource' && 'blob' in block.resource) {
      remainingBytes -= base64DecodedBytes(block.resource.blob);
    }
  }

  const lastReply = messages.findLastIndex((message) => message.role === 'assistant');
  for (let i = lastReply - 1; i >= 0 && remainingImages > 0 && remainingBytes > 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0 && remainingImages > 0; j--) {
      const block = message.content[j];
      if (block?.type !== 'image' || block.source.type !== 'base64' || !block.source.data?.trim())
        continue;
      const bytes = base64DecodedBytes(block.source.data);
      if (bytes > remainingBytes) continue;
      images.push(acp.imageContent(block.source.media_type ?? 'image/png', block.source.data));
      remainingImages--;
      remainingBytes -= bytes;
    }
  }
  return images.reverse();
}

interface LeaderSession {
  runtimeConfigured?: boolean;
  runtimeUpdate?: Promise<unknown> | undefined;
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
  private readonly sessionLeaders = new WeakMap<Promise<LeaderSession>, LeaderSession>();
  private readonly sideProviders = new Map<string, Provider>();
  /**
   * Fleet calls the user already approved through the agent's permission
   * request, by session, tool and input: the call that follows runs on that
   * approval instead of asking again.
   */
  private readonly fleetGrants = new Map<string, number>();
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
      : await this.promptBlocks(acp, leader, req);
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

  /**
   * Preserve attachments across every user message waiting for this turn.
   * Fresh external sessions also receive recent images from the handoff history.
   */
  private async promptBlocks(
    acp: AcpModule,
    leader: LeaderSession,
    req: Request,
  ): Promise<Parameters<ACPSession['prompt']>[0]> {
    type PromptBlock = Parameters<ACPSession['prompt']>[0][number];
    const attachments: PromptBlock[] = [];
    const promptCaps = leader.session.getCapabilities?.().promptCapabilities;
    for (const message of pendingUserMessages(req.messages)) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type === 'image') {
          const { source } = block;
          if (source.type === 'url') {
            await assertSafeVisionUrl(source.url);
            attachments.push({
              type: 'resource_link',
              uri: source.url!,
              name: 'Image',
              ...(source.media_type ? { mimeType: source.media_type } : {}),
            });
            continue;
          }
          if (promptCaps?.image !== true || !source.data?.trim()) {
            throw new ProviderError(
              promptCaps?.image !== true
                ? `ACP agent '${leader.agentId}' does not support image prompt content.`
                : 'ACP image attachment has no image data.',
              400,
              false,
              this.id,
              { kind: 'invalid_request' },
            );
          }
          attachments.push(acp.imageContent(source.media_type ?? 'image/png', source.data));
        } else if (block.type === 'document') {
          if (promptCaps?.embeddedContext) {
            attachments.push({
              type: 'resource',
              resource: {
                uri: `file:///${encodeURIComponent(block.name ?? 'document.pdf')}`,
                mimeType: block.source.media_type,
                blob: block.source.data,
              },
            });
          } else {
            attachments.push(acp.textContent(documentAsText(block).text));
          }
        }
      }
    }

    const prior =
      !leader.joined && promptCaps?.image === true
        ? recentHistoryImages(acp, req.messages, attachments)
        : [];
    return [
      acp.textContent(this.promptText(leader, req)),
      ...(prior.length
        ? [acp.textContent('Recent images from the earlier conversation, in order.'), ...prior]
        : []),
      ...attachments,
    ];
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
    const current = this.sessions.get(key);
    if (!current || this.sessionLeaders.get(current) !== leader) return;
    this.sessions.delete(key);
    this.dropFleetGrants(key);
    void leader.session.close().catch(() => {});
    void leader.fleet?.close().catch(() => {});
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

  /**
   * Ask the user about one of the agent's calls on the prompt the surface
   * has: the REPL's own, or the TUI/WebUI approval prompt in the session's tab.
   */
  private async confirm(
    sessionId: string,
    tool: Tool,
    input: Record<string, unknown>,
    request: {
      toolCallId: string | undefined;
      signal: AbortSignal;
      child?: AcpChildSource | undefined;
    },
  ): Promise<boolean> {
    const approved = await this.ask(sessionId, tool, input, request);
    // A fleet tool runs in this process right after; that run must not ask again.
    if (approved && !request.child && FLEET_TOOLS.includes(tool.name)) {
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
    request: {
      toolCallId: string | undefined;
      signal: AbortSignal;
      child?: AcpChildSource | undefined;
    },
  ): Promise<boolean> {
    const host = acpLeaderHost();
    const suggestedPattern =
      subjectForToolInput(tool.name, input, tool.subjectKey, tool.subjectFields) ?? tool.name;
    const callId = request.toolCallId ?? `acp-${Date.now()}`;
    const toolUseId = request.child
      ? JSON.stringify(['acp-child', request.child.id, callId])
      : callId;
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
      ...(request.child
        ? {
            boundaryReason: `ACP subagent ${sanitizeTerminalPreview(request.child.title ?? request.child.id, { maxLines: 1, maxChars: 300 }).text}`,
          }
        : {}),
      permission: host.permission(sessionId),
      context: host.context(sessionId),
    });
  }

  private async startSession(key: string, agentId: string): Promise<LeaderSession> {
    const acp = await this.loadAcp();
    const config = this.config();
    const host = acpLeaderHost();
    const projectRoot = host?.projectRoot ?? process.cwd();
    const cmd = acp.resolveAcpAgentCommand(
      agentId,
      config.acp?.agents,
      acp.readCachedAcpRegistry()?.byId,
    );
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
    const fleetAppendix = fleet ? fleetNote(fleet.tools) : undefined;
    const sessionMeta =
      meta?.systemPrompt?.append !== undefined
        ? {
            ...meta,
            systemPrompt: {
              ...meta.systemPrompt,
              append: meta.systemPrompt.append + (fleetAppendix ? `\n${fleetAppendix}` : ''),
            },
          }
        : fleetAppendix
          ? {
              ...(meta ?? {}),
              systemPrompt: {
                ...(meta?.systemPrompt ?? {}),
                append: fleetAppendix,
              },
            }
          : meta;
    const permissionPolicy = host
      ? wrongstackAcpPermissionPolicy({
          evaluate: (tool, input) => host.permission(key).evaluate(tool, input, host.context(key)),
          // A fleet tool is decided as the leader tool it runs, not as an MCP proxy.
          getTool: (name) => host.getTool(fleetToolName(name) ?? name),
          projectRoot,
          allowMcp: !isRestrictedProcess(),
          registeredMcpServers: mcpServers.map((s) => s.name),
          ...(host.confirmAwaiter || host.confirmThroughEvents
            ? {
                confirm: (tool, call, request) => this.confirm(key, tool, call.input, request),
              }
            : {}),
        })
      : undefined;
    const elicitForm: AcpFormElicitationHandler | undefined =
      host?.confirmThroughEvents && (host.context(key) as Context | undefined)?.userInputAwaiter
        ? async (form, signal) => {
            const { elicitAcpFormViaUserInput } = await import('@wrongstack/mcp');
            return elicitAcpFormViaUserInput(
              form.child ? `${agentId} / ${form.child.title ?? form.child.id}` : agentId,
              form,
              {
                requestUserInput: (request, formSignal = signal) => {
                  const ctx = host.context(key) as Context | undefined;
                  return (
                    ctx?.userInputAwaiter?.(request, {
                      sessionId: key,
                      signal: formSignal,
                      meta: ctx.meta,
                    }) ?? Promise.resolve(undefined)
                  );
                },
              },
              signal,
            );
          }
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
        // Same reach as the leader's own file tools (features.allowOutsideProjectRoot),
        // and only behind the bridge policy: reads outside the project are put
        // to it, and without it nothing applies the sensitive-path rules.
        allowOutsideProjectRoot:
          permissionPolicy !== undefined &&
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
        ...(permissionPolicy ? { permissionPolicy } : {}),
        ...(elicitForm ? { elicitForm } : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
        ...(sessionMeta ? { sessionMeta } : {}),
        // Claude asks before edits and commands only in `default`.
        ...(permissionPolicy
          ? {
              initialModeId: 'default',
              requireInitialMode:
                acp.resolveAcpClientProfile(agentId).initialMode?.require ?? false,
            }
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
    this.closed = true;
    untrackAcpLeader(this);
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
