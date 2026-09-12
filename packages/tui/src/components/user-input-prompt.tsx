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
type AnswerDraft = {
  selected: string[];
  text: string;
  customSelected: boolean;
  delegated: boolean;
};
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
        customSelected: Boolean(target.recommendedText),
        delegated: false,
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
        updateAnswer((current) => ({
          ...current,
          selected: question.kind === 'single_select' ? [] : current.selected,
          text: current.text + printable,
          customSelected: true,
          delegated: false,
        }));
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
    if (input === 'D') {
      setDraft((current) => {
        const next = { ...current };
        for (const item of allQuestions) {
          const answer = current[item.id] ?? EMPTY_ANSWER;
          if (!hasAnswer(item, answer)) {
            next[item.id] = {
              ...answer,
              selected: [],
              customSelected: false,
              delegated: true,
            };
          }
        }
        return next;
      });
      setNotice('Unanswered decisions delegated to the model.');
      return;
    }
    if (input === 'd') {
      updateAnswer((current) => ({
        ...current,
        selected: [],
        customSelected: false,
        delegated: !current.delegated,
      }));
      setNotice(value.delegated ? 'Delegation cleared.' : 'Decision delegated to the model.');
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
      updateAnswer((current) => ({
        ...current,
        selected: question.kind === 'single_select' ? [] : current.selected,
        customSelected: true,
        delegated: false,
      }));
      setEditing(true);
      setNotice('');
      return;
    }
    if (key.upArrow) {
      setOptionIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      const rows = (question.options?.length ?? 0) + (question.allowCustomResponse ? 1 : 0);
      setOptionIndex((current) => Math.min(Math.max(0, rows - 1), current + 1));
      return;
    }
    if ((input === ' ' || key.return) && question.kind !== 'text') {
      const option = question.options?.[optionIndex];
      if (!option && question.allowCustomResponse) {
        updateAnswer((current) => ({
          ...current,
          selected: question.kind === 'single_select' ? [] : current.selected,
          customSelected: question.kind === 'single_select' ? true : !current.customSelected,
          delegated: false,
        }));
        if (key.return) setEditing(true);
        setNotice('Manual answer selected.');
        return;
      }
      if (!option) return;
      updateAnswer((current) => ({
        ...current,
        selected:
          question.kind === 'multi_select'
            ? current.selected.includes(option.id)
              ? current.selected.filter((id) => id !== option.id)
              : [...current.selected, option.id]
            : [option.id],
        customSelected: question.kind === 'single_select' ? false : current.customSelected,
        delegated: false,
      }));
      setNotice(question.kind === 'multi_select' ? 'Selection updated.' : 'Answer selected.');
    }
  });

  const compact = terminalRows < 20;
  const wide = !compact && terminalColumns >= 96;
  const questionRows = compact
    ? 1
    : wide
      ? Math.min(12, Math.max(4, terminalRows - 14))
      : Math.min(4, Math.max(2, terminalRows - 19));
  const optionRows = compact
    ? 2
    : wide
      ? Math.min(10, Math.max(3, terminalRows - 17))
      : Math.min(6, Math.max(3, terminalRows - questionRows - 15));
  const visibleQuestions = visibleWindow(questions, questionIndex, questionRows);
  const visibleOptions = visibleWindow(question.options ?? [], optionIndex, optionRows);
  const answeredTotal = allQuestions.filter((item) => hasAnswer(item, draft[item.id])).length;
  const activeQuestionNumber = allQuestions.findIndex((item) => item.id === question.id) + 1;

  const questionList = (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="white">
          QUESTIONS
        </Text>
        <Text dimColor>
          {completedInTab}/{questions.length}
        </Text>
      </Box>
      {visibleQuestions.above ? <Text dimColor> ↑ {visibleQuestions.above} earlier</Text> : null}
      {visibleQuestions.items.map(({ item, index }) => (
        <Text key={item.id} color={index === questionIndex ? 'cyan' : undefined}>
          {index === questionIndex ? '›' : ' '} {answerMarker(item, draft[item.id])} {index + 1}.{' '}
          {truncate(
            item.prompt,
            wide ? Math.max(12, Math.floor(terminalColumns * 0.3) - 10) : terminalColumns - 15,
          )}
        </Text>
      ))}
      {visibleQuestions.below ? <Text dimColor> ↓ {visibleQuestions.below} later</Text> : null}
    </Box>
  );

  const answerPanel = (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text color="gray">
        QUESTION {questionIndex + 1}/{questions.length}
        {!compact && allQuestions.length !== questions.length
          ? ` · FORM ${activeQuestionNumber}/${allQuestions.length}`
          : ''}{' '}
        · {compact ? '←/→ navigate' : question.kind.replace('_', ' ')}
      </Text>
      <Text bold color="white">
        {question.prompt}
        {question.required ? <Text color="yellow"> *</Text> : <Text dimColor> optional</Text>}
      </Text>
      {!compact && question.description ? <Text dimColor>{question.description}</Text> : null}
      {!compact && question.recommendationReason ? (
        <Box borderStyle="single" borderColor="cyan" paddingX={1} marginY={1}>
          <Text color="cyan">
            ★ RECOMMENDED · {truncate(question.recommendationReason, terminalColumns - 28)}
          </Text>
        </Box>
      ) : null}
      {value.delegated ? (
        <Text backgroundColor="blue" color="white">
          ↪ YOU DECIDE · This question is delegated to the model
        </Text>
      ) : null}

      {question.kind === 'text' ? (
        <ManualAnswer
          value={value.text}
          placeholder={question.placeholder}
          editing={editing}
          selected={true}
          focused={true}
          kind="text"
          width={wide ? Math.max(24, Math.floor(terminalColumns * 0.62)) : terminalColumns - 8}
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
              <Text
                key={option.id}
                color={index === optionIndex ? 'cyan' : selected ? 'green' : undefined}
              >
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
              selected={value.customSelected}
              focused={optionIndex === (question.options?.length ?? 0)}
              kind={question.kind}
              width={wide ? Math.max(24, Math.floor(terminalColumns * 0.62)) : terminalColumns - 8}
            />
          ) : null}
        </>
      )}
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      height={Math.max(10, terminalRows)}
      overflow="hidden"
      paddingX={1}
    >
      <Box flexDirection="column" flexShrink={0}>
        <Box justifyContent="space-between">
          <Text bold backgroundColor="cyan" color="black">
            {' CLARIFY '}
          </Text>
          <Text dimColor>
            {answeredTotal}/{allQuestions.length} answered{' '}
            {progressBar(answeredTotal, allQuestions.length, compact ? 6 : 10)}
          </Text>
        </Box>
        <Text bold color="white">
          {truncate(pending.request.title, Math.max(20, terminalColumns - 6))}
        </Text>
        {!compact && pending.request.description ? (
          <Text dimColor>
            {truncate(pending.request.description, Math.max(20, terminalColumns - 6))}
          </Text>
        ) : null}

        <Text>{renderTabs(pending.request, activeTabIndex, draft, terminalColumns - 6)}</Text>
        {!compact ? (
          <Text color="cyan">
            CATEGORY {activeTabIndex + 1}/{pending.request.tabs.length} · {activeTab.label}
          </Text>
        ) : null}
      </Box>

      {wide ? (
        <Box flexDirection="row" flexGrow={1} overflow="hidden" gap={1} marginTop={1}>
          <Box
            flexDirection="column"
            width={Math.min(42, Math.max(30, Math.floor(terminalColumns * 0.34)))}
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            overflow="hidden"
          >
            {questionList}
          </Box>
          <Box
            flexDirection="column"
            flexGrow={1}
            borderStyle="single"
            borderColor="cyan"
            paddingX={1}
            overflow="hidden"
          >
            {answerPanel}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={compact ? 0 : 1}>
          {!compact ? questionList : null}
          {!compact ? (
            <Text color="gray">{'─'.repeat(Math.max(8, terminalColumns - 6))}</Text>
          ) : null}
          {answerPanel}
        </Box>
      )}

      <Box flexDirection="column" flexShrink={0}>
        {!compact && notice ? (
          <Text color={validation.valid ? 'green' : 'yellow'}>{notice}</Text>
        ) : null}
        <Text dimColor>
          {compact
            ? `Tab category · ←→ q · d decide · s submit`
            : `Tab/1-${pending.request.tabs.length} category · ←→ question · ↑↓ option · Space/Enter select`}
        </Text>
        {!compact ? (
          <Box justifyContent="space-between">
            <Text dimColor>e manual · r recommended · d you decide</Text>
            <Text dimColor>R recommend all · D delegate blanks · s submit</Text>
          </Box>
        ) : null}
        <Text color={validation.valid ? 'green' : 'yellow'}>
          {compact && notice
            ? notice
            : validation.valid
              ? 'Ready · Submit answers with s'
              : `${validation.missingCount} required answer(s) missing`}
        </Text>
      </Box>
    </Box>
  );
}

