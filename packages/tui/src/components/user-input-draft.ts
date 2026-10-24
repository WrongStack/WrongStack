import type {
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
} from '@wrongstack/contracts/types';
import { type DOMElement, measureElement } from '../ink.js';

export type AnswerDraft = {
  selected: string[];
  text: string;
  customSelected: boolean;
  delegated: boolean;
};

export type Draft = Record<string, AnswerDraft>;

export const EMPTY_ANSWER: AnswerDraft = {
  selected: [],
  text: '',
  customSelected: false,
  delegated: false,
};

export function initialDraft(request: UserInputRequest): Draft {
  return Object.fromEntries(
    request.tabs.flatMap((tab) =>
      tab.questions.map((question) => [
        question.id,
        {
          selected: [...(question.recommendedOptionIds ?? [])],
          text: question.recommendedText ?? '',
          customSelected: Boolean(question.recommendedText),
          delegated: false,
        },
      ]),
    ),
  );
}

export function canEditText(question: UserInputQuestion): boolean {
  return question.kind === 'text' || question.allowCustomResponse === true;
}

export function hasRecommendation(question: UserInputQuestion): boolean {
  return Boolean(question.recommendedOptionIds?.length || question.recommendedText);
}

export function hasAnswer(question: UserInputQuestion, answer?: AnswerDraft): boolean {
  if (!answer) return false;
  if (answer.delegated) return true;
  return question.kind === 'text'
    ? Boolean(answer.text.trim())
    : answer.selected.length > 0 || Boolean(answer.customSelected && answer.text.trim());
}

export function validateDraft(
  questions: UserInputQuestion[],
  draft: Draft,
): {
  valid: boolean;
  missingCount: number;
  firstMissing?: UserInputQuestion | undefined;
} {
  const missing = questions.filter(
    (question) => question.required && !hasAnswer(question, draft[question.id]),
  );
  return { valid: missing.length === 0, missingCount: missing.length, firstMissing: missing[0] };
}

export function toAnswer(question: UserInputQuestion, answer: AnswerDraft): UserInputAnswer {
  const recommended = question.recommendedOptionIds ?? [];
  return {
    questionId: question.id,
    selectedOptionIds: answer.delegated ? [] : answer.selected,
    ...(!answer.delegated &&
    (question.kind === 'text' || answer.customSelected) &&
    answer.text.trim()
      ? { text: answer.text.trim() }
      : {}),
    delegated: answer.delegated,
    usedRecommendation:
      !answer.delegated &&
      answer.selected.length === recommended.length &&
      answer.selected.every((id) => recommended.includes(id)) &&
      (question.recommendedText ?? '') ===
        (question.kind === 'text' || answer.customSelected ? answer.text.trim() : '') &&
      (recommended.length > 0 || Boolean(question.recommendedText)),
  };
}

export function answerMarker(question: UserInputQuestion, answer?: AnswerDraft): string {
  if (!hasAnswer(question, answer)) return question.required ? '○' : '·';
  if (answer?.delegated) return '↪';
  return toAnswer(question, answer ?? EMPTY_ANSWER).usedRecommendation ? '★' : '✓';
}

export function progressBar(completed: number, total: number, width: number): string {
  const filled = total > 0 ? Math.round((completed / total) * width) : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
}

/** Match one-based SGR mouse cells against Ink's measured zero-based rectangle. */
export function pointInsideElement(element: DOMElement | null, x: number, y: number): boolean {
  if (!element) return false;
  const measured = measureElement(element);
  return (
    x >= measured.x + 1 &&
    x <= measured.x + measured.width &&
    y >= measured.y + 1 &&
    y <= measured.y + measured.height
  );
}

export function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

export function visibleWindow<T>(
  items: readonly T[],
  selected: number,
  limit: number,
): {
  items: Array<{ item: T; index: number }>;
  above: number;
  below: number;
} {
  const size = Math.max(1, Math.min(limit, items.length));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
  return {
    items: items
      .slice(start, start + size)
      .map((item, offset) => ({ item, index: start + offset })),
    above: start,
    below: Math.max(0, items.length - start - size),
  };
}
