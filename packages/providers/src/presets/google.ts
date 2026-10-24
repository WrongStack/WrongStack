import { randomUUID } from 'node:crypto';
/**
 * Google Gemini provider as a declarative `WireFormatConfig`. Matches the
 * `GoogleProvider` class behavior — same canonical events, same handling
 * of `thoughtSignature` and forced `tool_use` stop reason on functionCall
 * turns.
 */
import type {
  Capabilities,
  ContentBlock,
  Message,
  ReasoningEffort,
  Request,
  StopReason,
  StreamEvent,
  Tool,
  Usage,
} from '@wrongstack/contracts/types';
import { compactToolDefinitionForWire, safeParse } from '@wrongstack/core/utils';
import { providerErrorFromStreamPayload } from '../error-parse.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { documentInputFallback, imageInputFallback } from '../media-input-policy.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from '../model-output-limits.js';
import { normalizeGemini } from '../stop-reason.js';
import { defineWireFormat } from '../wire-format.js';

interface GeminiPart {
  text?: string | undefined;
  functionCall?: { name: string | undefined; args: Record<string, unknown> };
  functionResponse?: { name: string | undefined; response: { content?: unknown | undefined } };
  inlineData?: { mimeType: string | undefined; data: string };
  thoughtSignature?: string | undefined;
  /** True on thought-summary parts (returned when `includeThoughts` is set). */
  thought?: boolean | undefined;
}

interface GeminiContent {
  role: 'user' | 'model' | 'function';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: GeminiContent | undefined;
  finishReason?: string | undefined;
}

export interface GoogleStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  sawFunctionCall: boolean;
  finalEmitted: boolean;
  /** Set once a `finishReason` is seen — Gemini's end-of-stream marker. */
  sawTerminal: boolean;
  /** Live provider id (alias-aware) for errors raised mid-stream. */
  providerId?: string | undefined;
  /** A thought-summary run is open on the thinking channel. */
  thinkingOpen?: boolean | undefined;
}

