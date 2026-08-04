import { CouncilOrchestrator } from '../execution/council-orchestrator.js';
import type { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import type {
  CouncilLLMCaller,
  CouncilOption,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilResult,
} from '../types/council.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { CouncilPersonaRegistry } from '../execution/council-personas.js';
import {
  type CouncilProfileRegistry,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
} from '../execution/council-profiles.js';
import { validateCouncilOptions } from '../execution/council-prompts.js';

export const COUNCIL_TOOL_NAME = 'council';
export const MAX_COUNCIL_TOOL_OPTIONS = 12;
export const MAX_COUNCIL_QUESTION_CHARS = 20_000;
export const MAX_COUNCIL_CONTEXT_CHARS = 80_000;

export interface CouncilToolInput {
  question: string;
  context?: string | undefined;
  options?: CouncilOption[] | undefined;
  profile?: string | CouncilProfileConfig | undefined;
}

export interface CreateCouncilToolOptions {
  caller: CouncilLLMCaller;
  personas?: CouncilPersonaRegistry | undefined;
  profiles?: CouncilProfileRegistry | undefined;
  defaultProfile?: string | undefined;
  maxConcurrency?: number | undefined;
  refusalOptionId?: string | undefined;
  /** Shared live FallbackProfileManager. */
  fallbackProfileManager?: FallbackProfileManager | undefined;
}

const INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The decision or open question for the Council.',
      maxLength: MAX_COUNCIL_QUESTION_CHARS,
    },
    context: {
      type: 'string',
      description: 'Optional evidence and constraints. Treated as untrusted quoted data.',
      maxLength: MAX_COUNCIL_CONTEXT_CHARS,
    },
    options: {
      type: 'array',
      maxItems: MAX_COUNCIL_TOOL_OPTIONS,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable option id.' },
          label: { type: 'string', description: 'Human-readable option label.' },
          consequence: { type: 'string', description: 'Optional consequence or trade-off.' },
        },
        required: ['id', 'label'],
        additionalProperties: false,
      },
      description: 'Optional bounded list of choices. Omit for an open-ended Council answer.',
    },
    profile: {
      type: 'string',
      description:
        'Registered Council profile id (e.g. "balanced", "fast", "risk-review"). Defaults to the host-configured profile.',
    },
  },
  required: ['question'],
  additionalProperties: false,
};

/** Create a read-only, bounded agent-callable Council tool. */
export function createCouncilTool(
  opts: CreateCouncilToolOptions,
): Tool<CouncilToolInput, CouncilResult> {
  const orchestrator = new CouncilOrchestrator({
    ...opts,
    fallbackProfileManager: opts.fallbackProfileManager,
  });
  const profiles = opts.profiles ?? DEFAULT_COUNCIL_PROFILE_REGISTRY;
  const profileIds = profiles.list().map((profile) => profile.id);
  return {
    name: COUNCIL_TOOL_NAME,
    description:
      'Ask an independent, multi-persona Council to evaluate a decision or synthesize an answer. ' +
      'Uses bounded parallel voters, quorum/veto/weighted resolution, optional judging, model routing, fallback chains, and cancellation.',
    usageHint:
      'Use for consequential or disputed decisions that benefit from independent lenses. ' +
      'Provide `options` for a vote or omit them for an open answer. ' +
      'Keep context evidence-focused; the Council treats it as untrusted data. ' +
      `Available profiles: ${profileIds.join(', ')}.`,
    category: 'meta',
    inputSchema: INPUT_SCHEMA,
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    managesOwnTimeout: true,
    maxOutputBytes: 256_000,
    async execute(input, _ctx, { signal }) {
      const question: CouncilQuestion = {
        question: input.question,
        ...(input.context ? { context: input.context } : {}),
        ...(input.options ? { options: input.options } : {}),
        ...(input.profile ? { profile: input.profile } : {}),
        signal,
      };
      return orchestrator.ask(question);
    },
    validate: (input) => validateCouncilToolInput(input, profileIds),
  };
}

function validateCouncilToolInput(input: CouncilToolInput, profileIds: string[]): string[] {
  const errors: string[] = [];
  // An unknown profile id used to reach `registry.require()` inside `ask()`
  // and surface as a thrown tool failure. Naming the valid ids here turns a
  // typo into something the caller can correct on the next attempt.
  if (typeof input.profile === 'string' && input.profile.trim()) {
    const id = input.profile.trim();
    if (!profileIds.includes(id)) {
      errors.push(`Unknown \`profile\` "${id}". Available: ${profileIds.join(', ')}.`);
    }
  }
  const question = input.question?.trim() ?? '';
  if (!question) errors.push('`question` must not be empty.');
  if (question.length > MAX_COUNCIL_QUESTION_CHARS) {
    errors.push(`\`question\` must not exceed ${MAX_COUNCIL_QUESTION_CHARS} characters.`);
  }
  if ((input.context?.length ?? 0) > MAX_COUNCIL_CONTEXT_CHARS) {
    errors.push(`\`context\` must not exceed ${MAX_COUNCIL_CONTEXT_CHARS} characters.`);
  }
  if ((input.options?.length ?? 0) > MAX_COUNCIL_TOOL_OPTIONS) {
    errors.push(`\`options\` must not contain more than ${MAX_COUNCIL_TOOL_OPTIONS} items.`);
  }
  // Shared rule set with the prompt builder (normalizeOptions) — one place
  // owns the id/label/duplicate checks.
  errors.push(...validateCouncilOptions(input.options));
  return errors;
}
