import type { Config } from '@wrongstack/contracts/types/config/root';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import type { SystemOneRequest, SystemOneResult } from './client.js';
import {
  isTypeSafeJudgmentEnabled,
  resolveTypeSafeJudge,
  type TypeSafeJudge,
} from './judgments.js';

export type JevToolInput = Pick<SystemOneRequest, 'state' | 'questions'>;

const text: JSONSchema = { type: 'string', minLength: 1 };
const question = (type: string, criteria: JSONSchema, required = true): JSONSchema => ({
  type: 'object',
  properties: { type: { type: 'string', enum: [type] }, instructions: text, criteria },
  required: ['type', 'instructions', ...(required ? ['criteria'] : [])],
  additionalProperties: false,
});

export const JEV_INPUT_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    state: {
      description: 'Self-contained JSON evidence to judge. Include the relevant facts and context.',
    },
    questions: {
      type: 'object',
      minProperties: 1,
      description:
        'Question ID to typed rubric. Use noul for yes/no, choice for alternatives, score for ordered levels.',
      additionalProperties: {
        oneOf: [
          question(
            'noul',
            {
              type: 'object',
              properties: { true: text, false: text },
              additionalProperties: false,
            },
            false,
          ),
          question('choice', {
            type: 'object',
            minProperties: 2,
            additionalProperties: { anyOf: [text, { type: 'null' }] },
            description:
              'At least two option IDs mapped to descriptions (or null for self-explanatory IDs).',
          }),
          question('score', {
            type: 'array',
            minItems: 2,
            items: text,
            description: 'At least two concrete level descriptions, ordered lowest to highest.',
          }),
        ],
      },
    },
  },
  required: ['state', 'questions'],
  additionalProperties: false,
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Also runs on direct calls, which do not necessarily pass through schema validation. */
export function validateJevToolInput(input: unknown): string[] {
  if (!record(input) || !Object.hasOwn(input, 'state') || input.state === undefined)
    return ['Provide state and a nonempty questions map.'];
  if (Object.keys(input).some((key) => !['state', 'questions'].includes(key)))
    return ['Only state and questions are accepted; the configured account controls routing.'];
  if (!record(input.questions) || !Object.keys(input.questions).length)
    return ['Provide a nonempty questions map.'];
  for (const [id, q] of Object.entries(input.questions)) {
    if (
      !id.trim() ||
      !record(q) ||
      !nonempty(q.instructions) ||
      Object.keys(q).some((key) => !['type', 'instructions', 'criteria'].includes(key))
    )
      return ['Each question needs an ID, type and nonempty instructions.'];
    const c = q.criteria;
    if (q.type === 'noul') {
      if (
        c !== undefined &&
        (!record(c) ||
          Object.entries(c).some(
            ([key, value]) => !['true', 'false'].includes(key) || !nonempty(value),
          ))
      )
        return ['noul criteria may contain only true/false descriptions.'];
    } else if (q.type === 'choice') {
      if (
        !record(c) ||
        Object.keys(c).length < 2 ||
        Object.entries(c).some(
          ([key, value]) => !key.trim() || (value !== null && !nonempty(value)),
        )
      )
        return ['choice needs at least two option IDs with descriptions or null.'];
    } else if (q.type === 'score') {
      if (!Array.isArray(c) || c.length < 2 || !c.every(nonempty))
        return ['score needs at least two ordered level descriptions.'];
    } else return ['Question type must be noul, choice or score.'];
  }
  try {
    JSON.stringify(input.state);
  } catch {
    return ['state must be JSON serializable.'];
  }
  return [];
}

export function jevToolStatus(config: Pick<Config, 'typesafe'>) {
  const enabled = isTypeSafeJudgmentEnabled(config, 'tool');
  const judge = resolveTypeSafeJudge({ config, feature: 'tool' });
  return {
    enabled,
    available: !!judge && !judge.unavailableReason,
    reason: !enabled
      ? 'disabled'
      : !judge
        ? 'account-required'
        : (judge.unavailableReason ?? 'ready'),
    model: judge?.model,
    scope: 'Local configuration and shared client health; not a live connection test.',
  };
}