export const googleWireFormat = defineWireFormat<GoogleStreamState>({
  id: 'google',
  family: 'google',
  capabilities: capabilitiesForFamily('google'),
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  buildUrl: (base, req) =>
    `${base}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`,
  buildHeaders: (apiKey) => ({ 'x-goog-api-key': apiKey }),
  buildBody: (req: Request, ctx: BuildBodyContext) => {
    const body: Record<string, unknown> = {
      contents: messagesToGemini(req.messages, ctx?.capabilities),
      generationConfig: buildGenConfig(req, ctx),
    };
    // Explicit caching: GoogleProvider.stream() resolved a cachedContents/*
    // resource holding the system instruction + tool defs. Reference it by name
    // and OMIT those fields from the live body — Gemini rejects a request that
    // both references a cache and repeats its cached content.
    const cachedContent = req.cache?.geminiCachedContentName;
    if (cachedContent) {
      body['cachedContent'] = cachedContent;
    } else {
      if (req.system && req.system.length > 0) {
        body['systemInstruction'] = {
          parts: req.system.map((b) => ({ text: b.text })),
        };
      }
      if (req.tools && req.tools.length > 0) {
        body['tools'] = [{ functionDeclarations: toolsToGemini(req.tools) }];
      }
    }
    if (req.safetySettings && req.safetySettings.length > 0) {
      body['safetySettings'] = req.safetySettings;
    }
    return body;
  },
  createStreamState: (fallbackModel, providerId) => ({
    providerId,
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    sawFunctionCall: false,
    finalEmitted: false,
    sawTerminal: false,
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<{
      modelVersion?: string | undefined;
      candidates?: GeminiCandidate[] | undefined;
      usageMetadata?: {
        promptTokenCount?: number | undefined;
        candidatesTokenCount?: number | undefined;
        cachedContentTokenCount?: number | undefined;
      };
      promptFeedback?: { blockReason?: string | undefined } | undefined;
      error?: unknown;
    }>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const obj = parsed.value;
    // A failure delivered inside the 200 stream: `{"error":{code,message,status}}`.
    if (obj.error !== undefined && obj.error !== null) {
      throw providerErrorFromStreamPayload(
        state.providerId ?? 'google',
        obj as Record<string, unknown>,
      );
    }
    const out: StreamEvent[] = [];

    if (obj.modelVersion) state.model = obj.modelVersion;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }

    const candidate = obj.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought === true) {
        // Thought summaries belong on the thinking channel, never in the
        // visible answer.
        if (typeof part.text === 'string' && part.text.length > 0) {
          if (!state.thinkingOpen) {
            state.thinkingOpen = true;
            out.push({ type: 'thinking_start' });
          }
          out.push({ type: 'thinking_delta', text: part.text });
        }
        continue;
      }
      if (state.thinkingOpen) {
        state.thinkingOpen = false;
        out.push({ type: 'thinking_stop' });
      }
      if (typeof part.text === 'string' && part.text.length > 0) {
        out.push({ type: 'text_delta', text: part.text });
      } else if (part.functionCall) {
        const name = part.functionCall.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        state.sawFunctionCall = true;
        // Gemini assigns no call id. Keep the synthesized one short and
        // name-independent: OpenAI rejects tool_call ids over 40 chars, and a
        // `<tool name>_<8 hex>` id overflowed that for long MCP tool names
        // once the history reached an OpenAI wire (`/model` switch, fallback).
        const id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        out.push({ type: 'tool_use_start', id, name });
        const providerMeta =
          typeof part.thoughtSignature === 'string'
            ? { 'google.thoughtSignature': part.thoughtSignature }
            : undefined;
        out.push({
          type: 'tool_use_stop',
          id,
          input: part.functionCall.args ?? {},
          ...(providerMeta ? { providerMeta } : {}),
        });
      }
    }

    if (candidate?.finishReason) {
      state.stopReason = normalizeGemini(candidate.finishReason);
      state.sawTerminal = true;
    } else if (!candidate && obj.promptFeedback?.blockReason) {
      // The PROMPT was blocked: Gemini answers with `promptFeedback.blockReason`
      // and no candidates, so no finishReason ever arrives. Without this the
      // stream looked truncated and was retried as a transient failure — the
      // same blocked prompt, over and over.
      state.stopReason = 'refusal';
      state.sawTerminal = true;
    }

    const u = obj.usageMetadata;
    if (u) {
      // Disjoint semantics — see google.ts for rationale.
      const cached = nonNegative(u.cachedContentTokenCount);
      // The cache read that will actually be REPORTED below. A chunk may
      // carry `promptTokenCount` without `cachedContentTokenCount`, and the
      // earlier chunk's cache read is retained on `cacheRead` — so `input`
      // must deduct the retained value, not this chunk's zero. Deducting the
      // chunk-local value re-counted the whole cached prefix as fresh input
      // and broke the disjointness the comment above promises.
      const retainedCacheRead = cached || state.usage.cacheRead || 0;
      const promptTotal = nonNegative(u.promptTokenCount, state.usage.input + retainedCacheRead);
      state.usage = {
        input: Math.max(0, promptTotal - retainedCacheRead),
        output: nonNegative(u.candidatesTokenCount, state.usage.output),
        cacheRead: cached || state.usage.cacheRead,
      };
    }
    return out;
  },
  finalizeStream: (state): StreamEvent[] => {
    if (state.finalEmitted || !state.started) return [];
    state.finalEmitted = true;
    const finalStop: StopReason = state.sawFunctionCall ? 'tool_use' : state.stopReason;
    const out: StreamEvent[] = [];
    if (state.thinkingOpen) {
      state.thinkingOpen = false;
      out.push({ type: 'thinking_stop' });
    }
    out.push({ type: 'message_stop', stopReason: finalStop, usage: state.usage });
    return out;
  },
  // Started receiving but no `finishReason` arrived → the Gemini stream was cut
  // mid-response. Surface a retryable error instead of a synthetic end_turn.
  isTruncated: (state) => state.started && !state.sawTerminal,
});

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function buildGenConfig(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
  const maxOutput = resolveMaxOutputTokens(req, ctx);
  // Optional field — omit rather than guess; Gemini then uses the model's own
  // output ceiling.
  const cfg: Record<string, unknown> = {};
  if (maxOutput !== undefined) cfg['maxOutputTokens'] = maxOutput;
  if (req.temperature !== undefined) cfg['temperature'] = req.temperature;
  if (req.topP !== undefined) cfg['topP'] = req.topP;
  if (req.topK !== undefined) cfg['topK'] = req.topK;
  if (req.frequencyPenalty !== undefined) cfg['frequencyPenalty'] = req.frequencyPenalty;
  if (req.presencePenalty !== undefined) cfg['presencePenalty'] = req.presencePenalty;
  if (req.seed !== undefined) cfg['seed'] = req.seed;
  if (req.candidateCount !== undefined) cfg['candidateCount'] = req.candidateCount;
  if (req.logprobs === true) cfg['logprobs'] = true;
  if (req.stopSequences) cfg['stopSequences'] = req.stopSequences;
  // Gemini thinkingConfig — see thinkingConfigFor().
  const thinkingConfig = thinkingConfigFor(req, maxOutput);
  if (thinkingConfig) cfg['thinkingConfig'] = thinkingConfig;
  if (req.responseFormat && req.responseFormat.type !== 'text') {
    cfg['responseMimeType'] = 'application/json';
    if (req.responseFormat.type === 'json_schema' && req.responseFormat.jsonSchema.schema) {
      cfg['responseSchema'] = req.responseFormat.jsonSchema.schema;
    }
  }
  return cfg;
}

