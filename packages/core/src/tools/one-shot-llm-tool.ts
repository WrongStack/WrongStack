import type { JSONSchema, Tool } from '../types/tool.js';
import type {
  OneShotLLMInput,
  OneShotLLMResult,
  OneShotOrchestratorOptions,
} from '../types/one-shot-llm.js';
import { OneShotOrchestrator } from '../execution/one-shot-llm.js';

/**
 * Tool name for the one-shot LLM tool.
 * Register in ToolRegistry as `llm` so any agent can call it.
 */
export const ONE_SHOT_LLM_TOOL_NAME = 'llm';

/**
 * Options for creating the LLM tool.
 * Mirrors OneShotOrchestratorOptions — the tool wraps an internal orchestrator.
 * When `defaultProvider` and `defaultModel` are not set, callers MUST
 * provide `providerId` and `model` explicitly.
 */
export interface CreateOneShotLLMToolOptions {
  buildProvider: OneShotOrchestratorOptions['buildProvider'];
  getConfig: OneShotOrchestratorOptions['getConfig'];
  /** Shared live FallbackProfileManager — required. */
  fallbackProfileManager: OneShotOrchestratorOptions['fallbackProfileManager'];
  modelRouter?: OneShotOrchestratorOptions['modelRouter'];
  /**
   * Shared provider/model status tracker. Without it the orchestrator never
   * records failures/successes for `llm` calls, so provider health stays
   * blind to this tool's traffic and blocked entries are not skipped.
   */
  statusTracker?: OneShotOrchestratorOptions['statusTracker'];
  logger?: OneShotOrchestratorOptions['logger'];
  wrapProviderCall?: OneShotOrchestratorOptions['wrapProviderCall'];
  /**
   * Default provider to use when the caller doesn't specify one.
   * When absent, callers MUST provide `providerId` explicitly.
   */
  defaultProvider?: string | undefined;
  /**
   * Default model to use when the caller doesn't specify one.
   * When absent, callers MUST provide `model` explicitly.
   */
  defaultModel?: string | undefined;
}

/**
 * Upper bound for a caller-supplied `timeoutMs`. A one-shot call is a
 * single-turn utility invocation — anything past two minutes indicates a
 * misconfigured caller, not a legitimately slow request, and would pin the
 * tool slot for that long. Values above the cap are clamped, not rejected.
 */
const MAX_TIMEOUT_MS = 120_000;

/**
 * JSON Schema for the llm tool input.
 */
const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    system: {
      type: 'string',
      description: 'System prompt guiding the LLM behaviour.',
    },
    userPrompt: {
      type: 'string',
      description: 'Single user turn — appended as a user-role message.',
    },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['system', 'user', 'assistant', 'tool'],
            description: 'Message author role.',
          },
          content: {
            type: 'string',
            description: 'Message text content.',
          },
        },
        required: ['role', 'content'],
        additionalProperties: true,
      },
      description:
        'Conversation messages for few-shot examples or multi-turn context. Appended before userPrompt when both are set.',
    },
    model: {
      type: 'string',
      description: 'Model id (e.g. "deepseek-chat", "gpt-4o-mini"). Defaults to session model.',
    },
    providerId: {
      type: 'string',
      description: 'Provider id (e.g. "anthropic", "openai"). Defaults to session provider.',
    },
    role: {
      type: 'string',
      description: 'Roster role for model-matrix routing. Overrides model/providerId.',
    },
    fallbackModels: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Explicit fallback model chain (e.g. ["anthropic/claude-haiku", "openai/gpt-4o-mini"]). Resolved named profiles from FallbackProfileManager are passed here.',
    },
    maxTokens: {
      type: 'number',
      description: 'Maximum output tokens (default 1024).',
    },
    responseFormat: {
      oneOf: [
        { type: 'string', enum: ['text', 'json_object'], description: 'Simple response format.' },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['json_schema'], description: 'Structured JSON output.' },
            json_schema: {
              type: 'object',
              description: 'JSON Schema definition for the structured output.',
            },
          },
          required: ['type'],
          additionalProperties: false,
        },
      ],
      description:
        'Response format: "text" (default), "json_object", or { type: "json_schema", json_schema: {...} }.',
    },
    temperature: {
      type: 'number',
      description: 'Sampling temperature.',
    },
    timeoutMs: {
      type: 'number',
      description: `Hard timeout in ms (default 30s, clamped to a maximum of ${MAX_TIMEOUT_MS}).`,
    },
  },
  additionalProperties: false,
};

