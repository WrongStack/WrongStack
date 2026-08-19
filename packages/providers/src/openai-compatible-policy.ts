import type { ReasoningEffort, Request } from '@wrongstack/core/types';
import { resolveProviderDefinition } from './provider-definitions.js';

/**
 * Apply contracts that look OpenAI-compatible at the transport level but use
 * provider/model-specific reasoning and tool parameters. This runs after the
 * generic Chat Completions body builder so known providers can remove unsafe
 * generic fields before restoring only values their public API accepts.
 */
export function applyOpenAICompatiblePolicy(
  body: Record<string, unknown>,
  req: Request,
  providerId: string,
): void {
  const policy = resolveProviderDefinition(providerId)?.requestPolicy;
  if (policy === 'openrouter') {
    applyOpenRouter(body, req);
    return;
  }
  if (policy === 'deepseek') {
    applyDeepSeek(body, req);
    return;
  }
  if (policy === 'kimi') {
    applyKimi(body, req);
    return;
  }
  if (policy === 'zai') {
    applyZai(body, req);
    return;
  }
  if (policy === 'alibaba') {
    applyAlibaba(body, req);
    return;
  }
  if (policy === 'xai') {
    applyXai(body, req);
    return;
  }
  if (policy === 'groq') applyGroq(body, req);
  else if (policy === 'perplexity') applyPerplexity(body, req);
}

function applyOpenRouter(body: Record<string, unknown>, req: Request): void {
  delete body['reasoning_effort'];
  const input = req.reasoning;
  if (!input) return;

  const reasoning: Record<string, unknown> = {};
  if (input.effort !== undefined) reasoning['effort'] = input.effort;
  else if (input.enabled !== undefined) reasoning['enabled'] = input.enabled;
  if (input.display === 'omitted') reasoning['exclude'] = true;
  else if (input.display === 'summarized') reasoning['exclude'] = false;
  if (Object.keys(reasoning).length > 0) body['reasoning'] = reasoning;
}

function applyDeepSeek(body: Record<string, unknown>, req: Request): void {
  // Older/unknown DeepSeek models keep the generic compatible contract.
  // V4 is the first family with this exact thinking/effort combination.
  if (!req.model.toLowerCase().includes('deepseek-v4')) return;
  delete body['reasoning_effort'];
  const r = req.reasoning;
  if (r?.enabled !== undefined) {
    body['thinking'] = { type: r.enabled ? 'enabled' : 'disabled' };
  }
  if (r?.enabled !== false && (r?.effort === 'high' || r?.effort === 'max')) {
    body['reasoning_effort'] = r.effort;
  }

  // DeepSeek V4 thinking mode ignores these sampling controls. Omitting them
  // also protects gateways that validate the combination strictly.
  const thinking = r?.enabled !== false;
  if (thinking) {
    delete body['temperature'];
    delete body['top_p'];
    delete body['frequency_penalty'];
    delete body['presence_penalty'];
    forceAutoToolChoice(body, req);
  }
}

function applyKimi(body: Record<string, unknown>, req: Request): void {
  delete body['reasoning_effort'];
  delete body['thinking'];
  const r = req.reasoning;
  const model = req.model.toLowerCase();

  if (model.includes('k3')) {
    if (r?.enabled !== false && isOneOf(r?.effort, ['low', 'high', 'max'])) {
      body['reasoning_effort'] = r?.effort;
    }
    forceAutoToolChoice(body, req);
    return;
  }
  if (model.includes('k2.7') || model.includes('for-coding')) {
    // K2.7 Code is always-thinking and rejects the thinking parameter.
    forceAutoToolChoice(body, req);
    return;
  }
  if (model.includes('k2.6') || model.includes('k2.5')) {
    if (r?.enabled !== undefined) {
      const thinking: Record<string, unknown> = { type: r.enabled ? 'enabled' : 'disabled' };
      if (model.includes('k2.6') && r.preserve === true) thinking['keep'] = 'all';
      body['thinking'] = thinking;
    } else if (model.includes('k2.6') && r?.preserve === true) {
      body['thinking'] = { type: 'enabled', keep: 'all' };
    }
    if (r?.enabled !== false) forceAutoToolChoice(body, req);
  }
}

function applyZai(body: Record<string, unknown>, req: Request): void {
  const r = req.reasoning;
  // Invariant: `reasoning_effort` may reach here from two sources — the base
  // builder (openai-shared.ts, value-gated only) or the `zai-glm` quirk
  // (applyThinkingParams → mapZaiReasoningEffort, Z.AI's documented contract
  // for the whole GLM line). The quirk early-returns when `enabled === false`,
  // so on THAT path any present value came from the base builder and is a
  // leak: it would ship alongside `thinking: {type:'disabled'}` as a
  // contradictory payload. Delete it; keep the quirk's deliberate mappings
  // everywhere else.
  if (r?.enabled === false) delete body['reasoning_effort'];
  if (r?.enabled !== undefined) {
    body['thinking'] = { type: r.enabled ? 'enabled' : 'disabled' };
  }
  // GLM-5.2 advertises only the two named effort levels. Other GLM models use
  // the thinking toggle and must not receive a guessed effort value.
  if (
    req.model.toLowerCase().includes('glm-5.2') &&
    r?.enabled !== false &&
    (r?.effort === 'high' || r?.effort === 'max')
  ) {
    body['reasoning_effort'] = r.effort;
  }
}

