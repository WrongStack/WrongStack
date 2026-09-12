import type { UserInputAnswer, UserInputQuestion, UserInputRequest } from '@wrongstack/core/types';
import { Check, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getWSClient } from '@/lib/ws-client';
import {
  activeSessionLaneId,
  pendingUserInputForSession,
  useActiveSessionId,
  useConfigStore,
  useSessionTabStore,
  useUserInputStore,
} from '@/stores';
import type { WSServerMessage } from '@/types';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

type Draft = Record<string, { selected: string[]; text: string }>;

export function UserInputDialog() {
  const wsUrl = useConfigStore((state) => state.wsUrl);
  const activeSessionId = useActiveSessionId();
  const queues = useUserInputStore((state) => state.queues);
  const entry = pendingUserInputForSession(queues, activeSessionId);
  const request = entry?.request ?? null;
  const [activeTab, setActiveTab] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [validationMessage, setValidationMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const client = getWSClient(wsUrl);
    const offRequested = client.on('user.input_requested', (message: WSServerMessage) => {
      if (message.type !== 'user.input_requested') return;
      const sessionId = message.payload.sessionId;
      if (!sessionId) return;
      useUserInputStore.getState().enqueue({ sessionId, request: message.payload.request });
      if (sessionId !== activeSessionLaneId()) {
        useSessionTabStore.getState().setAttention(sessionId, true);
      }
    });
    const offResolved = client.on('user.input_resolved', (message: WSServerMessage) => {
      if (message.type !== 'user.input_resolved') return;
      useUserInputStore.getState().resolve(message.payload.requestId);
    });
    return () => {
      offRequested();
      offResolved();
    };
  }, [wsUrl]);

  useEffect(() => {
    if (!request || request.id === requestIdRef.current) return;
    requestIdRef.current = request.id;
    setActiveTab(0);
    setDraft(initialDraft(request));
    setValidationMessage('');
    setSubmitting(false);
  }, [request]);

  const questions = useMemo(() => request?.tabs.flatMap((tab) => tab.questions) ?? [], [request]);
  const missing = questions.filter(
    (question) => question.required && !hasAnswer(draft[question.id]),
  );
  const valid = missing.length === 0;
  if (!request || !entry) return null;
  const tab = request.tabs[activeTab] ?? request.tabs[0]!;

  const submit = () => {
    if (!valid) {
      const first = missing[0]!;
      const targetTab = request.tabs.findIndex((item) =>
        item.questions.some((question) => question.id === first.id),
      );
      setActiveTab(Math.max(0, targetTab));
      setValidationMessage(`Answer required: ${first.prompt}`);
      window.requestAnimationFrame(() =>
        document.getElementById(`user-input-${first.id}`)?.focus(),
      );
      return;
    }
    const answers: UserInputAnswer[] = questions.map((question) => {
      const value = draft[question.id] ?? { selected: [], text: '' };
      return {
        questionId: question.id,
        selectedOptionIds: value.selected,
        ...(value.text.trim() ? { text: value.text.trim() } : {}),
        usedRecommendation: isRecommendation(question, value),
      };
    });
    setSubmitting(true);
    const sent = getWSClient(wsUrl).send({
      type: 'user.input_submit',
      payload: {
        sessionId: entry.sessionId,
        response: { requestId: request.id, status: 'submitted', answers },
      },
    });
    if (!sent) {
      setSubmitting(false);
      setValidationMessage('Could not send the answers. Check the connection and try again.');
    }
  };

  const applyRecommendations = (scope: 'tab' | 'all') => {
    const targets = scope === 'all' ? questions : tab.questions;
    setDraft((current) => {
      const next = { ...current };
      for (const question of targets) {
        if (!hasRecommendation(question)) continue;
        next[question.id] = {
          selected: [...(question.recommendedOptionIds ?? [])],
          text: question.recommendedText ?? '',
        };
      }
      return next;
    });
    setValidationMessage('Recommended answers applied.');
  };

  const queuedForSession = queues[entry.sessionId]?.length ?? 1;

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        className="!flex flex-col gap-0 overflow-hidden !p-0"
        style={{
          boxSizing: 'border-box',
          width: 'calc(100vw - 1rem)',
          maxWidth: '48rem',
          maxHeight: 'calc(100dvh - 1rem)',
        }}
      >
        <DialogHeader className="shrink-0 border-b px-4 py-4 pr-10 sm:px-6">
          <DialogTitle>{request.title}</DialogTitle>
          {request.description && <DialogDescription>{request.description}</DialogDescription>}
          {queuedForSession > 1 && (
            <p className="text-left text-xs text-muted-foreground">
              Form 1 of {queuedForSession} waiting in this session
            </p>
          )}
        </DialogHeader>
        {request.tabs.length > 1 && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 pt-2" role="tablist">
            {request.tabs.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={index === activeTab}
                onClick={() => setActiveTab(index)}
                className={`rounded-t-md px-3 py-2 text-sm ${index === activeTab ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}`}
              >
                {item.label}{' '}
                <span className="text-[10px] text-muted-foreground">
                  {answeredCount(item.questions, draft)}/{item.questions.length}
                </span>
              </button>
            ))}
          </div>
        )}
        <div
          className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-6"
          data-testid="user-input-scroll-region"
        >
          {tab.description && <p className="text-sm text-muted-foreground">{tab.description}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {answeredCount(tab.questions, draft)}/{tab.questions.length} answered
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => applyRecommendations('tab')}
              >
                Apply tab recommendations
              </Button>
              {request.tabs.length > 1 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => applyRecommendations('all')}
                >
                  Apply all recommendations
                </Button>
              )}
            </div>
          </div>
          {tab.questions.map((question) => {
            const answered = hasAnswer(draft[question.id]);
            return (
              <div
                key={question.id}
                id={`user-input-${question.id}`}
                tabIndex={-1}
                className={`rounded-lg border p-3 outline-none focus-visible:ring-2 focus-visible:ring-primary ${question.required && !answered ? 'border-warning/50' : 'border-border'}`}
              >
                <Question
                  question={question}
                  value={draft[question.id] ?? { selected: [], text: '' }}
                  onChange={(value) => {
                    setDraft((current) => ({ ...current, [question.id]: value }));
                    setValidationMessage('');
                  }}
                />
              </div>
            );
          })}
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
          <span
            className={`mr-auto text-xs ${validationMessage ? 'text-warning' : 'text-muted-foreground'}`}
            aria-live="polite"
          >
            {validationMessage ||
              (valid ? 'Ready to submit' : `${missing.length} required answer(s) missing`)}
          </span>
          <Button disabled={submitting} onClick={submit}>
            {submitting ? 'Submitting…' : (request.submitLabel ?? 'Submit answers')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Question({
  question,
  value,
  onChange,
}: {
  question: UserInputQuestion;
  value: Draft[string];
  onChange: (value: Draft[string]) => void;
}) {
  const recommended = new Set(question.recommendedOptionIds ?? []);
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">
        {question.prompt}
        {question.required && <span className="text-destructive"> *</span>}
      </legend>
      {question.description && (
        <p className="text-xs text-muted-foreground">{question.description}</p>
      )}
      {question.recommendationReason && (
        <div className="flex gap-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span>
            <b>Recommendation:</b> {question.recommendationReason}
          </span>
        </div>
      )}
      {question.kind === 'text' ? (
        <textarea
          className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
          placeholder={question.placeholder}
          value={value.text}
          onChange={(event) => onChange({ ...value, text: event.target.value })}
        />
      ) : (
        <div className="grid gap-2">
          {question.options?.map((option) => {
            const checked = value.selected.includes(option.id);
            return (
              <label
                key={option.id}
                className={`flex cursor-pointer gap-3 rounded-md border p-3 ${checked ? 'border-primary bg-primary/5' : ''}`}
              >
                <input
                  type={question.kind === 'multi_select' ? 'checkbox' : 'radio'}
                  name={question.id}
                  checked={checked}
                  onChange={() =>
                    onChange({
                      ...value,
                      selected:
                        question.kind === 'multi_select'
                          ? checked
                            ? value.selected.filter((id) => id !== option.id)
                            : [...value.selected, option.id]
                          : [option.id],
                    })
                  }
                />
                <span className="min-w-0 text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    {option.label}
                    {recommended.has(option.id) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                        <Check className="h-3 w-3" />
                        Recommended
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {question.allowCustomResponse && (
            <input
              className="rounded-md border bg-background px-3 py-2 text-sm"
              placeholder={question.placeholder ?? 'Add a custom answer (optional)'}
              value={value.text}
              onChange={(event) => onChange({ ...value, text: event.target.value })}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}

function initialDraft(request: UserInputRequest): Draft {
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
function hasAnswer(value?: Draft[string]): boolean {
  return Boolean(value && (value.selected.length > 0 || value.text.trim()));
}
function answeredCount(questions: UserInputQuestion[], draft: Draft): number {
  return questions.filter((question) => hasAnswer(draft[question.id])).length;
}
function hasRecommendation(question: UserInputQuestion): boolean {
  return Boolean(question.recommendedOptionIds?.length || question.recommendedText);
}
function isRecommendation(question: UserInputQuestion, value: Draft[string]): boolean {
  const recommended = question.recommendedOptionIds ?? [];
  const selectionMatches =
    value.selected.length === recommended.length &&
    value.selected.every((id) => recommended.includes(id));
  const textMatches = (question.recommendedText ?? '') === value.text.trim();
  return (
    selectionMatches && textMatches && (recommended.length > 0 || Boolean(question.recommendedText))
  );
}
