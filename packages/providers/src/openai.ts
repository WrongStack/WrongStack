import { randomUUID } from 'node:crypto';
import type {
  Capabilities,
  Request,
  ResponseFormat,
  StopReason,
  StreamEvent,
  Usage,
} from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from './_tool-input.js';
import { type HeadersLike, parseProviderHttpError } from './error-parse.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from './model-output-limits.js';
import { shouldEmitReasoningEffort } from './openai-shared.js';
import { applyPromptCacheKey } from './prompt-cache-key.js';
import { parseSSE } from './sse.js';
import { normalizeOpenAI } from './stop-reason.js';
import { type ConvertOptions, messagesToOpenAI, toolsToOpenAI } from './tool-format/to-openai.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

interface StreamingArgBuffer {
  chunks: string[];
  length: number;
}

function appendArgChunk(buf: StreamingArgBuffer, chunk: string): void {
  if (chunk.length === 0) return;
  buf.chunks.push(chunk);
  buf.length += chunk.length;
}

function joinArgBuffer(buf: StreamingArgBuffer): string {
  return buf.chunks.length === 1 ? (buf.chunks[0] ?? '') : buf.chunks.join('');
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  organization?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  quirks?:
    | (ConvertOptions & {
        parallelToolsDisabled?: boolean | undefined;
        thinkingParam?: 'zai-glm' | 'kimi-toggle' | 'always-on' | undefined;
        stripThinkTags?: boolean | undefined;
        maxTools?: number | undefined;
        tolerateMissingTerminalMarker?: boolean | undefined;
      })
    | undefined;
  id?: string | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  /** Raw stream debugging and hang-detection options. */
  streamOpts?: WireAdapterStreamOptions | undefined;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';

export class OpenAIProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  protected readonly opts: OpenAIProviderOptions;

  constructor(opts: OpenAIProviderOptions) {
    super(opts.apiKey, opts.baseUrl ?? DEFAULT_BASE, opts.fetchImpl, opts.streamOpts);
    this.opts = opts;
    this.id = opts.id ?? 'openai';
    this.capabilities = capabilitiesForFamily('openai', {
      parallelTools: !opts.quirks?.parallelToolsDisabled,
      systemPrompt: !opts.quirks?.systemAsMessage,
      ...opts.capabilities,
    });
    if (opts.quirks?.maxTools && opts.quirks.maxTools > 0) {
      this.maxToolsCount = opts.quirks.maxTools;
    }
  }

  protected override buildUrl(_req: Request): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v\d+(\/[a-z0-9_-]+)*$/i.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      ...super.buildHeaders(req),
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.opts.organization) {
      headers['openai-organization'] = this.opts.organization;
    }
    return headers;
  }

  /**
   * The request field used to cap output length. Real OpenAI deprecated
   * `max_tokens` and the newer model families (gpt-4o, o1/o3/o4) 400 on it —
   * they require `max_completion_tokens`. OpenAI-compatible endpoints that
   * still only accept `max_tokens` override this. See issue #10.
   */
  protected tokenLimitParam(): string {
    return 'max_completion_tokens';
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    const maxOutput = resolveMaxOutputTokens(req, ctx);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(this.stripCacheControl(req), req.messages, {
        ...this.opts.quirks,
      }),
      stream: true,
      stream_options: { include_usage: true },
    };
    // Optional field: omitted when neither the caller, the catalog nor the
    // capability overlay knows this model's ceiling, so the backend applies
    // its own maximum rather than a literal invented here.
    if (maxOutput !== undefined) body[this.tokenLimitParam()] = maxOutput;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToOpenAI(req.tools);
      if (req.toolChoice) {
        if (typeof req.toolChoice === 'string') {
          body['tool_choice'] = req.toolChoice === 'required' ? 'required' : req.toolChoice;
        } else {
          body['tool_choice'] = {
            type: 'function',
            function: { name: req.toolChoice.name },
          };
        }
      }
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.frequencyPenalty !== undefined) body['frequency_penalty'] = req.frequencyPenalty;
    if (req.presencePenalty !== undefined) body['presence_penalty'] = req.presencePenalty;
    if (req.seed !== undefined) body['seed'] = req.seed;
    if (req.user) body['user'] = req.user;
    applyPromptCacheKey(body, req, ctx?.capabilities);
    if (req.logprobs === true) {
      body['logprobs'] = true;
      if (req.topLogprobs !== undefined) body['top_logprobs'] = req.topLogprobs;
    }
    if (req.stopSequences) body['stop'] = req.stopSequences;
    if (shouldEmitReasoningEffort(req)) {
      body['reasoning_effort'] = req.reasoning?.effort;
    }
    if (req.responseFormat) {
      body['response_format'] = responseFormatToOpenAI(req.responseFormat);
    }
    return body;
  }

  protected override parseStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseOpenAIStream(body, fallbackModel, {
      stripThinkTags: this.opts.quirks?.stripThinkTags,
      providerId: this.id,
      tolerateMissingTerminalMarker: this.opts.quirks?.tolerateMissingTerminalMarker,
    });
  }

  protected override translateError(
    status: number,
    text: string,
    headers?: HeadersLike,
  ): ProviderError {
    return parseProviderHttpError(this.id, status, text, headers);
  }

  private stripCacheControl(req: Request): typeof req.system {
    if (!req.system) return undefined;
    return req.system.map((b) => {
      // Omit cache_control without mutating a copy — rest spread is cleaner.
      const { cache_control: _cc, ...rest } = b;
      return rest;
    });
  }
}

