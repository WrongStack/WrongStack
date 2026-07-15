import { CouncilOrchestrator } from '../execution/council-orchestrator.js';
import type {
  CouncilLLMCaller,
  CouncilOption,
  CouncilProfileConfig,
  CouncilQuestion,
  CouncilResult,
} from '../types/council.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { CouncilPersonaRegistry } from '../execution/council-personas.js';
import type { CouncilProfileRegistry } from '../execution/council-profiles.js';

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
      description: 'Registered Council profile id. Defaults to the host-configured profile.',
    },
  },
  required: ['question'],
  additionalProperties: false,
};

/** Create a read-only, bounded agent-callable Council tool. */
export function createCouncilTool(
  opts: CreateCouncilToolOptions,
): Tool<CouncilToolInput, CouncilResult> {
  const orchestrator = new CouncilOrchestrator(opts);
  return {
    name: COUNCIL_TOOL_NAME,
    description:
      'Ask an independent, multi-persona Council to evaluate a decision or synthesize an answer. ' +
      'Uses bounded parallel voters, quorum/veto/weighted resolution, optional judging, model routing, fallback chains, and cancellation.',
    usageHint:
      'Use for consequential or disputed decisions that benefit from independent lenses. ' +
      'Provide `options` for a vote or omit them for an open answer. ' +
      'Keep context evidence-focused; the Council treats it as untrusted data.',
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
    validate: validateCouncilToolInput,
  };
}

function validateCouncilToolInput(input: CouncilToolInput): string[] {
  const errors: string[] = [];
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
  const ids = new Set<string>();
  for (const option of input.options ?? []) {
    const id = option.id.trim();
    if (!id) errors.push('Every option must have a non-empty `id`.');
    if (!option.label.trim()) errors.push(`Option "${id || '<empty>'}" must have a label.`);
    if (ids.has(id)) errors.push(`Duplicate option id "${id}".`);
    ids.add(id);
  }
  return errors;
}