/**
 * Map the canonical reasoning request onto Gemini's real `ThinkingConfig`
 * fields. The API has exactly three knobs — `includeThoughts`,
 * `thinkingBudget`, `thinkingLevel` — and no `type` field, so the previous
 * `{ type: 'enabled' | 'disabled' }` shape was an unknown-name 400 risk and
 * never carried the caller's effort at all.
 *
 * Per the live Gemini docs (checked 2026-08):
 *   - Gemini 3 models use `thinkingLevel` (`minimal|low|medium|high`).
 *   - Gemini 2.5 models use `thinkingBudget` (token count; `0` disables
 *     thinking on Flash/Lite, `-1` = dynamic).
 *   - Sending BOTH level and budget in one request is a 400.
 *   - Dynamic thinking is the API default — no field needed to get it.
 *
 * Model-family detection is by id prefix. For unknown generations we send
 * nothing: guessing a knob the model doesn't support is how the old bug
 * happened. `maxOutput` is the cap buildGenConfig already resolved.
 */
function thinkingConfigFor(
  req: Request,
  maxOutput: number | undefined,
): Record<string, unknown> | undefined {
  const model = req.model.toLowerCase();
  const isGemini3 = /^gemini-3/.test(model);
  const isGemini25 = /^gemini-(2\.5|2\.6)/.test(model);
  const reasoning = req.reasoning;
  if (!reasoning) return undefined;

  if (reasoning.enabled === false || reasoning.effort === 'none') {
    // Explicit off — best-effort per tier:
    //   - Gemini 3 Flash-tier: `minimal` is the documented floor.
    //   - Gemini 3 Pro-tier: thinking cannot be disabled, so `low` — the
    //     minimum the tier accepts — is the closest achievable state to "off".
    //     Omitting the field (as 2.5 Pro does below) would fall back to
    //     DYNAMIC thinking, which thinks more than `low` and is therefore
    //     further from the caller's intent.
    //   - 2.5/2.6 Flash/Lite: `thinkingBudget: 0` is the documented off switch.
    //   - 2.5/2.6 Pro: cannot disable (rejects 0) and has no level enum, so
    //     omit — guessing a budget risks a 400.
    if (isGemini3) {
      return { thinkingLevel: gemini3ProTier(model) ? 'low' : 'minimal' };
    }
    if (isGemini25 && /(?:flash|lite)/.test(model)) return { thinkingBudget: 0 };
    return undefined;
  }

  const effort = reasoning.effort;
  // `effort === 'none'` was consumed by the early return above, so any effort
  // reaching here is a real level.
  if (effort !== undefined) {
    if (isGemini3) {
      const level = geminiThinkingLevel(effort, gemini3ProTier(model));
      return level ? { thinkingLevel: level } : undefined;
    }
    if (isGemini25) {
      // 2.5 has no level enum — approximate the effort with a budget
      // fraction of the response cap, mirroring the Anthropic adapter.
      // 1025 is the smallest cap that can hold a legal budget (>=1024 and
      // strictly under the cap). Below it the request is too small to think.
      if (maxOutput !== undefined && maxOutput >= 1025) {
        return { thinkingBudget: deriveGeminiThinkingBudget(maxOutput, effort) };
      }
      return { thinkingBudget: -1 }; // dynamic — let the model size it
    }
    return undefined;
  }

  // `enabled: true` with no effort → dynamic thinking, which is already the
  // API default. Sending anything (the old code sent an invalid `type`) only
  // risks a 400; the thinking channel still streams thought summaries.
  return undefined;
}