const EMPTY_ANSWER: AnswerDraft = {
  selected: [],
  text: '',
  customSelected: false,
  delegated: false,
};

function ManualAnswer({
  value,
  placeholder,
  editing,
  selected,
  focused,
  kind,
  width,
}: {
  value: string;
  placeholder?: string | undefined;
  editing: boolean;
  selected: boolean;
  focused: boolean;
  kind: UserInputQuestion['kind'];
  width: number;
}): React.ReactElement {
  const shown = value || placeholder || 'Optional manual answer';
  const prefix =
    kind === 'text'
      ? `${focused ? '›' : ' '} Answer:`
      : `${focused ? '›' : ' '} ${
          kind === 'multi_select' ? (selected ? '[x]' : '[ ]') : selected ? '(●)' : '( )'
        } Other:`;
  return (
    <Text color={editing || focused ? 'cyan' : undefined}>
      {prefix} {truncate(shown, Math.max(12, width))}
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
          customSelected: Boolean(question.recommendedText),
          delegated: false,
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

function toAnswer(question: UserInputQuestion, answer: AnswerDraft): UserInputAnswer {
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

function answerMarker(question: UserInputQuestion, answer?: AnswerDraft): string {
  if (!hasAnswer(question, answer)) return question.required ? '○' : '·';
  if (answer?.delegated) return '↪';
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

function progressBar(completed: number, total: number, width: number): string {
  const filled = total > 0 ? Math.round((completed / total) * width) : 0;
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
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
