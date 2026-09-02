/**
 * First-class local-LLM presets for Ollama, vLLM, and LM Studio.
 *
 * All three speak the OpenAI Chat Completions wire format at `/v1/chat/completions`
 * with SSE streaming, so the bulk of the work is a tuned `WireFormatConfig`. The
 * differences worth modeling:
 *
 *   - Ollama: no auth at all (no `Authorization` header). Supports
 *     `keep_alive` and `num_ctx` request fields. Historically omits `usage`
 *     on the final chunk, so we synthesize a `message_stop` via
 *     `finalizeStream` even when the upstream didn't emit one.
 *   - vLLM: auth is optional (off by default). The server may close the
 *     stream without a `data: [DONE]` sentinel — also handled via
 *     `finalizeStream`.
 *   - LM Studio: optional Bearer auth. Same stream shape as OpenAI, but
 *     `max_tokens` is the accepted field (we always use it via the
 *     `openai-compatible` family quirk).
 *
 * `createLocalLlmPreset` is the single source of truth — the three named
 * exports below are thin wrappers that pick the right defaults.
 */
import type { Request, StopReason, StreamEvent } from '@wrongstack/core/types';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from '../model-output-limits.js';
import { normalizeOpenAI } from '../stop-reason.js';
import { messagesToOpenAI, toolsToOpenAI } from '../tool-format/to-openai.js';
import { defineWireFormat } from '../wire-format.js';

function appendArgChunk(buf: StreamingArgBuffer, chunk: string): void {
  if (chunk.length === 0) return;
  buf.chunks.push(chunk);
  buf.length += chunk.length;
}

function joinArgBuffer(buf: StreamingArgBuffer): string {
  return buf.chunks.length === 1 ? (buf.chunks[0] ?? '') : buf.chunks.join('');
}

export interface LocalLlmPresetOptions {
  /** Provider id used for logging and the registry (e.g. 'ollama'). */
  id: string;
  /** Default base URL when the user doesn't override. */
  defaultBaseUrl: string;
  /**
   * When true, the request is sent with no `Authorization` header. Use for
   * servers that reject any Authorization value (Ollama without auth).
   * When false/undefined, a `Bearer <apiKey>` header is sent (any non-empty
   * key is fine for servers that have auth disabled).
   */
  noAuth?: boolean | undefined;
  /**
   * Provider-specific request body extras. Keys here are merged into the
   * outgoing JSON body verbatim. Use for things like Ollama's `keep_alive`
   * or vLLM's `repetition_penalty`. Values that collide with canonical
   * fields (`model`, `messages`, `tools`, `stream`, `max_tokens`, …) are
   * dropped — canonical wins.
   */
  bodyExtras?: Record<string, unknown> | undefined;
  /** Default context window — surfaced via `capabilities.maxContext`. */
  maxContext?: number | undefined;
  /**
   * Whether the model advertises vision input. Local vision models are
   * rare but Ollama supports them via multimodal tags; default false.
   */
  vision?: boolean | undefined;
}

interface StreamingArgBuffer {
  chunks: string[];
  length: number;
}

interface LocalLlmStreamToolState {
  id?: string | undefined;
  name?: string | undefined;
  argBuf: StreamingArgBuffer;
  emittedStart: boolean;
  emittedChunkIndex: number;
}

interface LocalLlmStreamState {
  model: string;
  started: boolean;
  textOpen: boolean;
  thinkingOpen: boolean;
  toolByIndex: Map<number, LocalLlmStreamToolState>;
  usage: { input: number; output: number };
  stopReason: StopReason;
  /** Tracks whether the upstream emitted a terminal `data: [DONE]` or `finish_reason`. */
  endedNaturally: boolean;
  finalEmitted: boolean;
}

/**
 * Canonical fields produced by `buildBody` — anything in `bodyExtras` that
 * collides with one of these is dropped so we never let a per-provider
 * override silently shadow the canonical request shape.
 */
const CANONICAL_BODY_KEYS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'stream_options',
  'max_tokens',
  'temperature',
  'top_p',
  'stop',
]);

