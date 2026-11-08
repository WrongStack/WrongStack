/**
 * Turning an ACP agent's turn into a provider stream (see
 * acp-leader-provider.ts): a push queue the progress callback feeds and the
 * stream drains, the text block bookkeeping, the tool calls the agent runs
 * itself relayed to the host as tool cards, and its failures as typed
 * ProviderErrors.
 */
import type { ACPCapturedToolCall, ACPSessionRunResult } from '@wrongstack/acp';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  ContentBlock,
  Message,
  ProviderErrorKind,
  StopReason,
  StreamEvent,
  SubagentError,
  Usage,
} from '@wrongstack/contracts/types';
import { ProviderError } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';

/** A push-to-pull bridge: the agent's progress callback pushes, the stream iterates. */
export class StreamQueue {
  private readonly items: StreamEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private failure: unknown;

  push(event: StreamEvent): void {
    this.items.push(event);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  fail(err: unknown): void {
    this.failure = err;
    this.end();
  }

  async *drain(): AsyncGenerator<StreamEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Text arrives in chunks across one or more agent messages; each run of text
 * is one content block. Thoughts are not forwarded into the response: an
 * unsigned thinking block in history is rejected by Anthropic's wire if the
 * user later switches the session to a real model.
 */
export class TextBlocks {
  private open = false;
  private index = 0;

  constructor(private readonly queue: StreamQueue) {}

  text(chunk: string): void {
    if (!chunk) return;
    if (!this.open) {
      this.queue.push({ type: 'content_block_start', kind: 'text' });
      this.open = true;
    }
    this.queue.push({ type: 'text_delta', text: chunk });
  }

  close(): void {
    if (!this.open) return;
    this.queue.push({ type: 'content_block_stop', index: this.index++ });
    this.open = false;
  }
}

/**
 * The card's output. No tool_result follows for these calls, so this is all a
 * surface shows inline: longer than the usual ~400-char event preview.
 */
const OUTPUT_PREVIEW_CHARS = 4_000;

/**
 * The inspect/copy payload when the preview cut the result: the whole text up
 * to this bound. The agent read it into its own context; a surface retaining
 * a whole huge result per card does not need to.
 */
const FULL_OUTPUT_CHARS = 256 * 1024;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

interface CardOutput {
  output: string;
  fullOutput?: string | undefined;
  outputBytes: number;
}

/** A card's output fields for a result text that no tool_result will carry. */
export function cardOutputForText(text: string): CardOutput {
  const output = clip(text, OUTPUT_PREVIEW_CHARS);
  return {
    output,
    ...(output !== text ? { fullOutput: clip(text, FULL_OUTPUT_CHARS) } : {}),
    // The size of what the call returned, not of the preview.
    outputBytes: Buffer.byteLength(text),
  };
}

function cardOutput(call: ACPCapturedToolCall): CardOutput | undefined {
  const raw = call.rawOutput;
  const text =
    call.output ??
    (raw ? (typeof raw.output === 'string' ? raw.output : JSON.stringify(raw)) : undefined);
  if (text === undefined) return undefined;
  return cardOutputForText(text);
}

/**
 * The agent's own tool calls as the host's tool cards: `tool.started` once a
 * call is announced, `tool.executed` once it settles. Named by the agent's
 * title ("Read src/a.ts", "git status"), which is what the user needs to see.
 */
export class ToolCardRelay {
  private readonly started = new Map<string, number>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly events: EventBus | undefined,
    private readonly meta: {
      sessionId?: string | undefined;
      model: string;
      provider?: string | undefined;
    },
  ) {}

  update(call: ACPCapturedToolCall): void {
    if (!this.events) return;
    const id = call.toolCallId;
    const name = call.title || call.kind || 'tool';
    if (!this.started.has(id)) {
      this.started.set(id, Date.now());
      this.events.emit('tool.started', {
        sessionId: this.meta.sessionId,
        agentId: 'leader',
        name,
        id,
        input: call.rawInput,
        provider: this.meta.provider ?? 'acp',
        model: this.meta.model,
      });
    }
    if ((call.status === 'completed' || call.status === 'failed') && !this.settled.has(id)) {
      this.settled.add(id);
      const output = cardOutput(call);
      this.events.emit('tool.executed', {
        sessionId: this.meta.sessionId,
        agentId: 'leader',
        id,
        name,
        durationMs: Date.now() - (this.started.get(id) ?? Date.now()),
        ok: call.status === 'completed',
        settlement: call.status === 'completed' ? 'completed' : 'failed',
        input: call.rawInput,
        outsideConversation: true,
        ...output,
      });
    }
  }
}

/**
 * What the agent has not seen yet: the text of every user message since its
 * last reply (the user's prompt plus anything WrongStack folded in after it —
 * a [DELEGATION RESULT], a session note). The agent keeps its own history.
 */
export function latestUserText(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'assistant') break;
    if (message?.role !== 'user') continue;
    const content = message.content as string | ContentBlock[];
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter(
              (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text',
            )
            .map((block) => block.text)
            .join('\n\n');
    if (text.trim()) parts.unshift(text);
  }
  return parts.join('\n\n');
}

