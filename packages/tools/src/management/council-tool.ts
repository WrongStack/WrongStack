import type {
  CouncilLLMCaller,
  CouncilOption,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilResult,
} from '@wrongstack/contracts/types/council';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import type { FallbackProfileManager } from '@wrongstack/core/agent';
import { CouncilOrchestrator } from '@wrongstack/core/execution';
import type { CouncilPersonaRegistry } from '@wrongstack/core/execution';
import {
  type CouncilProfileRegistry,
  DEFAULT_COUNCIL_PROFILE_REGISTRY,
} from '@wrongstack/core/execution';
import { validateCouncilOptions } from '@wrongstack/core/execution';

export const COUNCIL_TOOL_NAME = 'council';

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
    },
    context: {
      type: 'string',
      description: 'Optional evidence and constraints. Treated as untrusted quoted data.',
    },
    options: {
      type: 'array',
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
      const result = await orchestrator.ask(question);
      // abstained/denied/decided are verdicts; failed/cancelled, or a panel
      // where no seat produced a usable ballot, mean the Council never ran.
      const noSeatRan = result.validVoteCount === 0 && (result.errors?.length ?? 0) > 0;
      if (result.status === 'failed' || result.status === 'cancelled' || noSeatRan) {
        const detail = result.errors?.length ? ` Errors: ${result.errors.join('; ')}` : '';
        // Orchestrator reasons already end in a period ("Council quorum was not met.").
        const reason = (result.reason ?? 'no valid votes').replace(/\.+$/u, '');
        throw new Error(
          `Council ${result.status === 'cancelled' ? 'was cancelled' : 'failed'}: ${reason}.${detail}`,
        );
      }
      return result;
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
  // Shared rule set with the prompt builder (normalizeOptions) — one place
  // owns the id/label/duplicate checks.
  errors.push(...validateCouncilOptions(input.options));
  return errors;
}
