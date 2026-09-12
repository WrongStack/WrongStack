/**
 * Approvals — the permission prompts waiting for a human, wherever they were
 * raised.
 *
 * A tool call that needs approval blocks its run until someone answers. Until
 * now that someone had to be at the machine: the prompt lived only in the TUI
 * dialog or the WebUI/SimpleUI modal that raised it. This view mirrors those
 * prompts and lets an operator answer them from HQ. The prompt stays live on
 * its own surface — whichever answers first wins, and the loser is told so
 * rather than left believing their answer applied.
 *
 * The countdown is the point, not decoration: after the deadline the Brain
 * arbiter decides without you.
 */

import type { UserInputQuestion, UserInputResponse } from '@wrongstack/core/types';
import { CircleCheck, CircleSlash, ShieldQuestion, Siren, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';
import { EmptyState, Mono } from '../components/hq/primitives.js';
import { HeroMetric, Section, ViewHero, ViewShell } from '../components/hq/view-chrome.js';
import { Badge, type BadgeTone } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import {
  type ApprovalDecision,
  type PendingApproval,
  useAnswerApproval,
  usePendingApprovals,
} from '../domain/use-pending-approvals.js';
import {
  type PendingUserInput,
  useAnswerUserInput,
  usePendingUserInputs,
} from '../domain/use-pending-user-inputs.js';
import { cn } from '../lib/utils.js';

function remainingLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
}

/**
 * Under this much time, answering from a phone is unlikely to land. Saying so
 * is more useful than a green number that quietly runs out.
 */
const URGENT_MS = 30_000;

function riskBadge(approval: PendingApproval): { tone: BadgeTone; label: string } {
  if (approval.boundaryReason) return { tone: 'error', label: 'governance' };
  if (approval.destructive) return { tone: 'error', label: 'destructive' };
  if (approval.riskTier === 'safe') return { tone: 'idle', label: 'safe' };
  return { tone: 'warn', label: approval.riskTier ?? 'standard' };
}

function ArgumentSummary({ value }: { value: unknown }): React.ReactElement | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      return null;
    }
  }
  if (text.length === 0) return null;
  return (
    <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">
      {text}
    </pre>
  );
}