/**
 * Translate a canonical `ResponseFormat` to OpenAI's `response_format` body field.
 *
 *   text        → { type: 'text' }
 *   json_object → { type: 'json_object' }
 *   json_schema → { type: 'json_schema', json_schema: { name, strict, schema } }
 */
function responseFormatToOpenAI(fmt: ResponseFormat): Record<string, unknown> {
  if (fmt.type === 'text') return { type: 'text' };
  if (fmt.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: fmt.jsonSchema.name,
      strict: fmt.jsonSchema.strict ?? true,
      schema: fmt.jsonSchema.schema,
      ...(fmt.jsonSchema.description ? { description: fmt.jsonSchema.description } : {}),
    },
  };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

interface ThinkSegment {
  kind: 'text' | 'thinking';
  text: string;
}

/** Length of the longest suffix of `s` that is a *proper* prefix of a think
 *  tag — i.e. the run we must hold back in case a tag is split across SSE
 *  frames (`</thi` + `nk>`). Returns 0 when nothing needs holding. */
function trailingTagPrefixLen(s: string): number {
  const max = Math.min(s.length, THINK_CLOSE.length - 1);
  for (let k = max; k >= 1; k--) {
    const suf = s.slice(s.length - k);
    if (
      (THINK_OPEN.startsWith(suf) && suf.length < THINK_OPEN.length) ||
      (THINK_CLOSE.startsWith(suf) && suf.length < THINK_CLOSE.length)
    ) {
      return k;
    }
  }
  return 0;
}

/**
 * Streaming filter that lifts literal `<think>…</think>` blocks out of the
 * `content` channel. Some OpenAI-compatible proxies (omniroute, LiteLLM, …)
 * fold a reasoning model's hidden thinking into `content` as literal think
 * tags, and frequently leak a *stray* closing `</think>` with no opener when
 * the thinking body itself is suppressed. Left untouched the tag pollutes the
 * visible assistant message (e.g. `</think>The answer…`).
 *
 * `push()` returns ordered segments tagged text|thinking with the tags
 * removed; a stray `</think>` outside a think block is dropped. A partial tag
 * at the chunk boundary is held back until the next chunk (or `flush()` at
 * stream end), so a tag split across frames is still recognised.
 */
class ThinkTagFilter {
  private mode: 'text' | 'thinking' = 'text';
  private carry = '';