/**
 * Effort → Gemini 3 `thinkingLevel` value, narrowed to the tier's enum.
 *
 * Per the 2026-08 Gemini docs the level sets are tier-specific:
 *   - Pro-tier (`gemini-3-pro`, Deep Think): `low | high`
 *   - Flash-tier (`gemini-3-flash`, Flash-Lite): `minimal | low | medium | high`
 * `xhigh`/`max` have no Gemini equivalent and collapse onto `high`.
 * Returns undefined when nothing is representable.
 */
function geminiThinkingLevel(
  effort: NonNullable<Request['reasoning']>['effort'],
  proTier: boolean,
): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'minimal':
      return proTier ? 'low' : 'minimal';
    case 'low':
      return 'low';
    case 'medium':
      return proTier ? 'high' : 'medium';
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}

/**
 * Gemini 3 Pro-tier detection. Live 2026-08 model names: `gemini-3-pro`,
 * `gemini-3-deep-think`, plus `gemini-3.7-*` / `gemini-3.5-*` refreshes whose
 * Pro variants follow the same `*-pro` / `*-deep-think` suffix convention.
 * Pro-tier accepts only `low | high`; Flash and Flash-Lite tiers accept the
 * full `minimal | low | medium | high` enum.
 */
function gemini3ProTier(lowerModel: string): boolean {
  return /(?:^|-)(?:pro|deep-think)(?:-|$)/.test(lowerModel);
}

/**
 * Thinking budget for Gemini 2.5 from the resolved output cap. Same fraction
 * ladder as the Anthropic adapter's `deriveThinkingBudget`, with both API
 * bounds applied to the final value: budget >= 1024 and budget < maxOutput.
 *
 * When the fraction-derived ceiling falls below the 1024 floor (small cap ×
 * low effort), returns `-1` (dynamic) rather than inflating to 1024: the 1024
 * floor would exceed both the requested effort fraction and the 80% headroom
 * cap, so letting the model size its own thinking is the honest mapping.
 * Caller guarantees `maxOutput >= 1025`, so the returned fixed budget is
 * always in the legal [1024, maxOutput) range.
 */
function deriveGeminiThinkingBudget(maxOutput: number, effort: ReasoningEffort): number {
  const fraction =
    effort === 'minimal'
      ? 0.25
      : effort === 'low'
        ? 0.35
        : effort === 'medium' || effort === undefined
          ? 0.5
          : effort === 'high'
            ? 0.65
            : /* 'xhigh' | 'max' */ 0.75;
  const ceiling = Math.min(Math.floor(maxOutput * fraction), Math.floor(maxOutput * 0.8));
  if (ceiling < 1024) return -1; // requested budget below the API floor → dynamic
  return Math.min(ceiling, maxOutput - 1);
}

export function toolsToGemini(tools: Tool[]): Array<Record<string, unknown>> {
  const sorted = tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
  return sorted.map((t) => {
    const compact = compactToolDefinitionForWire(t);
    return {
      name: compact.name,
      description: compact.description,
      parameters: sanitizeSchemaForGemini(compact.inputSchema) ?? {
        type: 'object',
        properties: {},
      },
    };
  });
}

const GEMINI_ALLOWED_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'propertyOrdering',
  'title',
]);