function ApprovalCard({
  approval,
  answer,
  sending,
}: {
  approval: PendingApproval;
  answer: (approval: PendingApproval, decision: ApprovalDecision) => Promise<void>;
  sending: boolean;
}): React.ReactElement {
  const risk = riskBadge(approval);
  const urgent = approval.remainingMs <= URGENT_MS;

  return (
    <Card
      data-testid="approval-card"
      data-tool={approval.toolName}
      className={cn(
        'border-l-2',
        risk.tone === 'error' ? 'border-l-destructive' : 'border-l-warning',
      )}
    >
      <CardContent className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Mono className="text-sm font-medium">{approval.toolName}</Mono>
          <Badge tone={risk.tone}>{risk.label}</Badge>
          <span
            data-testid="approval-countdown"
            className={cn(
              'tabular ml-auto text-[11px]',
              urgent ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {remainingLabel(approval.remainingMs)}
          </span>
        </div>

        <div className="text-[11px] text-muted-foreground">
          <span>{approval.projectId}</span>
          {approval.sessionId ? <span> · session {approval.sessionId.slice(0, 8)}</span> : null}
          <span> · {approval.clientId}</span>
        </div>

        {approval.boundaryReason ? (
          <div className="flex items-start gap-2 text-[11px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{approval.boundaryReason}</span>
          </div>
        ) : null}

        {approval.writeTargets !== undefined && approval.writeTargets.length > 0 ? (
          <div className="text-[11px]">
            <span className="text-muted-foreground">Writes: </span>
            <Mono>{approval.writeTargets.join(', ')}</Mono>
          </div>
        ) : null}

        <ArgumentSummary value={approval.inputSummary} />

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={sending} onClick={() => void answer(approval, 'yes')}>
            <CircleCheck /> Allow once
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={sending}
            onClick={() => void answer(approval, 'no')}
          >
            <CircleSlash /> Refuse once
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={sending}
            onClick={() => void answer(approval, 'always')}
            // Both of these write persistent policy on the remote machine, so
            // the pattern they would key on is named rather than implied.
            title={`Persists a trust rule for ${approval.suggestedPattern}`}
          >
            Always allow
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={sending}
            onClick={() => void answer(approval, 'deny')}
            title={`Persists a permanent denial for ${approval.suggestedPattern}`}
          >
            Deny permanently
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApprovalsView(): React.ReactElement {
  const { approvals, loading } = usePendingApprovals();
  const { answer, pendingFor } = useAnswerApproval();
  const urgent = approvals.filter((a) => a.remainingMs <= URGENT_MS).length;
  const destructive = approvals.filter((a) => a.destructive || a.boundaryReason).length;
  const userInputs = usePendingUserInputs();
  const userInputAnswer = useAnswerUserInput();

  return (
    <ViewShell>
      <ViewHero
        eyebrow="Human in the loop"
        headline="Approvals"
        description="Permission prompts raised on any surface — TUI, WebUI or SimpleUI — mirrored here. The prompt stays live on its own screen; whoever answers first wins."
        tone={urgent > 0 ? 'error' : approvals.length > 0 ? 'warn' : 'idle'}
        metrics={
          <>
            <HeroMetric
              label="Waiting"
              value={approvals.length}
              tone={approvals.length > 0 ? 'warn' : 'idle'}
            />
            <HeroMetric
              label="Damaging"
              value={destructive}
              tone={destructive > 0 ? 'error' : 'idle'}
            />
            <HeroMetric
              label="About to expire"
              value={urgent}
              tone={urgent > 0 ? 'error' : 'idle'}
            />
          </>
        }
      />

      <Section eyebrow="Blocked runs" title="Awaiting a decision">
        {approvals.length === 0 ? (
          <EmptyState
            icon={loading ? ShieldQuestion : Siren}
            title={loading ? 'Loading approvals…' : 'Nothing waiting on you'}
            hint="A tool call that needs permission will appear here while its run is blocked, with the time left before the Brain arbiter decides instead."
          />
        ) : (
          <div className="space-y-2">
            {approvals.map((approval) => (
              <ApprovalCard
                key={approval.toolUseId}
                approval={approval}
                answer={answer}
                sending={pendingFor(approval.toolUseId)}
              />
            ))}
          </div>
        )}
      </Section>
      <Section eyebrow="Model questions" title="Awaiting your answers">
        {userInputs.length === 0 ? (
          <EmptyState
            icon={ShieldQuestion}
            title="No questions waiting"
            hint="When a model needs exact requirements, its structured form will appear here and on the originating UI."
          />
        ) : (
          <div className="space-y-3">
            {userInputs.map((input) => (
              <UserInputCard
                key={input.request.id}
                input={input}
                sending={userInputAnswer.pendingFor(input.request.id)}
                onSubmit={userInputAnswer.answer}
              />
            ))}
          </div>
        )}
      </Section>
    </ViewShell>
  );
}

type InputDraft = Record<string, { selected: string[]; text: string }>;
function UserInputCard({
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
        { selected: [...(q.recommendedOptionIds ?? [])], text: q.recommendedText ?? '' },
      ]),
    ),
  );
  const tab = request.tabs[activeTab] ?? request.tabs[0]!;
  const valid = questions.every(
    (q) => !q.required || Boolean(draft[q.id]?.selected.length || draft[q.id]?.text.trim()),
  );
  const submit = () => {
    if (!valid) return;
    void onSubmit(input, {
      requestId: request.id,
      status: 'submitted',
      answers: questions.map((q) => {
        const value = draft[q.id] ?? { selected: [], text: '' };
        const rec = q.recommendedOptionIds ?? [];
        return {
          questionId: q.id,
          selectedOptionIds: value.selected,
          ...(value.text.trim() ? { text: value.text.trim() } : {}),
          usedRecommendation:
            value.selected.length === rec.length &&
            value.selected.every((id) => rec.includes(id)) &&
            (q.recommendedText ?? '') === value.text.trim() &&
            (rec.length > 0 || Boolean(q.recommendedText)),
        };
      }),
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
              value={draft[q.id] ?? { selected: [], text: '' }}
              onChange={(value) => setDraft((old) => ({ ...old, [q.id]: value }))}
            />
          ))}
        </div>
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
  value: InputDraft[string];
  onChange: (value: InputDraft[string]) => void;
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
          onChange={(event) => onChange({ ...value, text: event.target.value })}
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
            <input
              className="w-full rounded border bg-background p-2 text-sm"
              value={value.text}
              placeholder={question.placeholder ?? 'Custom answer (optional)'}
              onChange={(event) => onChange({ ...value, text: event.target.value })}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}