  push(chunk: string): ThinkSegment[] {
    const buf = this.carry + chunk;
    this.carry = '';
    const out: ThinkSegment[] = [];
    let segStart = 0;
    let i = 0;
    const emit = (end: number): void => {
      if (end > segStart) out.push({ kind: this.mode, text: buf.slice(segStart, end) });
    };
    while (i < buf.length) {
      if (this.mode === 'text') {
        if (buf.startsWith(THINK_OPEN, i)) {
          emit(i);
          this.mode = 'thinking';
          i += THINK_OPEN.length;
          segStart = i;
          continue;
        }
        if (buf.startsWith(THINK_CLOSE, i)) {
          // Stray closing tag (proxy leaked it with no opener) — drop it.
          emit(i);
          i += THINK_CLOSE.length;
          segStart = i;
          continue;
        }
      } else if (buf.startsWith(THINK_CLOSE, i)) {
        emit(i);
        this.mode = 'text';
        i += THINK_CLOSE.length;
        segStart = i;
        continue;
      }
      i += 1;
    }
    // Hold back a trailing run that could be the prefix of a tag spanning chunks.
    const tail = buf.slice(segStart);
    const hold = trailingTagPrefixLen(tail);
    if (hold > 0) {
      const cut = tail.length - hold;
      if (cut > 0) out.push({ kind: this.mode, text: tail.slice(0, cut) });
      this.carry = tail.slice(cut);
    } else if (tail) {
      out.push({ kind: this.mode, text: tail });
    }
    return out;
  }

  /** A held-back partial that never completed is literal text of the open mode. */
  flush(): ThinkSegment[] {
    if (!this.carry) return [];
    const seg: ThinkSegment = { kind: this.mode, text: this.carry };
    this.carry = '';
    return [seg];
  }
}

type Response2Body = ReadableStream<Uint8Array> | NodeJS.ReadableStream | null;

/**
 * Translate an OpenAI /chat/completions SSE stream into canonical StreamEvent[].
 *
 * Wire format per chunk:
 *   data: {"id":"...","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{"index":0,"delta":{"tool_calls":[
 *           {"index":0,"id":"call_x","function":{"name":"echo","arguments":"{\"text\":"}}]},"finish_reason":null}]}
 *   data: {"id":"...","choices":[{...,"finish_reason":"stop"}],"usage":{"prompt_tokens":12,...}}
 *   data: [DONE]
 *
 * Tool calls stream as a sequence of partial fragments keyed by their
 * `index` in the delta array; we map index → canonical tool_use id from
 * the first chunk that carries one.
 */
