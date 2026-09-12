/** Structured, cross-surface model-to-user clarification form. */
import { randomUUID } from 'node:crypto';
import type {
  Tool,
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
  UserInputTab,
} from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';

export interface ClarifyOptionInput {
  id?: string | undefined;
  label: string;
  description?: string | undefined;
}
export interface ClarifyQuestionItem {
  id?: string | undefined;
  question: string;
  context?: string | undefined;
  type?: 'single_select' | 'multi_select' | 'text' | undefined;
  options?: Array<string | ClarifyOptionInput> | undefined;
  recommendedOption?: string | undefined;
  recommendedOptions?: string[] | undefined;
  recommendedText?: string | undefined;
  recommendationReason?: string | undefined;
  isMultiSelect?: boolean | undefined;
  is_multi_select?: boolean | undefined;
  allowCustomResponse?: boolean | undefined;
  required?: boolean | undefined;
  placeholder?: string | undefined;
}
export interface ClarifyTabInput {
  id?: string | undefined;
  label: string;
  description?: string | undefined;
  questions: ClarifyQuestionItem[];
}
export interface ClarifyQuestionInput extends Partial<ClarifyQuestionItem> {
  title?: string | undefined;
  description?: string | undefined;
  submitLabel?: string | undefined;
  questions?: ClarifyQuestionItem[] | undefined;
  tabs?: ClarifyTabInput[] | undefined;
}
export type ClarifyInput = ClarifyQuestionInput;
export interface ClarifyAnswerItem {
  questionId: string;
  question: string;
  selectedOptions: string[];
  customResponse?: string | undefined;
  usedRecommendation: boolean;
}
export interface ClarifyOutput {
  status: 'answered' | 'auto_decided' | 'skipped';
  question: string;
  selectedOptions: string[];
  customResponse?: string | undefined;
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
    'Pause and ask the user for required decisions in one structured, tabbed form. Supports single-select, multi-select, free text, option descriptions, write-ins, and explicitly recommended answers. Submit returns all answers to the model at once.',
  usageHint:
    'Prefer `tabs` with stable snake_case ids. Every decision should include a recommended answer and a short recommendationReason. Use `type: "text"` for free-form input. Legacy `question`/`questions` inputs remain supported.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short form title.' },
      description: { type: 'string', description: 'Why these answers are needed.' },
      submitLabel: { type: 'string', description: 'Submit button label.' },
      question: { type: 'string' },
      context: { type: 'string' },
      type: { type: 'string', enum: ['single_select', 'multi_select', 'text'] },
      options: optionArraySchema(),
      recommendedOption: { type: 'string' },
      recommendedOptions: { type: 'array', items: { type: 'string' } },
      recommendedText: { type: 'string' },
      recommendationReason: { type: 'string' },
      isMultiSelect: { type: 'boolean' },
      is_multi_select: { type: 'boolean' },
      allowCustomResponse: { type: 'boolean' },
      required: { type: 'boolean' },
      placeholder: { type: 'string' },
      questions: { type: 'array', minItems: 1, items: questionSchema() },
      tabs: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            questions: { type: 'array', minItems: 1, maxItems: 12, items: questionSchema() },
          },
          required: ['label', 'questions'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx, opts) {
    try {
      const signal = opts?.signal ?? ctx.signal;
      signal.throwIfAborted();
      const request = normalizeRequest(input);
      let response: UserInputResponse | undefined;
      if (typeof ctx.requestUserInput === 'function')
        response = await ctx.requestUserInput(request, signal);
      else response = await legacyHostResponse(ctx, request);
      const autoDecided = response === undefined;
      const resolved = response ?? recommendedResponse(request);
      if (resolved.status === 'cancelled')
        return skipped(request, 'User cancelled the clarification form.');
      const answers = materializeAnswers(request, resolved.answers);
      const primary = answers[0]!;
      const decisionSummary = `${autoDecided ? 'Auto-selected recommended answers in non-interactive mode' : 'User clarified'}: ${answers
        .map((answer) => {
          const values = [
            ...answer.selectedOptions,
            ...(answer.customResponse ? [answer.customResponse] : []),
          ];
          return `"${answer.question}": ${values.join(', ') || '(blank)'}`;
        })
        .join('; ')}`;
      return {
        status: autoDecided ? 'auto_decided' : 'answered',
        question: primary.question,
        selectedOptions: primary.selectedOptions,
        customResponse: primary.customResponse,
        answers,
        decisionSummary,
      };
    } catch (error) {
      return skippedFromInput(input, toErrorMessage(error));
    }
  },
};

