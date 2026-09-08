/**
 * `clarify` tool — Proactive Ambiguity Clarifier & Intent Alignment.
 *
 * Prompts the user with structured, multiple-choice questions when architectural,
 * database schema, API contract, or domain logic assumptions are underspecified.
 * Bridges clarify + ask_question into a single unified interactive tool
 * functioning consistently across CLI, TUI, and WebUI.
 */

import type { Tool } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';

export interface ClarifyQuestionItem {
  /** The core decision or question to clarify with the user. */
  question: string;
  /** Context or explanation of why this decision matters (e.g. index performance, validation). */
  context?: string | undefined;
  /** 2 to 6 structured, distinct choices for the user to select. */
  options: string[];
  /** The option recommended by the assistant based on best practices. */
  recommendedOption?: string | undefined;
  /** Whether the user can select multiple options simultaneously. */
  isMultiSelect?: boolean | undefined;
  /** Snake-case alias for isMultiSelect (Antigravity compatibility). */
  is_multi_select?: boolean | undefined;
  /** Allow write-in custom responses in addition to options (default: true). */
  allowCustomResponse?: boolean | undefined;
}

export interface ClarifyQuestionInput extends Partial<ClarifyQuestionItem> {
  /** Batch questions list (Antigravity ask_question parity). */
  questions?: ClarifyQuestionItem[] | undefined;
}

export type ClarifyInput = ClarifyQuestionInput;

export interface ClarifyAnswerItem {
  question: string;
  selectedOptions: string[];
  customResponse?: string | undefined;
}

export interface ClarifyOutput {
  status: 'answered' | 'auto_decided' | 'skipped';
  /** Primary / single question (for backward compatibility). */
  question: string;
  selectedOptions: string[];
  customResponse?: string | undefined;
  /** Complete list of answers when clarifying one or more questions. */
  answers?: ClarifyAnswerItem[] | undefined;
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
    'Ask the user structured multiple-choice clarification question(s) when an architectural, ' +
    'database schema, API, or domain decision has mutually exclusive trade-offs. Supports single or batch questions, ' +
    'recommended defaults, multi-select, and custom write-in responses across TUI, CLI, and WebUI.',
  usageHint:
    'Use when requirements are ambiguous or have critical trade-offs.\n' +
    '- Single question: pass `question` and `options` (min 2).\n' +
    '- Multiple questions: pass `questions: [{ question, options, recommendedOption? }]`.\n' +
    '- Format options as clear user decisions. Prefix best practice choices with "(Recommended)".\n' +
    '- Autonomous fallback: if running headless without an interactive UI, the recommended option is automatically selected.',
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
        description: '2 to 6 distinct options formatted as clear user decisions.',
        minItems: 2,
        maxItems: 6,
      },
      recommendedOption: {
        type: 'string',
        description: 'The assistant-recommended default choice.',
      },
      isMultiSelect: {
        type: 'boolean',
        description: 'Whether multiple options can be chosen simultaneously.',
      },
      is_multi_select: {
        type: 'boolean',
        description: 'Snake-case alias for isMultiSelect.',
      },
      allowCustomResponse: {
        type: 'boolean',
        description: 'Whether to allow the user to type a custom write-in response (default: true).',
      },
      questions: {
        type: 'array',
        description: 'List of questions for batch clarification (Antigravity ask_question parity).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            context: { type: 'string' },
            options: {
              type: 'array',
              items: { type: 'string' },
              minItems: 2,
              maxItems: 6,
            },
            recommendedOption: { type: 'string' },
            isMultiSelect: { type: 'boolean' },
            is_multi_select: { type: 'boolean' },
            allowCustomResponse: { type: 'boolean' },
          },
          required: ['question', 'options'],
        },
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx, opts) {
    try {
      const signal = opts?.signal ?? ctx?.signal;
      signal?.throwIfAborted();

      // Normalize items: either batch `questions` or single question fields
      const items: ClarifyQuestionItem[] = [];
      if (Array.isArray(input.questions) && input.questions.length > 0) {
        items.push(...input.questions);
      } else if (input.question && Array.isArray(input.options)) {
        items.push({
          question: input.question,
          context: input.context,
          options: input.options,
          recommendedOption: input.recommendedOption,
          isMultiSelect: input.isMultiSelect ?? input.is_multi_select,
          allowCustomResponse: input.allowCustomResponse,
        });
      }

      if (items.length === 0) {
        throw new Error('clarify requires either `question` with `options`, or a `questions` array with at least 1 item.');
      }

      for (const item of items) {
        if (!item.options || item.options.length < 2) {
          throw new Error(`clarify question "${item.question}" requires at least 2 distinct options.`);
        }
      }

      // Host interactive question handler check
      type HostAskFn = (
        q: string,
        opts: string[],
        multiOrConfig?: boolean | {
          isMultiSelect?: boolean;
          context?: string;
          recommendedOption?: string;
          allowCustomResponse?: boolean;
        },
      ) => Promise<{ selected: string[]; custom?: string }>;

      const hostAsk = (ctx as unknown as { askUserChoices?: HostAskFn })?.askUserChoices;

      const answers: ClarifyAnswerItem[] = [];
      let isAutoDecided = false;

      for (const item of items) {
        const multi = item.isMultiSelect ?? item.is_multi_select ?? false;
        const options = item.options;

        if (typeof hostAsk === 'function') {
          const res = await hostAsk(item.question, options, {
            isMultiSelect: multi,
            ...(item.context === undefined ? {} : { context: item.context }),
            ...(item.recommendedOption === undefined
              ? {}
              : { recommendedOption: item.recommendedOption }),
            allowCustomResponse: item.allowCustomResponse ?? true,
          });
          const selected = Array.isArray(res?.selected) ? res.selected : [];
          answers.push({
            question: item.question,
            selectedOptions: selected,
            customResponse: res?.custom,
          });
        } else {
          // Autonomous or non-interactive headless mode: pick recommended or first option
          isAutoDecided = true;
          const rec = item.recommendedOption ??
            options.find((opt) => /^\(?recommended\)?/i.test(opt)) ??
            options[0] ??
            'Default';
          answers.push({
            question: item.question,
            selectedOptions: [rec],
            customResponse: undefined,
          });
        }
      }

      const primary = answers[0]!;
      const summaries = answers.map((ans) => {
        const customPart = ans.customResponse ? ` (Custom: "${ans.customResponse}")` : '';
        return `"${ans.question}": ${ans.selectedOptions.join(', ')}${customPart}`;
      });

      const decisionSummary = isAutoDecided
        ? `Auto-selected recommended option(s) in non-interactive mode: ${summaries.join('; ')}`
        : `User clarified: ${summaries.join('; ')}`;

      return {
        status: isAutoDecided ? 'auto_decided' : 'answered',
        question: primary.question,
        selectedOptions: primary.selectedOptions,
        customResponse: primary.customResponse,
        answers,
        decisionSummary,
      };
    } catch (err) {
      const fallbackQuestion = input.question ?? input.questions?.[0]?.question ?? '';
      return {
        status: 'skipped',
        question: fallbackQuestion,
        selectedOptions: [],
        decisionSummary: '',
        error: toErrorMessage(err),
      };
    }
  },
};
