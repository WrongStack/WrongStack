import type { EventBus } from '@wrongstack/core/kernel';
import type {
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
} from '@wrongstack/core/types';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from '../ink.js';

export type PendingUserInput = {
  request: UserInputRequest;
  resolve: (response: UserInputResponse) => void;
};
type AnswerDraft = { selected: string[]; text: string };
type Draft = Record<string, AnswerDraft>;

export function usePendingUserInput(events: EventBus): PendingUserInput | null {
  const [pending, setPending] = useState<PendingUserInput | null>(null);
  useEffect(() => {
    const offRequest = events.on('user.input_requested', (event) =>
      setPending({ request: event.request, resolve: event.resolve }),
    );
    const offResolved = events.on('user.input_resolved', (event) =>
      setPending((current) => (current?.request.id === event.requestId ? null : current)),
    );
    return () => {
      offRequest();
      offResolved();
    };
  }, [events]);
  return pending;
}

export function UserInputPrompt({ pending }: { pending: PendingUserInput }): React.ReactElement {
  const { stdout } = useStdout();
  const terminalRows = stdout?.rows ?? 24;
  const terminalColumns = stdout?.columns ?? 80;
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [optionIndex, setOptionIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(pending.request));

  const allQuestions = useMemo(
    () => pending.request.tabs.flatMap((tab) => tab.questions),
    [pending.request],
  );
  const activeTab = pending.request.tabs[activeTabIndex] ?? pending.request.tabs[0]!;
  const questions = activeTab.questions;
  const question = questions[Math.min(questionIndex, questions.length - 1)]!;
  const value = draft[question.id] ?? EMPTY_ANSWER;
  const validation = validateDraft(allQuestions, draft);
  const completedInTab = questions.filter((item) => hasAnswer(item, draft[item.id])).length;

  const changeTab = (nextIndex: number) => {
    const bounded = (nextIndex + pending.request.tabs.length) % pending.request.tabs.length;
    setActiveTabIndex(bounded);
    setQuestionIndex(0);
    setOptionIndex(0);
    setEditing(false);
    setNotice('');
  };
  const changeQuestion = (nextIndex: number) => {
    setQuestionIndex(Math.max(0, Math.min(questions.length - 1, nextIndex)));
    setOptionIndex(0);
    setEditing(false);
    setNotice('');
  };
  const updateAnswer = (updater: (current: AnswerDraft) => AnswerDraft) => {
    setDraft((current) => ({
      ...current,
      [question.id]: updater(current[question.id] ?? EMPTY_ANSWER),
    }));
  };
  const applyRecommendation = (target: UserInputQuestion) => {
    setDraft((current) => ({
      ...current,
      [target.id]: {
        selected: [...(target.recommendedOptionIds ?? [])],
        text: target.recommendedText ?? '',
      },
    }));
    setNotice('Recommended answer applied.');
  };
  const submit = () => {
    const currentValidation = validateDraft(allQuestions, draft);
    if (!currentValidation.valid) {
      const missing = currentValidation.firstMissing!;
      const tabIndex = pending.request.tabs.findIndex((tab) =>
        tab.questions.some((item) => item.id === missing.id),
      );
      const tabQuestions = pending.request.tabs[tabIndex]?.questions ?? [];
      changeTab(Math.max(0, tabIndex));
      setQuestionIndex(
        Math.max(
          0,
          tabQuestions.findIndex((item) => item.id === missing.id),
        ),
      );
      setNotice(`Required answer missing: ${missing.prompt}`);
      return;
    }
    pending.resolve({
      requestId: pending.request.id,
      status: 'submitted',
      answers: allQuestions.map((item) => toAnswer(item, draft[item.id] ?? EMPTY_ANSWER)),
    });
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape || key.return) {
        setEditing(false);
        setNotice(value.text.trim() ? 'Manual answer saved.' : 'Manual answer left blank.');
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'u') {
        updateAnswer((current) => ({ ...current, text: '' }));
        return;
      }
      if (key.backspace || key.delete) {
        updateAnswer((current) => ({ ...current, text: current.text.slice(0, -1) }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const printable = input.replace(/[\r\n\t]+/g, ' ');
        updateAnswer((current) => ({ ...current, text: current.text + printable }));
      }
      return;
    }

    if ((key.ctrl && input.toLowerCase() === 's') || input === 's') {
      submit();
      return;
    }
    if (key.tab) {
      changeTab(activeTabIndex + (key.shift ? -1 : 1));
      return;
    }
    if (/^[1-8]$/.test(input)) {
      const requestedTab = Number(input) - 1;
      if (requestedTab < pending.request.tabs.length) changeTab(requestedTab);
      return;
    }
    if (key.leftArrow || input === '[') {
      changeQuestion(questionIndex - 1);
      return;
    }
    if (key.rightArrow || input === ']') {
      changeQuestion(questionIndex + 1);
      return;
    }
    if (input === 'R') {
      for (const item of allQuestions) applyRecommendation(item);
      setNotice('All recommended answers applied.');
      return;
    }
    if (input.toLowerCase() === 'r' && hasRecommendation(question)) {
      applyRecommendation(question);
      return;
    }
    if (
      (input.toLowerCase() === 'e' && canEditText(question)) ||
      (key.return && question.kind === 'text')
    ) {
      setEditing(true);
      setNotice('');
      return;
    }
    if (key.upArrow) {
      setOptionIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setOptionIndex((current) => Math.min((question.options?.length ?? 1) - 1, current + 1));
      return;
    }
    if ((input === ' ' || key.return) && question.kind !== 'text') {
      const option = question.options?.[optionIndex];
      if (!option) return;
      updateAnswer((current) => ({
        ...current,
        selected:
          question.kind === 'multi_select'
            ? current.selected.includes(option.id)
              ? current.selected.filter((id) => id !== option.id)
              : [...current.selected, option.id]
            : [option.id],
      }));
      setNotice(question.kind === 'multi_select' ? 'Selection updated.' : 'Answer selected.');
    }
  });

  const compact = terminalRows < 20;
  const questionRows = compact ? 1 : Math.min(5, Math.max(3, terminalRows - 17));
  const optionRows = compact ? 2 : Math.min(6, Math.max(3, terminalRows - questionRows - 13));
  const visibleQuestions = visibleWindow(questions, questionIndex, questionRows);
  const visibleOptions = visibleWindow(question.options ?? [], optionIndex, optionRows);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      height={Math.max(10, terminalRows)}
      overflow="hidden"
      paddingX={1}
    >
      <Box flexDirection="column" flexShrink={0}>
        <Text bold color="cyan">
          ? {truncate(pending.request.title, Math.max(20, terminalColumns - 6))}
        </Text>
        {!compact && pending.request.description ? (
          <Text dimColor>
            {truncate(pending.request.description, Math.max(20, terminalColumns - 6))}
          </Text>
        ) : null}

        <Text>{renderTabs(pending.request, activeTabIndex, draft, terminalColumns - 6)}</Text>
        <Text dimColor>
          Category {activeTabIndex + 1}/{pending.request.tabs.length} · answered {completedInTab}/
          {questions.length}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {!compact ? (
          <Box flexDirection="column">
            {visibleQuestions.above ? (
              <Text dimColor> ↑ {visibleQuestions.above} more question(s)</Text>
            ) : null}
            {visibleQuestions.items.map(({ item, index }) => (
              <Text key={item.id} color={index === questionIndex ? 'cyan' : undefined}>
                {index === questionIndex ? '›' : ' '} {answerMarker(item, draft[item.id])}{' '}
                {index + 1}. {truncate(item.prompt, Math.max(18, terminalColumns - 15))}
              </Text>
            ))}
            {visibleQuestions.below ? (
              <Text dimColor> ↓ {visibleQuestions.below} more question(s)</Text>
            ) : null}
          </Box>
        ) : null}
        <Text bold>
          {question.prompt}
          {question.required ? <Text color="yellow"> *</Text> : <Text dimColor> optional</Text>}
        </Text>
        {!compact && question.description ? <Text dimColor>{question.description}</Text> : null}
        {!compact && question.recommendationReason ? (
          <Text color="cyan">
            ★ Recommendation: {truncate(question.recommendationReason, terminalColumns - 22)}
          </Text>
        ) : null}

        {question.kind === 'text' ? (
          <ManualAnswer
            value={value.text}
            placeholder={question.placeholder}
            editing={editing}
            width={terminalColumns - 8}
          />
        ) : (
          <>
            {visibleOptions.above ? (
              <Text dimColor> ↑ {visibleOptions.above} more option(s)</Text>
            ) : null}
            {visibleOptions.items.map(({ item: option, index }) => {
              const selected = value.selected.includes(option.id);
              const recommended = question.recommendedOptionIds?.includes(option.id);
              return (
                <Text key={option.id} color={index === optionIndex ? 'cyan' : undefined}>
                  {index === optionIndex ? '›' : ' '}{' '}
                  {question.kind === 'multi_select'
                    ? selected
                      ? '[x]'
                      : '[ ]'
                    : selected
                      ? '(●)'
                      : '( )'}{' '}
                  {option.label}
                  {recommended ? ' ★ recommended' : ''}
                  {!compact && option.description ? ` — ${option.description}` : ''}
                </Text>
              );
            })}
            {visibleOptions.below ? (
              <Text dimColor> ↓ {visibleOptions.below} more option(s)</Text>
            ) : null}
            {question.allowCustomResponse ? (
              <ManualAnswer
                value={value.text}
                placeholder={question.placeholder ?? 'Optional manual answer / note'}
                editing={editing}
                width={terminalColumns - 8}
              />
            ) : null}
          </>
        )}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {!compact && notice ? (
          <Text color={validation.valid ? 'green' : 'yellow'}>{notice}</Text>
        ) : null}
        <Text dimColor>
          {compact
            ? `Tab category · ←→ question · ↑↓ option · e manual · s submit`
            : `Tab/1-${pending.request.tabs.length} category · ←→ question · ↑↓ option · Space/Enter select`}
        </Text>
        {!compact ? (
          <Text dimColor>
            e edit manual answer · r recommended · R all recommendations · s submit
          </Text>
        ) : null}
        <Text color={validation.valid ? 'green' : 'yellow'}>
          {compact && notice
            ? notice
            : validation.valid
              ? `Ready · ${pending.request.submitLabel ?? 'Submit answers'} with s`
              : `${validation.missingCount} required answer(s) missing`}
        </Text>
      </Box>
    </Box>
  );
}