function sanitizeSchemaForGemini(node: unknown): Record<string, unknown> | undefined {
  if (node === null || node === undefined) return undefined;
  if (Array.isArray(node)) return undefined;
  if (typeof node !== 'object') return undefined;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(src)) {
    // Gemini accepts `anyOf` but not `oneOf`. Dropping `oneOf` left a property
    // such as telegram's `chat_id` (string | integer) with no type at all on
    // the wire. The alternatives in tool schemas are disjoint, so `anyOf`
    // carries the same shape; runtime validation still enforces `oneOf`.
    const k = rawKey === 'oneOf' && !('anyOf' in src) ? 'anyOf' : rawKey;
    if (!GEMINI_ALLOWED_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pname, pschema] of Object.entries(v as Record<string, unknown>)) {
        const cleaned = sanitizeSchemaForGemini(pschema);
        if (cleaned) props[pname] = cleaned;
      }
      out['properties'] = props;
    } else if (k === 'items') {
      const cleaned = sanitizeSchemaForGemini(v);
      if (cleaned) out['items'] = cleaned;
    } else if (k === 'anyOf' && Array.isArray(v)) {
      const cleaned = v
        .map((s) => sanitizeSchemaForGemini(s))
        .filter((s): s is Record<string, unknown> => s !== undefined);
      if (cleaned.length > 0) out['anyOf'] = cleaned;
    } else if (k === 'required' && Array.isArray(v)) {
      out['required'] = v.filter((s) => typeof s === 'string');
    } else if (k === 'enum' && Array.isArray(v)) {
      out['enum'] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function messagesToGemini(
  messages: Message[],
  capabilities: Capabilities | undefined,
): GeminiContent[] {
  const out: GeminiContent[] = [];
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    // System-role messages carried INSIDE the conversation (compaction
    // digests, the evidence floor) must not be dropped — Gemini has no system
    // turn, so they fall through to the user branch below (mirrors the
    // Anthropic wire, which maps system→user). The coalesce pass then merges
    // the resulting consecutive user turns so alternation stays valid.
    const blocks =
      typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          if (b.id && b.name) toolNameById.set(b.id, b.name);
          const part: GeminiPart = {
            functionCall: { name: b.name, args: b.input },
          };
          const sig = b.providerMeta?.['google.thoughtSignature'];
          if (typeof sig === 'string' && sig.length > 0) {
            part.thoughtSignature = sig;
          }
          parts.push(part);
        } else {
          const media = geminiMediaPart(b, capabilities);
          if (media) parts.push(media);
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }
    const textParts: GeminiPart[] = [];
    const functionParts: GeminiPart[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) textParts.push({ text: b.text });
      else if (b.type === 'tool_result') {
        const responseText = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        const fnName = b.name ?? toolNameById.get(b.tool_use_id) ?? b.tool_use_id;
        functionParts.push({
          functionResponse: {
            name: fnName,
            response: { content: responseText },
          },
        });
      } else {
        const media = geminiMediaPart(b, capabilities);
        if (media) textParts.push(media);
      }
    }
    const userParts: GeminiPart[] = [...textParts];
    // Include function responses as parts of the user turn — Gemini's API
    // accepts functionResponse blocks inline with text in a single user role.
    // This handles the case where a user message consists only of tool_result
    // blocks (no text): without this, the turn is silently dropped.
    if (functionParts.length > 0) userParts.push(...functionParts);
    if (userParts.length > 0) out.push({ role: 'user', parts: userParts });
  }
  return coalesceConsecutiveRoles(out);
}

function geminiMediaPart(
  block: ContentBlock,
  capabilities: Capabilities | undefined,
): GeminiPart | undefined {
  if (block.type === 'image') {
    const fallback = imageInputFallback(block, {
      allowImages: capabilities?.vision !== false,
      // Gemini's generateContent wire accepts inline bytes or Files API URIs,
      // not an arbitrary public HTTP image URL.
      allowImageUrls: false,
    });
    return fallback
      ? { text: fallback }
      : {
          inlineData: {
            mimeType: block.source.media_type ?? 'image/png',
            data: block.source.data ?? '',
          },
        };
  }
  if (block.type === 'document') {
    const fallback = documentInputFallback(block, capabilities?.pdf !== false);
    return fallback
      ? { text: fallback }
      : { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
  }
  return undefined;
}

/**
 * Merge adjacent contents that share a role into one turn. Gemini requires
 * user/model turns to alternate; folding an in-conversation system message into
 * a user turn (above) can produce two consecutive user turns, which the API
 * rejects. Concatenating their parts preserves every part in order (text,
 * functionCall/response, inlineData) without reordering across roles, so
 * tool-call pairing is untouched.
 */
function coalesceConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
  const merged: GeminiContent[] = [];
  for (const content of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === content.role) {
      prev.parts.push(...content.parts);
    } else {
      merged.push({ role: content.role, parts: [...content.parts] });
    }
  }
  return merged;
}