/**
 * Create the `llm` tool — a general-purpose one-shot LLM invocation tool
 * that any agent can call. Wraps OneShotOrchestrator internally for
 * provider resolution, fallback chain support, and structured results.
 *
 * Usage from an agent:
 * ```
 * llm({
 *   system: "You are a helpful assistant.",
 *   userPrompt: "Summarize this conversation.",
 *   model: "deepseek-chat",
 *   maxTokens: 1024,
 * })
 * ```
 *
 * Register with the ToolRegistry and it becomes available everywhere:
 * ```ts
 * toolRegistry.register(createOneShotLLMTool({ buildProvider, getConfig }));
 * ```
 */
export function createOneShotLLMTool(
  opts: CreateOneShotLLMToolOptions,
): Tool<OneShotLLMInput, OneShotLLMResult> {
  const orchestrator = new OneShotOrchestrator({
    buildProvider: opts.buildProvider,
    getConfig: opts.getConfig,
    fallbackProfileManager: opts.fallbackProfileManager,
    modelRouter: opts.modelRouter,
    statusTracker: opts.statusTracker,
    logger: opts.logger,
    wrapProviderCall: opts.wrapProviderCall,
  });

  return {
    name: ONE_SHOT_LLM_TOOL_NAME,
    description:
      'Make a one-shot LLM call with a system prompt and user input. ' +
      'Supports provider selection, model routing by role, fallback chains, and timeout. ' +
      'Returns the response text, model info, token usage, and whether a fallback was used. ' +
      'Use this for summarization, classification, extraction, and any single-turn LLM task.',
    usageHint:
      'Provide `system` for the instruction and `userPrompt` for the input. ' +
      'Either set `model`+`providerId`, or have defaults configured on the tool. ' +
      'Set `fallbackModels` for resilience. ' +
      'Check `error` on the result for failure details.',
    inputSchema: INPUT_SCHEMA,
    // Metadata mirrors council-tool.ts — both are read-only meta tools that
    // spend tokens but never touch the workspace.
    category: 'meta',
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    maxOutputBytes: 262_144,

    validate(input: OneShotLLMInput): string[] {
      const hasPrompt = typeof input.userPrompt === 'string' && input.userPrompt.trim().length > 0;
      const hasMessages = Array.isArray(input.messages) && input.messages.length > 0;
      if (!hasPrompt && !hasMessages) {
        return [
          'Provide `userPrompt` (a single user turn) or `messages` (a conversation array) — ' +
            'without either the llm tool has nothing to send to the model.',
        ];
      }
      return [];
    },

    async execute(
      input: OneShotLLMInput,
      _ctx,
      { signal }: { signal: AbortSignal },
    ): Promise<OneShotLLMResult> {
      // If the caller didn't provide model/providerId, check for tool-level defaults.
      // This prevents silent fallback to session config which may not be intended.
      if (!input.model && !input.providerId && !opts.defaultModel && !opts.defaultProvider) {
        return {
          text: '',
          model: '',
          provider: '',
          tokens: { input: 0, output: 0, total: 0 },
          durationMs: 0,
          fromFallback: false,
          error:
            'Either provide `model` and `providerId` in the call, or configure ' +
            'defaultProvider/defaultModel when creating the tool. The `llm` tool ' +
            'does not infer provider/model from the session by default.',
        };
      }

      // Apply defaults when caller omits model/providerId but defaults are configured.
      const effectiveInput: OneShotLLMInput = {
        ...input,
        signal: input.signal ? AbortSignal.any([input.signal, signal]) : signal,
        model: input.model ?? opts.defaultModel,
        providerId: input.providerId ?? opts.defaultProvider,
        // Clamp runaway timeouts (documented on the schema). Non-positive
        // values fall back to the orchestrator default rather than making the
        // call instantly un-completable.
        ...(typeof input.timeoutMs === 'number' && input.timeoutMs > 0
          ? { timeoutMs: Math.min(input.timeoutMs, MAX_TIMEOUT_MS) }
          : { timeoutMs: undefined }),
      };

      return orchestrator.call(effectiveInput);
    },
  };
}