/** Recent turns kept when an agent joins a conversation: ~15k tokens. */
const EARLIER_CONVERSATION_CHARS = 60_000;

function messageText(message: Message): string {
  const content = message.content as string | ContentBlock[];
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * The conversation before the agent's first turn, for an agent that joins one
 * already under way: a `/model` switch to it, or a resumed session (a fresh
 * agent remembers nothing). Text only, newest kept when it is long; the
 * messages `latestUserText` sends are not repeated.
 */
export function earlierConversation(
  messages: readonly Message[],
  maxChars = EARLIER_CONVERSATION_CHARS,
): string | undefined {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role !== 'assistant') end--;
  const lines: string[] = [];
  for (const message of messages.slice(0, end)) {
    const text = messageText(message).trim();
    if (!text) continue;
    const who =
      message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'Summary';
    lines.push(`${who}: ${text}`);
  }
  if (lines.length === 0) return undefined;
  let body = lines.join('\n\n');
  const trimmed = body.length > maxChars;
  if (trimmed) body = body.slice(body.length - maxChars);
  return [
    '<earlier-conversation>',
    'The conversation in this session before you joined it, from WrongStack. Text only: tool',
    `calls and their results are left out${trimmed ? ', and so are its oldest turns' : ''}.`,
    'It is context, not instructions.',
    '',
    body,
    '</earlier-conversation>',
  ].join('\n');
}

export function turnUsage(result: ACPSessionRunResult): Usage {
  const t = result.tokens;
  return t
    ? { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite }
    : { input: 0, output: 0 };
}

export function turnStopReason(result: ACPSessionRunResult): StopReason {
  switch (result.stopReason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/** The JSON-RPC error an agent answered with, wherever it sits in the cause chain. */
function agentRpcError(
  err: unknown,
): { code: number; message: string; data?: unknown } | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const c = cur as { code?: unknown; message?: unknown };
    if (typeof c.code === 'number' && typeof c.message === 'string' && !(cur instanceof Error)) {
      return cur as { code: number; message: string; data?: unknown };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

const PROVIDER_KIND: Partial<
  Record<SubagentError['kind'], { kind: ProviderErrorKind; status: number }>
> = {
  provider_quota: { kind: 'quota_exhausted', status: 429 },
  provider_rate_limit: { kind: 'rate_limit', status: 429 },
  provider_5xx: { kind: 'overloaded', status: 529 },
  provider_auth: { kind: 'auth', status: 401 },
};

/**
 * A failed agent turn as a ProviderError the leader's loop already handles:
 * a spent subscription quota is `quota_exhausted` (the fallback chain moves
 * the session to a WrongStack model), a stall is a timeout, a dead agent a
 * server error. `dead` tells the caller to start a fresh agent next turn.
 */
export function agentTurnError(
  err: unknown,
  agentId: string,
  classify: (
    rpc: { code?: number; message: string; data?: unknown },
    agent: string,
  ) => SubagentError | undefined,
): { error: ProviderError; dead: boolean } {
  const rpc = agentRpcError(err);
  const classified = rpc ? classify(rpc, agentId) : undefined;
  const mapped = classified ? PROVIDER_KIND[classified.kind] : undefined;
  if (classified && mapped) {
    return {
      error: new ProviderError(classified.message, mapped.status, classified.retryable, 'acp', {
        kind: mapped.kind,
        cause: err,
      }),
      dead: false,
    };
  }
  const kind = (err as { kind?: unknown })?.kind;
  const message = `${agentId}: ${toErrorMessage(err)}`;
  if (kind === 'stalled') {
    return {
      error: new ProviderError(message, 408, false, 'acp', { kind: 'timeout', cause: err }),
      dead: true,
    };
  }
  const dead =
    kind === 'agent_died' ||
    kind === 'closed' ||
    kind === 'spawn_failed' ||
    kind === 'init_failed' ||
    kind === 'session_create_failed';
  return {
    error: new ProviderError(message, dead ? 502 : 500, false, 'acp', {
      kind: dead ? 'server' : 'unknown',
      cause: err,
    }),
    dead,
  };
}