async function* parseOpenAIStream(
  body: Response2Body,
  fallbackModel: string,
  opts?: {
    stripThinkTags?: boolean | undefined;
    providerId?: string | undefined;
    tolerateMissingTerminalMarker?: boolean | undefined;
  },
): AsyncIterable<StreamEvent> {
  let model = fallbackModel;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let started = false;
  // Whether a proper end-of-stream marker (`[DONE]` or a `finish_reason`) was
  // seen. If the upstream closes without one after we started receiving, the
  // response was cut mid-stream and must surface as retryable — not a clean
  // end_turn over truncated content.
  let sawTerminal = false;
  let textOpen = false;
  let thinkingOpen = false;
  const thinkFilter = opts?.stripThinkTags ? new ThinkTagFilter() : null;
  // Emit content segments, routing tag-wrapped text to the thinking channel and
  // toggling the shared text/thinking open-state. Mirrors the reasoning_content
  // path below so both can interleave coherently.
  function* emitContentSegments(segs: ThinkSegment[]): Generator<StreamEvent> {
    for (const seg of segs) {
      if (!seg.text) continue;
      if (seg.kind === 'thinking') {
        if (!thinkingOpen) {
          thinkingOpen = true;
          yield { type: 'thinking_start' };
        }
        textOpen = false;
        yield { type: 'thinking_delta', text: seg.text };
      } else {
        if (thinkingOpen) {
          thinkingOpen = false;
          yield { type: 'thinking_stop' };
        }
        if (!textOpen) textOpen = true;
        yield { type: 'text_delta', text: seg.text };
      }
    }
  }
  const toolByIndex = new Map<
    number,
    {
      id?: string | undefined;
      name?: string | undefined;
      argBuf: StreamingArgBuffer;
      emittedStart: boolean;
      emittedChunkIndex: number;
    }
  >();

  for await (const msg of parseSSE(body)) {
    if (msg.data === '[DONE]') {
      sawTerminal = true;
      continue;
    }
    if (!msg.data) continue;
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const obj = parsed.value;

    if (typeof obj['model'] === 'string') model = obj['model'];
    if (!started) {
      started = true;
      yield { type: 'message_start', model };
    }

    const choices = obj['choices'] as
      | Array<{
          delta?: {
            content?: string | null | undefined;
            reasoning_content?: string | undefined;
            reasoning?: string | undefined;
            tool_calls?: Array<{
              index?: number | undefined;
              id?: string | undefined;
              function?: { name?: string | undefined; arguments?: string | undefined };
            }>;
          };
          finish_reason?: string | null | undefined;
        }>
      | undefined;
    const choice = choices?.[0];

    // DeepSeek (and Moonshot/Kimi thinking mode) stream chain-of-thought
    // as `delta.reasoning_content` at the top of the delta. The full blob
    // MUST be echoed back as message-level `reasoning_content` on the
    // next request — otherwise DeepSeek 400s with "reasoning_content in
    // the thinking mode must be passed back to the API".
    // OpenRouter sometimes uses `delta.reasoning` for the same field.
    const reasoningDelta =
      typeof choice?.delta?.reasoning_content === 'string'
        ? choice.delta.reasoning_content
        : typeof choice?.delta?.reasoning === 'string'
          ? choice.delta.reasoning
          : undefined;
    if (reasoningDelta && reasoningDelta.length > 0) {
      if (!thinkingOpen) {
        thinkingOpen = true;
        yield { type: 'thinking_start' };
      }
      yield { type: 'thinking_delta', text: reasoningDelta };
    }

    if (choice?.delta?.content) {
      if (thinkFilter) {
        yield* emitContentSegments(thinkFilter.push(choice.delta.content));
      } else {
        if (thinkingOpen) {
          thinkingOpen = false;
          yield { type: 'thinking_stop' };
        }
        if (!textOpen) textOpen = true;
        yield { type: 'text_delta', text: choice.delta.content };
      }
    }

    if (choice?.delta?.tool_calls) {
      // Flush any text held back by the think-tag filter before a tool call —
      // content always precedes tool_calls in the chat-completions wire format.
      if (thinkFilter) yield* emitContentSegments(thinkFilter.flush());
      if (thinkingOpen) {
        thinkingOpen = false;
        yield { type: 'thinking_stop' };
      }
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolByIndex.get(idx);
        if (!entry) {
          entry = {
            id: tc.id,
            name: tc.function?.name,
            argBuf: { chunks: [], length: 0 },
            emittedStart: false,
            emittedChunkIndex: 0,
          };
          toolByIndex.set(idx, entry);
        } else {
          if (tc.id && !entry.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          appendArgChunk(entry.argBuf, tc.function.arguments);
        }
        if (!entry.emittedStart && entry.id && entry.name) {
          entry.emittedStart = true;
          textOpen = false;
          yield { type: 'tool_use_start', id: entry.id, name: entry.name };
        }
        if (
          entry.emittedStart &&
          entry.id &&
          entry.emittedChunkIndex < entry.argBuf.chunks.length
        ) {
          for (; entry.emittedChunkIndex < entry.argBuf.chunks.length; entry.emittedChunkIndex++) {
            yield {
              type: 'tool_use_input_delta',
              id: entry.id,
              partial: entry.argBuf.chunks[entry.emittedChunkIndex] ?? '',
            };
          }
        }
      }
    }

    if (choice?.finish_reason) {
      stopReason = normalizeOpenAI(choice.finish_reason);
      sawTerminal = true;
    }

    const u = obj['usage'] as
      | {
          prompt_tokens?: number | undefined;
          input_tokens?: number | undefined;
          completion_tokens?: number | undefined;
          total_tokens?: number | undefined;
          prompt_tokens_details?: {
            cached_tokens?: number | undefined;
            cache_write_tokens?: number | undefined;
          };
          prompt_cache_hit_tokens?: number | undefined;
          prompt_cache_miss_tokens?: number | undefined;
        }
      | undefined;
    if (u) {
      // Normalize to disjoint semantics: `input` is fresh-only (priced at
      // the full rate), `cacheRead` is the cached subset (priced at the
      // cache rate). OpenAI returns `prompt_tokens_details.cached_tokens`;
      // DeepSeek returns `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`.
      const hasDeepSeekCacheFields =
        u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
      const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
      const completion = u.completion_tokens ?? usage.output;
      // MiniMax's OpenAI-compatible API formally guarantees only `total_tokens`
      // in its streamed usage (prompt_tokens/completion_tokens are documented as
      // examples, not required), so its final chunk can carry total+completion
      // without a `prompt_tokens` field. Deriving prompt = total − completion
      // recovers the input count instead of leaving it stuck at 0 (which zeroed
      // the context meter and the ↑ sent-token counter). Ordered AFTER the
      // explicit prompt fields so no compliant provider regresses.
      const hasPromptTotal = u.prompt_tokens !== undefined;
      const hasFreshInputDelta = !hasPromptTotal && u.input_tokens !== undefined;
      const reportedPromptTotal = hasPromptTotal
        ? (u.prompt_tokens ?? 0)
        : hasDeepSeekCacheFields
          ? (u.prompt_cache_hit_tokens ?? 0) + (u.prompt_cache_miss_tokens ?? 0)
          : u.total_tokens !== undefined
            ? Math.max(0, u.total_tokens - completion)
            : usage.input + cached + cacheWrite;
      // Hybrid gateways sometimes use Anthropic/MiniMax delta semantics in
      // an OpenAI-shaped usage object: input_tokens is fresh-only, while
      // prompt_tokens (when present) is the OpenAI total including cache.
      const promptTotal =
        hasPromptTotal && cached > reportedPromptTotal
          ? reportedPromptTotal + cached
          : reportedPromptTotal;
      const nextUsage: Usage = {
        input:
          u.prompt_cache_miss_tokens ??
          (hasFreshInputDelta
            ? Math.max(0, u.input_tokens ?? 0)
            : Math.max(0, promptTotal - cached - cacheWrite)),
        output: completion,
        cacheRead: cached || usage.cacheRead,
      };
      if (cacheWrite || usage.cacheWrite !== undefined) {
        nextUsage.cacheWrite = cacheWrite || usage.cacheWrite;
      }
      usage = nextUsage;
    }
  }

  if (thinkFilter) {
    yield* emitContentSegments(thinkFilter.flush());
  }
  if (thinkingOpen) {
    yield { type: 'thinking_stop' };
  }
  for (const entry of toolByIndex.values()) {
    // A tool call with no name is unusable — there's nothing to dispatch to.
    if (!entry.name) continue;
    // Some OpenAI-compatible servers (proxies, local runtimes) omit the
    // `id` field on streamed tool calls entirely. Dropping the call here
    // would silently swallow the model's action; synthesize a stable id so
    // it still dispatches and correlates with its tool_result. Mirrors the
    // Google adapter, which always assigns an id.
    if (!entry.id) entry.id = `call_${randomUUID()}`;
    if (!entry.emittedStart) {
      yield { type: 'tool_use_start', id: entry.id, name: entry.name };
    }
    const input = parseToolInput(joinArgBuffer(entry.argBuf));
    yield { type: 'tool_use_stop', id: entry.id, input };
  }
  if (started && !sawTerminal) {
    // Content arrived, then the upstream closed with no `[DONE]` and no
    // `finish_reason` — a clean proxy/LB idle-timeout FIN. Surface a retryable
    // error rather than committing the truncated text as a finished turn.
    if (opts?.tolerateMissingTerminalMarker) {
      // Gateways such as OpenCode Go Zen close a *successful* chat-completions
      // stream without a terminal marker. Synthesize the normal completion so
      // the turn is committed instead of failing every response; tool calls
      // were already emitted above.
      yield { type: 'message_stop', stopReason, usage };
      return;
    }
    throw new ProviderError(
      'Provider stream ended without a terminal marker ([DONE]/finish_reason) — response truncated mid-stream',
      599,
      true,
      opts?.providerId ?? 'openai',
      { body: { message: 'stream truncated before completion' } },
    );
  }
  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}
