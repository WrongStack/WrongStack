/**
 * The machine's WrongForge as the session's leader: picked like a model,
 * `--provider wrongforge --model <a model WrongForge serves>` or
 * `/model wrongforge/<model>`. The same seam as the ACP leader
 * (acp-leader-provider.ts): the leader's loop stays WrongStack's, each leader
 * turn is one `stream()` call, which becomes one WrongForge task in a
 * persistent WrongForge session (one per WrongStack session). WrongForge runs
 * its own tool loop, so the stream never carries `tool_use` and every turn
 * ends after one iteration.
 *
 * WrongForge reads with its own tools; everything else it does — edits,
 * commands, the board, memory, delegation — goes through the session's own
 * tools over a per-session gateway (wrongforge-leader-gateway.ts), so
 * WrongStack's rules, prompts, cards and fleet apply to it.
 *
 * Side requests (`complete()`: titles, summaries, the refiner, …) go to
 * `acp.leader.sideModel` when set, else to WrongForge as a one-step task with
 * no tools. A WrongStack subagent never reaches here: `provider: "wrongforge"`
 * routes to the WrongForge worker runner (fleet/routing.ts).
 */

import type {
  AgentContextUsage,
  Capabilities,
  Config,
  Message,
  Provider,
  ProviderFactory,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { ProviderError, type ProviderErrorKind } from '@wrongstack/contracts/types';
import { type Context, consumeBtwNotes } from '@wrongstack/core/agent';
import { toErrorMessage } from '@wrongstack/core/utils';
import { publishLeaderContext } from '../acp-leader/acp-leader-context.js';
import { acpLeaderHost, trackAcpLeader } from '../acp-leader/acp-leader-host.js';
import {
  explicitLeaderSideModel,
  isLeaderTurn,
  leaderSideModel,
} from '../acp-leader/acp-leader-provider.js';
import { externalSkillDirective, externalSkillLoader } from '../acp-leader/acp-leader-skills.js';
import {
  earlierConversation,
  latestUserText,
  StreamQueue,
  TextBlocks,
  ToolCardRelay,
} from '../acp-leader/acp-leader-stream.js';
import { acpBtwBlock } from '../fleet/acp-turn-reminders.js';
import {
  cancelTask,
  chooseModel,
  followTask,
  resolveWrongForgeEndpoint,
  safeWfId,
  terminalTaskRecord,
  toProgress,
  WfAborted,
  type WfCall,
  WfHttpError,
  type WfTaskRecord,
  WRONGFORGE_AGENT_ID,
  WRONGFORGE_READ_SIDE_TOOLS,
  wfTokens,
  wrongForgeCall,
} from '../fleet/wrongforge-client.js';
import {
  parseWrongForgeInfo,
  type WrongForgeInfo,
  writeWrongForgeInfoCache,
} from '../fleet/wrongforge-info.js';
import { reportWrongForgeQuota } from '../fleet/wrongforge-quota.js';
import { wrongForgeRuntime } from '../fleet/wrongforge-runtime.js';
import { type LeaderGateway, startLeaderGateway } from './wrongforge-leader-gateway.js';

export const WRONGFORGE_LEADER_PROVIDER_ID = WRONGFORGE_AGENT_ID;

/** Model steps one leader turn may take (WrongForge's own default is 50). */
const LEADER_MAX_STEPS = 150;
/** One leader turn's wall clock on WrongForge's side. */
const LEADER_TURN_TIMEOUT_MS = 2 * 60 * 60_000;

const CAPABILITIES: Capabilities = {
  tools: true,
  parallelTools: false,
  vision: false,
  streaming: true,
  promptCache: true,
  systemPrompt: true,
  jsonMode: false,
  reasoning: true,
  // Learned from WrongForge's first task result (its model's window).
  maxContext: 0,
  maxOutput: 32_000,
  cacheControl: 'native',
  topK: false,
  frequencyPenalty: false,
  presencePenalty: false,
  seed: false,
  structuredOutput: false,
  logprobs: false,
  audio: false,
  multipleCompletions: false,
  // WrongForge keeps the conversation (its session) and compacts it itself.
  keepsOwnContext: true,
};

interface LeaderSession {
  /** The WrongForge session this WrongStack session runs in. */
  wfSessionId: string;
  gateway?: Promise<LeaderGateway | undefined> | undefined;
  /** WrongForge already has this conversation (its session existed, or a turn ran). */
  joined?: boolean;
  context?: AgentContextUsage | undefined;
}

function leaderAppend(routed: boolean, tools: readonly string[]): string {
  const has = (n: string) => tools.includes(n);
  return [
    'In this task you LEAD a WrongStack session: a human user talks to you through',
    'WrongStack, and your reply goes to them, not to an orchestrator. Answer them directly,',
    'ask when something is truly ambiguous, and end a turn when the work or the answer is done.',
    'The worker-only rules of the WrongStack guide (no human watching, reply = report to a',
    'leader) do not apply to you; the rest (stay in the workdir, no git history rewrites, no',
    'commit or push unless asked) does.',
    ...(routed
      ? [
          "Your own write/edit/shell tools are off: change files with WrongStack's `wstack_edit` /",
          '`wstack_write` / `wstack_patch` and run commands with `wstack_bash` (or `wstack_test`,',
          "`wstack_lint`, `wstack_typecheck`). They run in the user's session, under their rules.",
        ]
      : []),
    ...(has('delegate')
      ? [
          '`wstack_delegate` hands work to WrongStack workers (scope and outOfScope required); the',
          'result arrives later as a [DELEGATION RESULT] message, so end your turn or keep working.',
        ]
      : []),
    ...(has('remember') || has('memory_search')
      ? ['`wstack_memory_search` / `wstack_remember` are the project memory: check it, add to it.']
      : []),
  ].join(' ');
}

/** The whole request as one prompt, for a tool-less one-step task. */
function flatten(req: Request): string {
  const text = (m: Message) =>
    typeof m.content === 'string'
      ? m.content
      : m.content
          .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
          .filter(Boolean)
          .join('\n');
  const system = (req.system ?? []).map((b) => b.text).join('\n\n');
  const turns = req.messages.map((m) => `[${m.role}]\n${text(m)}`).join('\n\n');
  return [
    system ? `<instructions>\n${system}\n</instructions>` : '',
    turns,
    'Reply to the last message, following the instructions above. Use no tools.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function providerError(err: unknown, id: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const make = (message: string, status: number, retryable: boolean, kind: ProviderErrorKind) =>
    new ProviderError(`WrongForge: ${message}`, status, retryable, id, { kind });
  if (err instanceof WfAborted) return make('the turn was cancelled', 499, false, 'unknown');
  if (err instanceof WfHttpError) {
    if (err.status === 401 || err.status === 403 || err.code === 'not_signed_in')
      return make(err.message, 401, false, 'auth');
    if (err.status === 0) return make(err.message, 0, true, 'network');
    if (err.status >= 500) return make(err.message, err.status, true, 'server');
    return make(`${err.code}: ${err.message}`, err.status, false, 'invalid_request');
  }
  return make(toErrorMessage(err), 0, false, 'unknown');
}

/** A finished task that did not complete, as the loop's typed error. */
function taskError(record: WfTaskRecord, id: string): ProviderError | undefined {
  const make = (message: string, status: number, retryable: boolean, kind: ProviderErrorKind) =>
    new ProviderError(`WrongForge: ${message}`, status, retryable, id, { kind });
  switch (record.status) {
    case 'completed':
      return undefined;
    case 'cancelled':
      return make(
        `the turn was cancelled${record.cancel_reason ? ` (${record.cancel_reason})` : ''}`,
        499,
        false,
        'unknown',
      );
    case 'timed_out':
      return make('the turn hit its timeout', 408, false, 'timeout');
    default: {
      const code = record.error?.code ?? 'internal_error';
      const message = `${code}: ${record.error?.message ?? 'no detail'}`;
      if (code === 'context_overflow') return make(message, 413, false, 'context_overflow');
      if (/rate.?limit|429/i.test(message)) return make(message, 429, true, 'rate_limit');
      if (/quota|usage limit|extra usage/i.test(message))
        return make(message, 402, false, 'quota_exhausted');
      return make(message, 500, code === 'server_restarted', 'server');
    }
  }
}

export interface WrongForgeLeaderProviderOptions {
  id?: string | undefined;
  bootConfig: Config;
  /** Build a WrongStack provider by id, for side requests when `acp.leader.sideModel` is set. */
  buildProvider(providerId: string, config: Config): Provider | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export class WrongForgeLeaderProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = { ...CAPABILITIES };
  private readonly sessions = new Map<string, LeaderSession>();
  private readonly sideProviders = new Map<string, Provider>();

  constructor(private readonly opts: WrongForgeLeaderProviderOptions) {
    this.id = opts.id ?? WRONGFORGE_LEADER_PROVIDER_ID;
    trackAcpLeader(this);
  }

  private config(): Config {
    return acpLeaderHost()?.getConfig() ?? this.opts.bootConfig;
  }

  private client(): WfCall {
    const ep = resolveWrongForgeEndpoint();
    if (!ep) {
      throw new ProviderError(
        'WrongForge: no API key found. Start it once with `npm run serve` (it saves ' +
          '~/.wrongforge/api-key) or set WRONGFORGE_API_KEY.',
        401,
        false,
        this.id,
        { kind: 'auth' },
      );
    }
    void reportWrongForgeQuota({
      endpoint: ep,
      providerId: this.id,
      fetchImpl: this.opts.fetchImpl,
    });
    return wrongForgeCall(ep, this.opts.fetchImpl);
  }

  private async info(call: WfCall, signal: AbortSignal): Promise<WrongForgeInfo | undefined> {
    try {
      const info = parseWrongForgeInfo(await call('GET', '/v1/info', undefined, signal));
      writeWrongForgeInfoCache(info);
      return info;
    } catch {
      return undefined;
    }
  }

  private model(requested: string, info: WrongForgeInfo | undefined): string | undefined {
    const choice = chooseModel(requested, undefined, info);
    if (choice.error) {
      throw new ProviderError(choice.error, 400, false, this.id, { kind: 'invalid_request' });
    }
    return choice.id;
  }

  /**
   * A side model for a turn WrongForge does not lead. `explicitOnly` (a side
   * request through `complete()`) takes only the model the user named in
   * `acp.leader.sideModel`: WrongForge answers those itself (`oneShot`), and
   * handing them to `fallbackModels[0]` let that model take over the session.
   * A worker's turn may still fall back to the fallback chain, since `oneShot`
   * would leave it without tools.
   */
  private sideProvider(explicitOnly = false): { provider: Provider; model: string } | undefined {
    const config = this.config();
    const ref = explicitOnly ? explicitLeaderSideModel(config) : leaderSideModel(config);
    if (!ref || ref.provider === this.id) return undefined;
    let provider = this.sideProviders.get(ref.provider);
    if (!provider) {
      provider = this.opts.buildProvider(ref.provider, config);
      if (provider) this.sideProviders.set(ref.provider, provider);
    }
    return provider ? { provider, model: ref.model } : undefined;
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const side = this.sideProvider(true);
    if (side) return side.provider.complete({ ...req, model: side.model }, opts);
    return this.oneShot(req, opts.signal);
  }

  /** WrongForge as a plain model: one step, no tools, its own throwaway session. */
  private async oneShot(req: Request, signal: AbortSignal): Promise<Response> {
    const call = this.client();
    try {
      const info = await this.info(call, signal);
      const model = this.model(req.model, info);
      const host = acpLeaderHost();
      const { task } = await call<{ task: WfTaskRecord }>(
        'POST',
        '/v1/tasks',
        {
          prompt: flatten(req),
          workdir: host?.projectRoot ?? process.cwd(),
          ...(model ? { model } : {}),
          max_steps: 1,
          builtin_tools: [],
          ...wrongForgeRuntime(req.reasoning, req.cache, info),
          wait: true,
          cancel_on_disconnect: true,
        },
        signal,
      );
      const failure = taskError(task, this.id);
      if (failure) throw failure;
      const usage = wfTokens(task.result?.usage);
      return {
        model: model ?? req.model,
        content: [{ type: 'text', text: task.result?.text ?? '' }],
        stopReason: 'end_turn',
        usage,
      };
    } catch (err) {
      throw providerError(err, this.id);
    } finally {
      void reportWrongForgeQuota({ providerId: this.id, fetchImpl: this.opts.fetchImpl });
    }
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    if (!isLeaderTurn(req)) {
      const side = this.sideProvider();
      if (side) {
        yield* side.provider.stream({ ...req, model: side.model }, opts);
        return;
      }
      const res = await this.complete(req, opts);
      yield { type: 'message_start', model: res.model };
      const text = res.content.map((b) => ('text' in b ? b.text : '')).join('');
      if (text) {
        yield { type: 'content_block_start', kind: 'text' };
        yield { type: 'text_delta', text };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_stop', stopReason: 'end_turn', usage: res.usage };
      return;
    }

    const call = this.client();
    const host = acpLeaderHost();
    const key = req.cache?.sessionId ?? 'default';
    const leader = this.sessionFor(key);
    let info: WrongForgeInfo | undefined;
    let model: string | undefined;
    let gateway: LeaderGateway | undefined;
    let joinedBefore: boolean;
    try {
      info = await this.info(call, opts.signal);
      model = this.model(req.model, info);
      if (host && !leader.gateway) {
        leader.gateway = startLeaderGateway(host, key).catch(() => {
          leader.gateway = undefined;
          return undefined;
        });
      }
      gateway = await leader.gateway;
      if (!gateway) {
        leader.gateway = undefined;
      }
      joinedBefore = leader.joined ?? (await this.wfSessionExists(call, leader, opts.signal));
    } catch (err) {
      throw providerError(err, this.id);
    }
    const routed = gateway !== undefined && (info?.features.includes('builtin_tools') ?? false);

    const queue = new StreamQueue();
    const blocks = new TextBlocks(queue);
    const cards = new ToolCardRelay(host?.events, {
      sessionId: req.cache?.sessionId,
      model: model ?? req.model,
      provider: this.id,
    });

    yield { type: 'message_start', model: model ?? req.model };
    let taskId: string | undefined;
    const onAbort = () => {
      if (taskId) cancelTask(call, taskId, 'interrupted in WrongStack');
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const run = (async () => {
      const { task } = await call<{ task: WfTaskRecord }>(
        'POST',
        '/v1/tasks',
        {
          prompt: this.promptText(req, joinedBefore, gateway),
          session_id: leader.wfSessionId,
          workdir: host?.projectRoot ?? process.cwd(),
          ...(model ? { model } : {}),
          max_steps: LEADER_MAX_STEPS,
          timeout_ms: LEADER_TURN_TIMEOUT_MS,
          ...wrongForgeRuntime(req.reasoning, req.cache, info),
          system_append: leaderAppend(routed, gateway?.tools ?? []),
          context: { wrongstack: { sessionId: key, role: 'leader' } },
          ...(gateway ? { gateway: { ...gateway.spec, optional: !routed } } : {}),
          ...(routed ? { builtin_tools: WRONGFORGE_READ_SIDE_TOOLS } : {}),
        },
        opts.signal,
      );
      taskId = task.id;
      leader.joined = true;
      if (opts.signal.aborted) {
        cancelTask(call, taskId, 'interrupted in WrongStack');
        throw new WfAborted();
      }
      for await (const ev of followTask(call, task.id, opts.signal)) {
        if (ev.type === 'task.heartbeat' || ev.type === 'step.finished') {
          void reportWrongForgeQuota({ providerId: this.id, fetchImpl: this.opts.fetchImpl });
        }
        // `wstack_*` calls are the session's own tool calls: the gateway
        // settles their cards (`runTool` with `announce`). Only WrongForge's
        // own tools need one here.
        const external = ev.data['external'] === true;
        for (const p of toProgress(ev)) {
          if (p.type === 'message') blocks.text(p.text);
          else if (p.type === 'tool_call') {
            blocks.close();
            if (!external) cards.update(p.toolCall);
          } else if (p.type === 'tool_call_update' && !external) cards.update(p.toolCall);
        }
        if (ev.type === 'step.finished' && typeof ev.data['context_tokens'] === 'number') {
          this.observeContext(leader, req.cache?.sessionId, {
            used: ev.data['context_tokens'],
            size: this.capabilities.maxContext,
          });
        }
      }
      const done = await terminalTaskRecord(call, task.id, opts.signal);
      blocks.close();
      const failure = taskError(done, this.id);
      if (failure) throw failure;
      const window = done.result?.context_window ?? 0;
      if (window > 0) this.capabilities.maxContext = window;
      if (typeof done.result?.context_tokens === 'number') {
        this.observeContext(leader, req.cache?.sessionId, {
          used: done.result.context_tokens,
          size: window,
        });
      }
      queue.push({
        type: 'message_stop',
        stopReason: done.result?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
        usage: wfTokens(done.result?.usage),
        ...(leader.context ? { agentContext: leader.context } : {}),
      });
      queue.end();
    })().catch((err: unknown) => {
      blocks.close();
      queue.fail(providerError(err, this.id));
    });

    try {
      yield* queue.drain();
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      await run;
      void reportWrongForgeQuota({ providerId: this.id, fetchImpl: this.opts.fetchImpl });
    }
  }

  /** The turn's prompt; WrongForge joining a conversation under way gets the turns before it. */
  private promptText(req: Request, joined: boolean, gateway: LeaderGateway | undefined): string {
    const latest = externalSkillDirective(
      latestUserText(req.messages),
      gateway ? externalSkillLoader(gateway.tools, gateway.spec.name_prefix ?? '') : undefined,
    );
    const earlier = joined ? undefined : earlierConversation(req.messages);
    const prompt = earlier ? `${earlier}\n\n${latest}` : latest;
    const context = acpLeaderHost()?.context(req.cache?.sessionId) as Context | undefined;
    const notes = context?.meta ? consumeBtwNotes(context) : [];
    return notes.length > 0 ? `${prompt}\n\n${acpBtwBlock(notes)}` : prompt;
  }

  private async wfSessionExists(
    call: WfCall,
    leader: LeaderSession,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await call(
        'GET',
        `/v1/sessions/${encodeURIComponent(leader.wfSessionId)}`,
        undefined,
        signal,
      );
      return true;
    } catch (err) {
      if (err instanceof WfHttpError && err.status === 404) return false;
      throw err;
    }
  }

  private sessionFor(key: string): LeaderSession {
    let leader = this.sessions.get(key);
    if (!leader) {
      leader = { wfSessionId: `wsl-${safeWfId(key)}` };
      this.sessions.set(key, leader);
    }
    return leader;
  }

  private observeContext(
    leader: LeaderSession,
    sessionId: string | undefined,
    reading: AgentContextUsage,
  ): void {
    leader.context = { used: reading.used, size: reading.size || this.capabilities.maxContext };
    publishLeaderContext(
      acpLeaderHost()?.events,
      sessionId,
      leader.context,
      this.capabilities.maxContext,
    );
  }

  /** `/compact` on this route: WrongForge compacts its own session. */
  async compactOwnContext(opts: {
    sessionId: string;
    signal: AbortSignal;
  }): Promise<AgentContextUsage | undefined> {
    const leader = this.sessions.get(opts.sessionId);
    if (!leader) return undefined;
    const call = this.client();
    try {
      await call(
        'POST',
        `/v1/sessions/${encodeURIComponent(leader.wfSessionId)}/compact`,
        {},
        opts.signal,
      );
    } catch (err) {
      throw providerError(err, this.id);
    }
    // WrongForge measures the compacted context on the next request.
    leader.context = undefined;
    return undefined;
  }

  /** Close every session gateway (process shutdown). */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.gateway?.then((g) => g?.close()).catch(() => undefined)));
  }
}

/**
 * Registered with the provider registry at boot. Inert unless the session
 * names it (`--provider wrongforge`, `/model wrongforge/<model>`).
 */
export function createWrongForgeLeaderProviderFactory(
  opts: Omit<WrongForgeLeaderProviderOptions, 'id'>,
): ProviderFactory {
  return {
    type: WRONGFORGE_LEADER_PROVIDER_ID,
    // Routing metadata only: the provider does no wire conversion.
    family: 'openai-compatible',
    create: (cfg) =>
      new WrongForgeLeaderProvider({
        ...opts,
        id: (cfg as { type?: string }).type || WRONGFORGE_LEADER_PROVIDER_ID,
      }),
  };
}
