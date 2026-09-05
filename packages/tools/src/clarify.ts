/**
 * `clarify` tool — Proactive Ambiguity Clarifier & Intent Alignment.
 *
 * Prompts the user with structured, multiple-choice questions when architectural,
 * database schema, API contract, or domain logic assumptions are underspecified.
 * Prevents silent misaligned migrations, breaking changes, and refactoring re-work.
 */

import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';

export interface ClarifyQuestionInput {
  /** The core decision or question to clarify with the user. */
  question: string;
  /** Context or explanation of why this decision matters (e.g. index performance, validation). */
  context?: string | undefined;
  /** 2 to 4 structured, distinct choices for the user to select. */
  options: string[];
  /** The option recommended by the assistant based on best practices. */
  recommendedOption?: string | undefined;
  /** Whether the user can select multiple options simultaneously. */
  isMultiSelect?: boolean | undefined;
  /** Allow write-in custom responses in addition to options (default: true). */
  allowCustomResponse?: boolean | undefined;
}

export type ClarifyInput = ClarifyQuestionInput;

export interface ClarifyOutput {
  status: 'answered' | 'auto_decided' | 'skipped';
  question: string;
  selectedOptions: string[];
  customResponse?: string | undefined;
  decisionSummary: string;
  error?: string | undefined;
}

export const clarifyTool: Tool<ClarifyQuestionInput, ClarifyOutput> = {
  name: 'clarify',
  category: 'Meta',
  icon: 'meta',
  permission: 'auto',
  mutating: false,
  description:
    'Ask the user for proactive clarification with structured multiple-choice options ONLY when an architectural, ' +
    'database schema, or API decision is truly irreversible and has mutually exclusive trade-offs.',
  usageHint:
    'AUTONOMOUS EXECUTION PRINCIPLE (BIAS FOR ACTION):\n\n' +
    '- DO NOT overuse or interrupt the user for routine implementation choices. For 95%+ of tasks, autonomously pick the standard best practice and continue executing.\n' +
    '- Use ONLY when facing an irreversible fork (e.g. data destruction, fundamentally conflicting domain rules) where guessing would be catastrophic.\n' +
    '- If a solid industry standard exists (e.g. E.164 phone format, indexed foreign keys, ISO dates), adopt it autonomously, execute the next steps, and document the decision in the final reply.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The specific architectural, schema, or contract decision to clarify.',
      },
      context: {
        type: 'string',
        description: 'Brief explanation of tradeoffs or why this decision is needed.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '2 to 4 distinct options formatted as clear user decisions.',
        minItems: 2,
        maxItems: 5,
      },
      recommendedOption: {
        type: 'string',
        description: 'The assistant-recommended default choice.',
      },
      isMultiSelect: {
        type: 'boolean',
        description: 'Whether multiple options can be chosen simultaneously.',
      },
      allowCustomResponse: {
        type: 'boolean',
        description: 'Whether to allow the user to type a custom response (default: true).',
      },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
  async execute(input, ctx, opts) {
    try {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();

      const options = input.options;
      if (!options || options.length < 2) {
        throw new Error('clarify requires at least 2 distinct options.');
      }

      // Check if host context has interactive user question handler
      const hostAsk = (
        ctx as unknown as {
          askUserChoices?: (
            q: string,
            opts: string[],
            multi?: boolean,
          ) => Promise<{ selected: string[]; custom?: string }>;
        }
      ).askUserChoices;

      if (typeof hostAsk === 'function') {
        const res = await hostAsk(input.question, options, input.isMultiSelect);
        const selected = Array.isArray(res?.selected) ? res.selected : [];
        return {
          status: 'answered',
          question: input.question,
          selectedOptions: selected,
          customResponse: res?.custom,
          decisionSummary: `User selected: ${selected.join(', ')}${res?.custom ? ` (Custom: ${res.custom})` : ''}`,
        };
      }

      // In autonomous or non-interactive headless mode: pick the recommended or first option
      const defaultChoice = input.recommendedOption ?? options[0] ?? 'Default';
      return {
        status: 'auto_decided',
        question: input.question,
        selectedOptions: [defaultChoice],
        decisionSummary: `Auto-selected recommended option: "${defaultChoice}" (Non-interactive mode)`,
      };
    } catch (err) {
      return {
        status: 'skipped',
        question: input.question ?? '',
        selectedOptions: [],
        decisionSummary: '',
        error: toErrorMessage(err),
      };
    }
  },
};
