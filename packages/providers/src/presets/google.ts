import { randomUUID } from 'node:crypto';
/**
 * Google Gemini provider as a declarative `WireFormatConfig`. Matches the
 * `GoogleProvider` class behavior — same canonical events, same handling
 * of `thoughtSignature` and forced `tool_use` stop reason on functionCall
 * turns.
 */
import type {
  Message,
  ReasoningEffort,
  Request,
  StopReason,
  StreamEvent,
  Tool,
  Usage,
} from '@wrongstack/core/types';
import { compactToolDefinitionForWire, safeParse } from '@wrongstack/core/utils';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from '../model-output-limits.js';
import { normalizeGemini } from '../stop-reason.js';
import { defineWireFormat } from '../wire-format.js';

interface GeminiPart {
  text?: string | undefined;
  functionCall?: { name: string | undefined; args: Record<string, unknown> };
  functionResponse?: { name: string | undefined; response: { content?: unknown | undefined } };
  inlineData?: { mimeType: string | undefined; data: string };
  thoughtSignature?: string | undefined;
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
      contents: messagesToGemini(req.messages),
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
  createStreamState: (fallbackModel) => ({
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
    }>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const obj = parsed.value;
    const out: StreamEvent[] = [];

    if (obj.modelVersion) state.model = obj.modelVersion;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }

    const candidate = obj.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        out.push({ type: 'text_delta', text: part.text });
      } else if (part.functionCall) {
        const name = part.functionCall.name;
        if (typeof name !== 'string' || name.length === 0) continue;
        state.sawFunctionCall = true;
        const id = `${name}_${randomUUID().slice(0, 8)}`;
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
    }

    const u = obj.usageMetadata;
    if (u) {
      // Disjoint semantics — see google.ts for rationale.
      const cached = nonNegative(u.cachedContentTokenCount);
      const promptTotal = nonNegative(u.promptTokenCount, state.usage.input + cached);
      state.usage = {
        input: Math.max(0, promptTotal - cached),
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
    return [{ type: 'message_stop', stopReason: finalStop, usage: state.usage }];
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
  const sorted =
    tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
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
  for (const [k, v] of Object.entries(src)) {
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

function messagesToGemini(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];
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
          const part: GeminiPart = {
            functionCall: { name: b.name, args: b.input },
          };
          const sig = b.providerMeta?.['google.thoughtSignature'];
          if (typeof sig === 'string' && sig.length > 0) {
            part.thoughtSignature = sig;
          }
          parts.push(part);
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
        const fnName = b.name ?? b.tool_use_id;
        functionParts.push({
          functionResponse: {
            name: fnName,
            response: { content: responseText },
          },
        });
      } else if (b.type === 'image' && b.source.type === 'base64') {
        textParts.push({
          inlineData: {
            mimeType: b.source.media_type ?? 'image/png',
            data: b.source.data ?? '',
          },
        });
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
