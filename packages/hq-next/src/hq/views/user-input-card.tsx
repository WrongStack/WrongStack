/**
 * The answer form for a question an agent asked through `ask_user`, mirrored
 * into HQ. Choices, free text and "let the agent decide" are answered per
 * question; the whole form is sent at once. Rendered by the Inbox.
 */

import type { UserInputQuestion, UserInputResponse } from '@wrongstack/contracts/types';
import type * as React from 'react';
import { useState } from 'react';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import type { PendingUserInput } from '../domain/use-pending-user-inputs.js';

type InputDraftAnswer = {
  selected: string[];
  text: string;
  customSelected: boolean;
  delegated: boolean;
};
type InputDraft = Record<string, InputDraftAnswer>;
const EMPTY_INPUT_DRAFT: InputDraftAnswer = {
  selected: [],
  text: '',
  customSelected: false,
  delegated: false,
};
export function UserInputCard({
  input,
  sending,
  onSubmit,
}: {
  input: PendingUserInput;
  sending: boolean;
  onSubmit: (input: PendingUserInput, response: UserInputResponse) => Promise<void>;
}): React.ReactElement {
  const request = input.request;
  const questions = request.tabs.flatMap((tab) => tab.questions);
  const [activeTab, setActiveTab] = useState(0);
  const [draft, setDraft] = useState<InputDraft>(() =>
    Object.fromEntries(
      questions.map((q) => [
        q.id,
        {
          selected: [...(q.recommendedOptionIds ?? [])],
          text: q.recommendedText ?? '',
          customSelected: Boolean(q.recommendedText),
          delegated: false,
        },
      ]),
    ),
  );
  const tab = request.tabs[activeTab] ?? request.tabs[0]!;
  const valid = questions.every(
    (q) =>
      !q.required ||
      Boolean(
        draft[q.id]?.delegated ||
          draft[q.id]?.selected.length ||
          (draft[q.id]?.customSelected && draft[q.id]?.text.trim()),
      ),
  );
  const submit = () => {
    if (!valid) return;
    void onSubmit(input, {
      requestId: request.id,
      status: 'submitted',
      answers: questions.map((q) => {
        const value = draft[q.id] ?? EMPTY_INPUT_DRAFT;
        const rec = q.recommendedOptionIds ?? [];
        return {
          questionId: q.id,
          selectedOptionIds: value.delegated ? [] : value.selected,
          ...(!value.delegated && (q.kind === 'text' || value.customSelected) && value.text.trim()
            ? { text: value.text.trim() }
            : {}),
          delegated: value.delegated,
          usedRecommendation:
            !value.delegated &&
            value.selected.length === rec.length &&
            value.selected.every((id) => rec.includes(id)) &&
            (q.recommendedText ?? '') ===
              (q.kind === 'text' || value.customSelected ? value.text.trim() : '') &&
            (rec.length > 0 || Boolean(q.recommendedText)),
        };
      }),
    });
  };
  const delegateUnanswered = () => {
    setDraft((current) => {
      const next = { ...current };
      for (const question of questions) {
        const value = current[question.id] ?? EMPTY_INPUT_DRAFT;
        if (
          !value.delegated &&
          value.selected.length === 0 &&
          !(value.customSelected && value.text.trim())
        ) {
          next[question.id] = {
            ...value,
            selected: [],
            customSelected: false,
            delegated: true,
          };
        }
      }
      return next;
    });
  };
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <h3 className="font-semibold">{request.title}</h3>
          {request.description && (
            <p className="text-xs text-muted-foreground">{request.description}</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {input.projectId} · {input.clientId}
          </p>
        </div>
        {request.tabs.length > 1 && (
          <div className="flex gap-1 overflow-x-auto">
            {request.tabs.map((item, index) => (
              <Button
                key={item.id}
                size="sm"
                variant={index === activeTab ? 'secondary' : 'ghost'}
                onClick={() => setActiveTab(index)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )}
        <div className="space-y-5">
          {tab.questions.map((q) => (
            <HqQuestion
              key={q.id}
              question={q}
              value={draft[q.id] ?? EMPTY_INPUT_DRAFT}
              onChange={(value) => setDraft((old) => ({ ...old, [q.id]: value }))}
            />
          ))}
        </div>
        <Button variant="ghost" onClick={delegateUnanswered}>
          Let model decide unanswered
        </Button>
        <Button disabled={!valid || sending} onClick={submit}>
          {sending ? 'Submitting…' : (request.submitLabel ?? 'Submit answers')}
        </Button>
      </CardContent>
    </Card>
  );
}
function HqQuestion({
  question,
  value,
  onChange,
}: {
  question: UserInputQuestion;
  value: InputDraftAnswer;
  onChange: (value: InputDraftAnswer) => void;
}): React.ReactElement {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {question.prompt}
        {question.required ? ' *' : ''}
      </legend>
      {question.description && (
        <p className="text-xs text-muted-foreground">{question.description}</p>
      )}
      {question.recommendationReason && (
        <p className="rounded border border-primary/30 bg-primary/5 p-2 text-xs">
          <b>Recommended:</b> {question.recommendationReason}
        </p>
      )}
      {question.kind === 'text' ? (
        <textarea
          className="min-h-20 w-full rounded border bg-background p-2 text-sm"
          value={value.text}
          placeholder={question.placeholder}
          onChange={(event) =>
            onChange({
              ...value,
              text: event.target.value,
              customSelected: true,
              delegated: false,
            })
          }
        />
      ) : (
        <div className="space-y-2">
          {question.options?.map((option) => {
            const checked = value.selected.includes(option.id);
            return (
              <label key={option.id} className="flex gap-2 rounded border p-2 text-sm">
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
                      customSelected:
                        question.kind === 'single_select' ? false : value.customSelected,
                      delegated: false,
                    })
                  }
                />
                <span>
                  <b>{option.label}</b>
                  {question.recommendedOptionIds?.includes(option.id) ? (
                    <Badge className="ml-2" tone="idle">
                      recommended
                    </Badge>
                  ) : null}
                  {option.description && (
                    <small className="block text-muted-foreground">{option.description}</small>
                  )}
                </span>
              </label>
            );
          })}
          {question.allowCustomResponse && (
            <label className="flex items-center gap-2 rounded border p-2 text-sm">
              <input
                type={question.kind === 'multi_select' ? 'checkbox' : 'radio'}
                name={question.id}
                aria-label="Select custom answer"
                checked={value.customSelected}
                onChange={() =>
                  onChange({
                    ...value,
                    selected: question.kind === 'single_select' ? [] : value.selected,
                    customSelected: !value.customSelected,
                    delegated: false,
                  })
                }
              />
              <input
                className="min-w-0 flex-1 rounded border bg-background p-2 text-sm"
                aria-label="Custom answer"
                value={value.text}
                placeholder={question.placeholder ?? 'Other / custom answer (optional)'}
                onFocus={() =>
                  onChange({
                    ...value,
                    selected: question.kind === 'single_select' ? [] : value.selected,
                    customSelected: true,
                    delegated: false,
                  })
                }
                onChange={(event) =>
                  onChange({
                    ...value,
                    selected: question.kind === 'single_select' ? [] : value.selected,
                    text: event.target.value,
                    customSelected: true,
                    delegated: false,
                  })
                }
              />
            </label>
          )}
        </div>
      )}
      <button
        type="button"
        aria-pressed={value.delegated}
        className={`w-full rounded border p-2 text-left text-sm ${value.delegated ? 'border-primary bg-primary/5 font-medium' : 'text-muted-foreground'}`}
        onClick={() =>
          onChange({ ...value, selected: [], customSelected: false, delegated: !value.delegated })
        }
      >
        You decide
        <small className="block font-normal text-muted-foreground">
          I do not want to answer this question. Let the model choose.
        </small>
      </button>
    </fieldset>
  );
}