const EMPTY_ANSWER: AnswerDraft = { selected: [], text: '' };

function ManualAnswer({
  value,
  placeholder,
  editing,
  width,
}: {
  value: string;
  placeholder?: string | undefined;
  editing: boolean;
  width: number;
}): React.ReactElement {
  const shown = value || placeholder || 'Optional manual answer';
  return (
    <Text color={editing ? 'cyan' : undefined}>
      {editing ? '✎' : ' '} Manual: {truncate(shown, Math.max(12, width))}
      {editing ? <Text inverse> </Text> : <Text dimColor> [e to edit]</Text>}
    </Text>
  );
}

export function initialDraft(request: UserInputRequest): Draft {
  return Object.fromEntries(
    request.tabs.flatMap((tab) =>
      tab.questions.map((question) => [
        question.id,
        {
          selected: [...(question.recommendedOptionIds ?? [])],
          text: question.recommendedText ?? '',
        },
      ]),
    ),
  );
}

function canEditText(question: UserInputQuestion): boolean {
  return question.kind === 'text' || question.allowCustomResponse === true;
}

function hasRecommendation(question: UserInputQuestion): boolean {
  return Boolean(question.recommendedOptionIds?.length || question.recommendedText);
}

function hasAnswer(question: UserInputQuestion, answer?: AnswerDraft): boolean {
  if (!answer) return false;
  return question.kind === 'text'
    ? Boolean(answer.text.trim())
    : answer.selected.length > 0 || Boolean(answer.text.trim());
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

function toAnswer(question: UserInputQuestion, answer: AnswerDraft): UserInputAnswer {
  const recommended = question.recommendedOptionIds ?? [];
  return {
    questionId: question.id,
    selectedOptionIds: answer.selected,
    ...(answer.text.trim() ? { text: answer.text.trim() } : {}),
    usedRecommendation:
      answer.selected.length === recommended.length &&
      answer.selected.every((id) => recommended.includes(id)) &&
      (question.recommendedText ?? '') === answer.text.trim() &&
      (recommended.length > 0 || Boolean(question.recommendedText)),
  };
}

function answerMarker(question: UserInputQuestion, answer?: AnswerDraft): string {
  if (!hasAnswer(question, answer)) return question.required ? '○' : '·';
  return toAnswer(question, answer ?? EMPTY_ANSWER).usedRecommendation ? '★' : '✓';
}

function renderTabs(
  request: UserInputRequest,
  active: number,
  draft: Draft,
  width: number,
): string {
  const labels = request.tabs.map((tab, index) => {
    const done = tab.questions.filter((question) => hasAnswer(question, draft[question.id])).length;
    return `${index + 1}${index === active ? '●' : '○'} ${tab.label} ${done}/${tab.questions.length}`;
  });
  return truncate(labels.join('  '), Math.max(18, width));
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 1))}…`;
}

function visibleWindow<T>(
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