function optionArraySchema() {
  return {
    type: 'array',
    minItems: 2,
    maxItems: 8,
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['label'],
          additionalProperties: false,
        },
      ],
    },
  };
}
function questionSchema() {
  return {
    type: 'object',
    properties: {
      id: { type: 'string' },
      question: { type: 'string' },
      context: { type: 'string' },
      type: { type: 'string', enum: ['single_select', 'multi_select', 'text'] },
      options: optionArraySchema(),
      recommendedOption: { type: 'string' },
      recommendedOptions: { type: 'array', items: { type: 'string' } },
      recommendedText: { type: 'string' },
      recommendationReason: { type: 'string' },
      isMultiSelect: { type: 'boolean' },
      is_multi_select: { type: 'boolean' },
      allowCustomResponse: { type: 'boolean' },
      required: { type: 'boolean' },
      placeholder: { type: 'string' },
    },
    required: ['question'],
    additionalProperties: false,
  };
}
function slug(value: string, fallback: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback
  );
}
function normalizeRequest(input: ClarifyQuestionInput): UserInputRequest {
  const sourceTabs: ClarifyTabInput[] = input.tabs?.length
    ? input.tabs
    : [
        {
          label: 'Questions',
          questions: input.questions?.length ? input.questions : [input as ClarifyQuestionItem],
        },
      ];
  const seen = new Set<string>();
  const tabs: UserInputTab[] = sourceTabs.map((tab, tabIndex) => ({
    id: tab.id ?? slug(tab.label, `tab_${tabIndex + 1}`),
    label: tab.label,
    description: tab.description,
    questions: tab.questions.map((question, questionIndex) => {
      if (!question.question?.trim())
        throw new Error('Every clarify question requires non-empty `question`.');
      const id = question.id ?? slug(question.question, `question_${questionIndex + 1}`);
      if (seen.has(id)) throw new Error(`Duplicate clarify question id: ${id}`);
      seen.add(id);
      const kind =
        question.type ??
        ((question.isMultiSelect ?? question.is_multi_select) ? 'multi_select' : 'single_select');
      const options = (question.options ?? []).map((option, index) => {
        const value = typeof option === 'string' ? { label: option } : option;
        return {
          id: value.id ?? slug(value.label, `option_${index + 1}`),
          label: value.label,
          description: value.description,
        };
      });
      if (kind !== 'text' && options.length < 2)
        throw new Error(`clarify question "${question.question}" requires at least 2 options.`);
      const recommended =
        question.recommendedOptions ??
        (question.recommendedOption ? [question.recommendedOption] : []);
      const recommendedOptionIds = recommended.map(
        (value) =>
          options.find((option) => option.id === value || option.label === value)?.id ?? value,
      );
      if (kind === 'single_select' && recommendedOptionIds.length > 1)
        throw new Error(
          `Single-select question "${question.question}" can recommend only one option.`,
        );
      return {
        id,
        prompt: question.question,
        description: question.context,
        kind,
        required: question.required ?? true,
        options: kind === 'text' ? undefined : options,
        recommendedOptionIds,
        recommendedText: question.recommendedText,
        recommendationReason: question.recommendationReason,
        allowCustomResponse: kind === 'text' ? undefined : (question.allowCustomResponse ?? true),
        placeholder: question.placeholder,
      } satisfies UserInputQuestion;
    }),
  }));
  return {
    id: `clarify_${randomUUID()}`,
    title: input.title?.trim() || 'A few decisions are needed',
    description: input.description,
    submitLabel: input.submitLabel ?? 'Submit answers',
    tabs,
  };
}
function recommendedResponse(request: UserInputRequest): UserInputResponse {
  return {
    requestId: request.id,
    status: 'submitted',
    answers: request.tabs.flatMap((tab) =>
      tab.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: question.recommendedOptionIds?.length
          ? question.recommendedOptionIds
          : question.kind === 'text'
            ? []
            : (question.options?.slice(0, 1).map((option) => option.id) ?? []),
        text: question.recommendedText,
        usedRecommendation: Boolean(
          question.recommendedOptionIds?.length || question.recommendedText,
        ),
      })),
    ),
  };
}
function materializeAnswers(
  request: UserInputRequest,
  answers: UserInputAnswer[],
): ClarifyAnswerItem[] {
  const byId = new Map(answers.map((answer) => [answer.questionId, answer]));
  return request.tabs.flatMap((tab) =>
    tab.questions.map((question) => {
      const answer = byId.get(question.id) ?? {
        questionId: question.id,
        selectedOptionIds: [],
        usedRecommendation: false,
      };
      return {
        questionId: question.id,
        question: question.prompt,
        selectedOptions: answer.selectedOptionIds.map(
          (id) => question.options?.find((option) => option.id === id)?.label ?? id,
        ),
        customResponse: answer.text,
        usedRecommendation: answer.usedRecommendation,
      };
    }),
  );
}
async function legacyHostResponse(
  ctx: unknown,
  request: UserInputRequest,
): Promise<UserInputResponse | undefined> {
  type Ask = (
    question: string,
    options: string[],
    config?: object,
  ) => Promise<{ selected: string[]; custom?: string }>;
  const ask = (ctx as { askUserChoices?: Ask }).askUserChoices;
  if (typeof ask !== 'function') return undefined;
  const answers: UserInputAnswer[] = [];
  for (const question of request.tabs.flatMap((tab) => tab.questions)) {
    const result = await ask(
      question.prompt,
      question.options?.map((option) => option.label) ?? [],
      {
        isMultiSelect: question.kind === 'multi_select',
        context: question.description,
        recommendedOption: question.recommendedOptionIds?.[0],
        allowCustomResponse: question.allowCustomResponse,
      },
    );
    const ids = result.selected.map(
      (value) =>
        question.options?.find((option) => option.label === value || option.id === value)?.id ??
        value,
    );
    answers.push({
      questionId: question.id,
      selectedOptionIds: ids,
      text: result.custom,
      usedRecommendation:
        ids.length === (question.recommendedOptionIds?.length ?? 0) &&
        ids.every((id) => question.recommendedOptionIds?.includes(id)),
    });
  }
  return { requestId: request.id, status: 'submitted', answers };
}
function skipped(request: UserInputRequest, error: string): ClarifyOutput {
  return {
    status: 'skipped',
    question: request.tabs[0]?.questions[0]?.prompt ?? '',
    selectedOptions: [],
    decisionSummary: '',
    error,
  };
}
function skippedFromInput(input: ClarifyQuestionInput, error: string): ClarifyOutput {
  return {
    status: 'skipped',
    question:
      input.question ??
      input.questions?.[0]?.question ??
      input.tabs?.[0]?.questions[0]?.question ??
      '',
    selectedOptions: [],
    decisionSummary: '',
    error,
  };
}