export function createLocalLlmPreset(opts: LocalLlmPresetOptions) {
  const bodyExtras = opts.bodyExtras ?? {};
  const vision = opts.vision ?? false;

  return defineWireFormat<LocalLlmStreamState>({
    id: opts.id,
    // `openai-compatible` so the family-based capability defaults apply
    // (correct token-limit param, no prompt cache, etc.).
    family: 'openai-compatible',
    capabilities: capabilitiesForFamily('openai-compatible', {
      vision,
      streaming: true,
      maxContext: opts.maxContext ?? 8_192,
    }),
    defaultBaseUrl: opts.defaultBaseUrl,
    buildUrl: (base) => {
      const b = base.replace(/\/+$/, '');
      if (/\/chat\/completions$/.test(b)) return b;
      if (/\/v\d+(\/[a-z0-9_-]+)*$/i.test(b)) return `${b}/chat/completions`;
      return `${b}/v1/chat/completions`;
    },
    buildHeaders: (apiKey) => {
      if (opts.noAuth) return {};
      // Send a Bearer header regardless of whether the key is real —
      // vLLM and LM Studio only check for the header's presence when auth
      // is enabled. Use a placeholder if the caller didn't supply one.
      return { authorization: `Bearer ${apiKey || 'no-key'}` };
    },
    buildBody: (req: Request, ctx: BuildBodyContext) => {
      const maxOutput = resolveMaxOutputTokens(req, ctx);
      const body: Record<string, unknown> = {
        model: req.model,
        messages: messagesToOpenAI(req.system, req.messages),
        stream: true,
      };
      // Optional field — omit rather than guess. Local runtimes size the
      // response from the loaded model's own config when it is absent.
      if (maxOutput !== undefined) body['max_tokens'] = maxOutput;
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
      if (req.stopSequences) body['stop'] = req.stopSequences;
      // Per-provider extras, but never let them shadow canonical fields.
      for (const [k, v] of Object.entries(bodyExtras)) {
        if (CANONICAL_BODY_KEYS.has(k)) continue;
        body[k] = v;
      }
      return body;
    },
    createStreamState: (fallbackModel) => ({
      model: fallbackModel,
      started: false,
      textOpen: false,
      thinkingOpen: false,
      toolByIndex: new Map(),
      usage: { input: 0, output: 0 },
      stopReason: 'end_turn',
      endedNaturally: false,
      finalEmitted: false,
    }),
    parseStreamEvent: (msg, state): StreamEvent[] => {
      if (!msg.data || msg.data === '[DONE]') {
        if (msg.data === '[DONE]') state.endedNaturally = true;
        return [];
      }
      const parsed = safeParse<Record<string, unknown>>(msg.data);
      if (!parsed.ok || !parsed.value) return [];
      const obj = parsed.value;
      const out: StreamEvent[] = [];

      if (typeof obj['model'] === 'string') state.model = obj['model'] as string;
      if (!state.started) {
        state.started = true;
        out.push({ type: 'message_start', model: state.model });
      }

      const choices = obj['choices'] as
        | Array<{
            delta?: {
              content?: string | null | undefined;
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

      if (choice?.delta?.content) {
        if (state.thinkingOpen) {
          state.thinkingOpen = false;
          out.push({ type: 'thinking_stop' });
        }
        if (!state.textOpen) state.textOpen = true;
        out.push({ type: 'text_delta', text: choice.delta.content });
      }

      if (choice?.delta?.tool_calls) {
        if (state.thinkingOpen) {
          state.thinkingOpen = false;
          out.push({ type: 'thinking_stop' });
        }
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index ?? 0;
          let entry = state.toolByIndex.get(idx);
          if (!entry) {
            entry = {
              id: tc.id,
              name: tc.function?.name,
              argBuf: { chunks: [], length: 0 },
              emittedStart: false,
              emittedChunkIndex: 0,
            };
            state.toolByIndex.set(idx, entry);
          } else {
            if (tc.id && !entry.id) entry.id = tc.id;
            if (tc.function?.name && !entry.name) entry.name = tc.function.name;
          }
          if (tc.function?.arguments) {
            appendArgChunk(entry.argBuf, tc.function.arguments);
          }
          if (!entry.emittedStart && entry.id && entry.name) {
            entry.emittedStart = true;
            state.textOpen = false;
            out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
          }
          if (
            entry.emittedStart &&
            entry.id &&
            entry.emittedChunkIndex < entry.argBuf.chunks.length
          ) {
            for (
              ;
              entry.emittedChunkIndex < entry.argBuf.chunks.length;
              entry.emittedChunkIndex++
            ) {
              out.push({
                type: 'tool_use_input_delta',
                id: entry.id,
                partial: entry.argBuf.chunks[entry.emittedChunkIndex] ?? '',
              });
            }
          }
        }
      }

      if (choice?.finish_reason) {
        state.stopReason = normalizeOpenAI(choice.finish_reason);
        state.endedNaturally = true;
      }

      const u = obj['usage'] as
        | { prompt_tokens?: number | undefined; completion_tokens?: number | undefined }
        | undefined;
      if (u) {
        state.usage = {
          input: u.prompt_tokens ?? state.usage.input,
          output: u.completion_tokens ?? state.usage.output,
        };
      }

      return out;
    },
    finalizeStream: (state): StreamEvent[] => {
      if (state.finalEmitted) return [];
      state.finalEmitted = true;
      const out: StreamEvent[] = [];
      if (state.thinkingOpen) {
        state.thinkingOpen = false;
        out.push({ type: 'thinking_stop' });
      }
      for (const entry of state.toolByIndex.values()) {
        if (!entry.id || !entry.name) continue;
        if (!entry.emittedStart) {
          out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
        }
        out.push({
          type: 'tool_use_stop',
          id: entry.id,
          input: parseToolInput(joinArgBuffer(entry.argBuf)),
        });
      }
      // Even when the upstream emitted a clean stop, synthesize a
      // canonical `message_stop` if it didn't. Local servers vary:
      // Ollama omits `usage` and sometimes the terminal `data: [DONE]`;
      // vLLM may close the connection without `[DONE]`. Synthesizing
      // here means consumers can always rely on a single `message_stop`
      // arriving per stream.
      if (state.started) {
        out.push({
          type: 'message_stop',
          stopReason: state.stopReason,
          usage: state.usage,
        });
      }
      return out;
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Named presets                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ollama — https://ollama.com
 *
 * Runs on `http://localhost:11434` by default and exposes an OpenAI-compatible
 * chat-completions endpoint at `/v1/chat/completions`. Ollama rejects any
 * `Authorization` header (it returns 400), so we send none. Ollama also
 * accepts the `keep_alive` body field (e.g. `"5m"`, `"-1"` for indefinite)
 * to control how long the model stays loaded in memory.
 */
export const ollamaWireFormat = createLocalLlmPreset({
  id: 'ollama',
  defaultBaseUrl: 'http://localhost:11434/v1',
  noAuth: true,
  bodyExtras: {
    // Default to keeping the model resident for 5 minutes; users can override
    // via `cfg.bodyExtras` on their provider config.
    keep_alive: '5m',
  },
  maxContext: 8_192,
});

/**
 * vLLM — https://docs.vllm.ai
 *
 * Default server URL is `http://localhost:8000/v1`. Auth is disabled by
 * default in vLLM; if enabled, it expects a `Bearer <key>` header. vLLM
 * passes the legacy `max_tokens` parameter through correctly and supports
 * OpenAI-style tool calls.
 */
export const vllmWireFormat = createLocalLlmPreset({
  id: 'vllm',
  defaultBaseUrl: 'http://localhost:8000/v1',
  maxContext: 32_768,
});

/**
 * LM Studio — https://lmstudio.ai
 *
 * Default server URL is `http://localhost:1234/v1`. LM Studio's local
 * server mirrors the OpenAI Chat Completions API exactly, with optional
 * Bearer auth.
 */
export const lmstudioWireFormat = createLocalLlmPreset({
  id: 'lmstudio',
  defaultBaseUrl: 'http://localhost:1234/v1',
  maxContext: 8_192,
});