function applyAlibaba(body: Record<string, unknown>, req: Request): void {
  delete body['reasoning_effort'];
  const r = req.reasoning;
  if (r?.enabled !== undefined) body['enable_thinking'] = r.enabled;
  if (r?.enabled !== false && r?.effort && r.effort !== 'none') {
    body['enable_thinking'] = true;
    // Budget a fraction of the response cap. The base body builder already
    // resolved that cap for THIS model (catalog `limit.output`), so read it
    // back. When it resolved to nothing, no budget is sent either: the value
    // would have to be invented, and the backend picks its own default.
    const cap = outputCapFrom(body, req);
    if (cap !== undefined) body['thinking_budget'] = deriveBudget(cap, r.effort, 32_768);
  }
  if (body['enable_thinking'] === true) forceAutoToolChoice(body, req);
}

function applyXai(body: Record<string, unknown>, req: Request): void {
  delete body['reasoning_effort'];
  const model = req.model.toLowerCase();
  if (!model.includes('grok-4.5')) return;
  const effort = req.reasoning?.effort;
  if (req.reasoning?.enabled !== false && isOneOf(effort, ['low', 'medium', 'high'])) {
    body['reasoning_effort'] = effort;
  }
  // xAI documents these as incompatible with reasoning models.
  delete body['presence_penalty'];
  delete body['frequency_penalty'];
  delete body['stop'];
}

function applyGroq(body: Record<string, unknown>, req: Request): void {
  delete body['reasoning_effort'];
  const model = req.model.toLowerCase();
  const effort = req.reasoning?.effort;
  if (model.includes('qwen3.6')) {
    if (req.reasoning?.enabled === false || effort === 'none') body['reasoning_effort'] = 'none';
    else if (isOneOf(effort, ['low', 'medium', 'high'])) {
      // Groq's documented reasoning_effort enum for qwen3 is
      // none|low|medium|high — 'default' (previously sent here) is not in it.
      body['reasoning_effort'] = effort;
    } else if (req.reasoning?.enabled === true || effort !== undefined) {
      // Enabled without a representable level: omit the field and let the
      // model's dynamic default apply rather than invent a value.
    }
    if (
      (req.tools?.length ?? 0) > 0 ||
      (req.responseFormat !== undefined && req.responseFormat.type !== 'text')
    ) {
      body['reasoning_format'] = 'parsed';
    }
  } else if (model.includes('gpt-oss') && isOneOf(effort, ['low', 'medium', 'high'])) {
    body['reasoning_effort'] = effort;
    body['include_reasoning'] = true;
  }
}

function applyPerplexity(body: Record<string, unknown>, req: Request): void {
  delete body['reasoning_effort'];
  const model = req.model.toLowerCase();
  if (!model.includes('reasoning-pro') && !model.includes('deep-research')) return;
  const effort = req.reasoning?.effort;
  if (
    req.reasoning?.enabled !== false &&
    isOneOf(effort, ['minimal', 'low', 'medium', 'high'])
  ) {
    body['reasoning_effort'] = effort;
  }
}

function forceAutoToolChoice(body: Record<string, unknown>, req: Request): void {
  if (!req.tools || req.tools.length === 0) return;
  const choice = body['tool_choice'];
  if (choice !== undefined && choice !== 'auto' && choice !== 'none') {
    body['tool_choice'] = 'auto';
  }
}

function isOneOf<T extends string>(value: T | undefined, allowed: readonly T[]): value is T {
  return value !== undefined && allowed.includes(value);
}

/**
 * The output cap the body builder already put on the wire, whichever field
 * name this provider uses, falling back to the request's explicit value.
 *
 * Undefined when nothing resolved one. Callers must then omit whatever they
 * would have derived from it rather than substitute a literal — a guessed
 * budget here is the same class of bug as a guessed `max_tokens`.
 */
function outputCapFrom(body: Record<string, unknown>, req: Request): number | undefined {
  for (const field of ['max_tokens', 'max_completion_tokens'] as const) {
    const value = body[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  const explicit = req.maxTokens;
  return typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0
    ? explicit
    : undefined;
}

/**
 * EXHAUSTIVE effort → budget-fraction table for the Alibaba
 * `thinking_budget` derivation. Every canonical {@link ReasoningEffort} has a
 * row; a new core level without one is a compile error, not a silent 0.95.
 */
const ALIBABA_EFFORT_BUDGET_FRACTION: Readonly<Record<ReasoningEffort, number>> = {
  // Exhaustiveness sentinel only: applyAlibaba filters `effort !== 'none'`
  // before calling deriveBudget, so this row never executes at runtime. It
  // exists so the Record type forces a deliberate classification if the
  // union grows.
  none: 0,
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
  max: 0.95,
};

function deriveBudget(maxTokens: number, effort: ReasoningEffort, cap: number): number {
  const ratio = ALIBABA_EFFORT_BUDGET_FRACTION[effort];
  return Math.max(1, Math.min(Math.floor(maxTokens * ratio), cap, Math.max(1, maxTokens - 1)));
}
