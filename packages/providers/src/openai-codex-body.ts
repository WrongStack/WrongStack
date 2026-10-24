import {
  type Capabilities,
  isVolatileSystemBlock,
  type ReasoningEffort,
  type Request,
} from '@wrongstack/contracts/types';
import { type CodexModelPolicy, clampReasoningEffort } from './openai-codex-model-policy.js';
import {
  appendVolatileSystem,
  codexCacheSessionId,
  mapToolChoice,
} from './openai-codex-request.js';
import { type CodexTruncationPolicy, truncateCodexToolOutput } from './openai-codex-truncation.js';
import { applyPromptCacheKey } from './prompt-cache-key.js';
import { messagesToResponsesInput, toolsToResponses } from './tool-format/to-responses.js';

interface CodexBodyOptions {
  capabilities: Capabilities | undefined;
  policy: CodexModelPolicy | undefined;
  includeReasoning: boolean;
  configuredReasoningEffort: ReasoningEffort | undefined;
  reasoningEffort: ReasoningEffort;
  textVerbosity: 'low' | 'medium' | 'high';
}

/** Pure wire projection; session state, transport and diagnostics stay in the provider. */
export function buildCodexRequestBody(
  req: Request,
  options: CodexBodyOptions,
): Record<string, unknown> {
  // Split the system prompt by cache stability. This ChatGPT OAuth adapter
  // does not send explicit cache breakpoints; API-key Responses support is
  // model-dependent and does not establish support on this route. Joining a
  // changing block into `instructions` changes context before conversation
  // history. Keep stable instructions separate from live state. This preserves
  // local overlap; actual cache reuse still depends on backend boundaries,
  // routing and retention and must be measured from response usage.
  const stableSystem: string[] = [];
  const volatileSystem: string[] = [];
  for (const block of req.system ?? []) {
    (isVolatileSystemBlock(block) ? volatileSystem : stableSystem).push(block.text);
  }
  const instructions = stableSystem.length > 0 ? stableSystem.join('\n\n') : undefined;

  // The live catalog, when this session has already probed it. Absent on the
  // very first request of a process, which is why every use below falls back
  // to the previous unconditional behaviour rather than to a guess.
  const policy = options.policy;

  const body: Record<string, unknown> = {
    model: req.model,
    // The ChatGPT Codex backend rejects `store: true` ("Store must be set to
    // false"). Build full input; the WebSocket transport may send a verified
    // continuation delta instead.
    store: false,
    stream: true,
    ...(instructions ? { instructions } : {}),
    // `include: reasoning.encrypted_content` below asks the backend to hand
    // back the reasoning it produced; replaying it here is the half that
    // makes asking for it worth anything. Skipped once the backend has
    // rejected a replay (see `stream`).
    input: appendVolatileSystem(
      truncateToolOutputs(
        messagesToResponsesInput(req.messages, {
          includeReasoning: options.includeReasoning,
          // gpt-5.3-codex-spark lists `input_modalities: ["text"]`. Sending
          // it an `input_image` part buys a 400 and a retry; dropping the
          // image costs the picture but keeps the turn, which is the better
          // half of a choice the caller already made by picking a text model.
          allowImages: policy?.acceptsImages ?? options.capabilities?.vision !== false,
          // The ChatGPT Codex route follows the official client and accepts
          // uploaded data URLs, not arbitrary remote URLs.
          allowImageUrls: false,
          allowDocuments: options.capabilities?.pdf !== false,
        }),
        policy?.truncation,
      ),
      volatileSystem,
    ),
    include: ['reasoning.encrypted_content'],
    parallel_tool_calls: policy?.parallelToolCalls ?? true,
  };
  // Responses Lite (`use_responses_lite`, true for gpt-6-astra and the 5.6
  // family) is deliberately NOT opted into. The official client's lite mode
  // is a package deal — the internal
  // `x-openai-internal-codex-responses-lite` header, `parallel_tool_calls:
  // false`, `reasoning.context: 'all_turns'`, and a different input
  // formatting — and taking only the parts that are easy to send would ask
  // the backend for a pipeline this transport does not actually speak. Not
  // opting in is a supported configuration; half-opting in is not.

  if (req.tools && req.tools.length > 0) {
    body['tools'] = toolsToResponses(req.tools);
    body['tool_choice'] = mapToolChoice(req.toolChoice);
  }
  // The ChatGPT Codex backend rejects max_output_tokens. This differs from
  // API-key Responses transports, which can forward the caller's cap.
  // The ChatGPT Codex request schema used by the official client has no
  // temperature/top_p fields. Do not forward generic runtime sampling knobs
  // that this subscription endpoint may reject.
  // Precedence: an explicit per-request effort, then a configured provider
  // default, then the model's OWN default from the catalog
  // (`default_reasoning_level` — `low` for gpt-5.6-sol, `high` for
  // gpt-5.3-codex-spark, `medium` for the rest), then the generic floor.
  // A single hardcoded 'medium' silently overrode the picker's per-model
  // recommendation in both directions.
  const requestedEffort =
    req.reasoning?.effort ??
    options.configuredReasoningEffort ??
    policy?.defaultReasoningEffort ??
    options.reasoningEffort;
  const reasoningEffort = clampReasoningEffort(
    requestedEffort,
    policy?.supportedReasoningEfforts ?? [],
  );
  if (req.reasoning?.enabled === false || reasoningEffort === 'none') {
    // Omission selects the backend default. Explicitly disable reasoning
    // only when the catalog confirms that this model accepts `none`.
    if (policy?.supportedReasoningEfforts.includes('none')) {
      body['reasoning'] = { effort: 'none' };
    }
  } else {
    body['reasoning'] = { effort: reasoningEffort, summary: 'auto' };
  }
  if (policy?.supportsVerbosity) body['text'] = { verbosity: options.textVerbosity };
  // Preserve conversation-scoped cache identity, matching the official Codex
  // client's session_id key. API routing semantics vary by model generation;
  // a key neither pins a server nor guarantees cache reuse. Fall back to the
  // generic prefix key for one-shot helpers and embedders without a session.
  const cacheSessionId = codexCacheSessionId(req.cache?.sessionId);
  if (cacheSessionId && options.capabilities?.cacheControl === 'auto') {
    body['prompt_cache_key'] = cacheSessionId;
  } else {
    applyPromptCacheKey(body, req, options.capabilities);
  }
  return body;
}

/**
 * Apply the catalog's per-model tool-output truncation, as the official client
 * does before any output enters the conversation it sends. Only
 * `function_call_output` items are touched; the canonical history keeps the
 * full output, so a switch to another provider still sees all of it.
 */
function truncateToolOutputs(
  items: Record<string, unknown>[],
  policy: CodexTruncationPolicy | undefined,
): Record<string, unknown>[] {
  if (!policy) return items;
  return items.map((item) => {
    if (item['type'] !== 'function_call_output' || typeof item['output'] !== 'string') return item;
    const output = truncateCodexToolOutput(item['output'], policy);
    return output === item['output'] ? item : { ...item, output };
  });
}