/** Shared by the callable tool and the explicit synthetic capability checks. */
export async function evaluateJevQuestions(
  input: JevToolInput,
  judge: TypeSafeJudge,
  signal: AbortSignal,
  activityFeature = 'tool',
): Promise<SystemOneResult> {
  const errors = validateJevToolInput(input);
  if (errors.length)
    throw new ToolValidationError({ message: errors.join(' '), field: 'questions' });
  signal.throwIfAborted();
  if (judge.unavailableReason) throw new Error(`Jev unavailable (${judge.unavailableReason}).`);
  const result = await judge.client.systemOne(
    {
      state: input.state,
      questions: input.questions,
      model: judge.model,
      activityFeature,
    },
    signal,
  );
  const answers: SystemOneResult['answers'] = {};
  for (const [id, q] of Object.entries(input.questions)) {
    const answer = Object.hasOwn(result.answers, id) ? result.answers[id] : undefined;
    if (
      !answer ||
      answer.type !== q.type ||
      (q.type === 'choice' &&
        answer.type === 'choice' &&
        (!Object.hasOwn(q.criteria, answer.choice) ||
          Object.keys(answer.probabilities).length !== Object.keys(q.criteria).length ||
          Object.keys(answer.probabilities).some((key) => !Object.hasOwn(q.criteria, key)))) ||
      (q.type === 'score' && answer.type === 'score' && answer.score > q.criteria.length - 1)
    )
      throw new Error('Jev returned missing or incompatible answers; no decision was accepted.');
    Object.defineProperty(answers, id, { value: answer, enumerable: true });
  }
  return { ...result, answers };
}

export function createJevStatusTool(
  getConfig: () => Pick<Config, 'typesafe'>,
  isToolDisabled: () => boolean = () => false,
): Tool {
  return {
    name: 'jev_status',
    category: 'meta',
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    description:
      'Check whether the Jev decision tool is enabled and usable. No network request. Reports local account readiness and shared client health; does not prove service connectivity.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const status = jevToolStatus(getConfig());
      return isToolDisabled() ? { ...status, available: false, reason: 'tool-disabled' } : status;
    },
  };
}

export function createJevTool(
  getConfig: () => Pick<Config, 'typesafe'>,
): Tool<JevToolInput, SystemOneResult> {
  return {
    name: 'jev',
    category: 'meta',
    permission: 'auto',
    mutating: false,
    riskTier: 'safe',
    capabilities: ['net.outbound'],
    description:
      'Jev is a structured decision specialist for interpreting known evidence against explicit criteria. ' +
      'Use it proactively when a bounded judgment could change your next action: compare plausible options, ' +
      'filter relevant findings, prioritize review candidates, or assess evidence against a requirement. ' +
      'Supply self-contained state and neutral typed questions: noul (yes/no probability), choice (option probabilities), ' +
      'or score (ordered rubric levels). Include counterevidence and unknowns; add a defer option when appropriate. ' +
      'Normally call once per distinct unresolved decision; batch related questions and reuse answers until evidence or criteria change. ' +
      'Simple edits and deterministic checks may need no call. Do not call every turn or repeat a question to get a preferred answer. ' +
      'Returns validated answers, model and usage using the configured Jev account. Confidence is distribution concentration, not correctness; ' +
      'judgments do not replace tests or supply missing facts. Use llm for prose or council for multiple perspectives when available.',
    usageHint:
      'Use Jev proactively when judging known evidence could change your next action. ' +
      'Send state with evidence, counterevidence and unknowns, plus neutral questions and concrete criteria. ' +
      'One request per distinct unresolved decision is normally enough; batch related questions and repeat only when evidence or criteria change. ' +
      'Check jev_status only when availability is uncertain. Missing answers and failures are tool errors; continue reasoning without a Jev verdict.',
    selection: {
      doNotUseWhen: 'You need prose, new facts, or multi-perspective deliberation.',
      useInstead: ['llm', 'council'],
    },
    inputSchema: JEV_INPUT_SCHEMA,
    validate: validateJevToolInput,
    async execute(input, _ctx, { signal }) {
      const errors = validateJevToolInput(input);
      if (errors.length)
        throw new ToolValidationError({ message: errors.join(' '), field: 'questions' });
      signal.throwIfAborted();
      const judge = resolveTypeSafeJudge({ config: getConfig(), feature: 'tool' });
      if (!judge || judge.unavailableReason)
        throw new Error(
          `Jev unavailable (${judge?.unavailableReason ?? 'disabled or account missing'}). Use jev_status.`,
        );
      return evaluateJevQuestions(input, judge, signal);
    },
  };
}
