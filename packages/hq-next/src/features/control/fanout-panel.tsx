'use client';

/**
 * Several sessions at once: pick the sessions, write the message, review the
 * exact list, type the count, send. See `fanout.ts` for the rules; this file
 * only renders them.
 */
import { postCommand } from '@hq/data/api';
import { buildControlDraft } from '@hq/domain/control-draft';
import type { HqSnapshot } from '@wrongstack/hq';
import { Check, CircleSlash, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import {
  FANOUT_TYPES,
  type FanoutOutcome,
  type FanoutReview,
  type FanoutType,
  fanoutBlocker,
  fanoutCandidates,
  freezeFanout,
  MAX_FANOUT_TARGETS,
  runFanout,
  vanishedTargets,
} from './fanout';

const TYPE_LABEL: Record<FanoutType, { label: string; hint: string }> = {
  steer: { label: 'Steer', hint: 'Interrupts each run at its next safe turn.' },
  btw: { label: 'FYI', hint: 'Rides alongside each run without interrupting it.' },
  queue: { label: 'Queue', hint: 'Picked up after each current run finishes.' },
  abort: { label: 'Abort', hint: 'Stops the leader run in each session.' },
};

export function FanoutPanel({
  snapshot,
  onSent,
  onSendingChange,
}: {
  snapshot: HqSnapshot | null;
  onSent: () => void;
  /** The parent locks its own controls (the mode switch) while a run is in flight. */
  onSendingChange: (sending: boolean) => void;
}): ReactNode {
  const id = useId();
  const candidates = useMemo(
    () => fanoutCandidates(snapshot?.clients ?? [], snapshot?.liveSessions ?? []),
    [snapshot],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [type, setType] = useState<FanoutType>('steer');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [review, setReview] = useState<FanoutReview | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [sending, setSending] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, FanoutOutcome>>(new Map());

  // Liveness is checked against the newest snapshot before EACH request, not
  // the one on screen when Send was pressed.
  const latest = useRef(snapshot);
  latest.current = snapshot;
  // Leaving the panel mid-run stops it: the remaining targets are not sent,
  // because the operator can no longer see what is happening.
  const unmounted = useRef(false);
  const reportSending = useRef(onSendingChange);
  reportSending.current = onSendingChange;
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      reportSending.current(false);
    };
  }, []);

  const chosen = candidates.filter((target) => selected.has(target.sessionId));
  const draft = buildControlDraft({
    type,
    steerTo: 'leader',
    steerSubject: subject,
    steerBody: body,
    spawnRole: '',
    spawnTask: '',
    abortTarget: 'leader',
    broadcastSubject: '',
    broadcastBody: '',
    runCommand: '',
    runCwd: '',
  });
  const blocker = draft.disabledReason ?? fanoutBlocker(chosen.length);
  const gone =
    review === null
      ? new Set<string>()
      : vanishedTargets(review, snapshot?.clients ?? [], snapshot?.liveSessions ?? []);

  const toggle = (sessionId: string): void => {
    const next = new Set(selected);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    setSelected(next);
  };

  const send = async (): Promise<void> => {
    if (review === null) return;
    setSending(true);
    onSendingChange(true);
    setOutcomes(new Map());
    const results = new Map<string, FanoutOutcome>();
    await runFanout(
      review,
      postCommand,
      (target) =>
        !unmounted.current &&
        !vanishedTargets(
          { ...review, targets: [target] },
          latest.current?.clients ?? [],
          latest.current?.liveSessions ?? [],
        ).has(target.sessionId),
      (sessionId, outcome) => {
        results.set(sessionId, outcome);
        setOutcomes(new Map(results));
      },
    );
    if (unmounted.current) return;
    setSending(false);
    onSendingChange(false);
    setReview(null);
    setConfirmText('');
    onSent();
  };

  const locked = review !== null || sending;
  const field = 'h-10 w-full border border-border bg-background px-3 text-sm disabled:opacity-60';

  return (
    <div className="flex flex-col gap-6" data-testid="fanout-panel">
      <fieldset disabled={locked} className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-3">
            <h3 className="text-sm font-semibold">Sessions</h3>
            <span className="text-sm text-muted-foreground">
              {chosen.length} of {candidates.length} selected · up to {MAX_FANOUT_TARGETS} per send
            </span>
            <span className="ml-auto flex gap-3 text-sm">
              <button
                type="button"
                onClick={() => setSelected(new Set(candidates.map((target) => target.sessionId)))}
                className="underline-offset-4 hover:underline"
              >
                Select all in scope
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="underline-offset-4 hover:underline"
              >
                Clear
              </button>
            </span>
          </div>
          {candidates.length === 0 ? (
            <p className="border border-border px-3 py-2 text-sm text-muted-foreground">
              No session in this scope accepts commands.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto border border-border">
              {candidates.map((target) => {
                const outcome = outcomes.get(target.sessionId);
                return (
                  <li
                    key={`${target.clientId}|${target.sessionId}`}
                    className="border-b border-border last:border-b-0"
                  >
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                      <input
                        type="checkbox"
                        data-fanout-target={target.sessionId}
                        checked={selected.has(target.sessionId)}
                        onChange={() => toggle(target.sessionId)}
                        className="size-4 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate">{target.label}</span>
                      {outcome !== undefined && <OutcomeMark outcome={outcome} />}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Command</legend>
            {FANOUT_TYPES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                aria-pressed={type === candidate}
                onClick={() => setType(candidate)}
                className={cn(
                  'h-9 border px-3 text-sm',
                  type === candidate
                    ? candidate === 'abort'
                      ? 'border-destructive bg-destructive/10 text-destructive'
                      : 'border-primary bg-primary/10'
                    : 'border-border hover:bg-muted',
                )}
              >
                {TYPE_LABEL[candidate].label}
              </button>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">{TYPE_LABEL[type].hint}</p>
          {type !== 'abort' && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Subject (optional)</span>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Message to every selected leader</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  className="w-full resize-y border border-border bg-background px-3 py-2 text-base leading-relaxed disabled:opacity-60"
                />
              </label>
            </>
          )}
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={blocker !== null}
            onClick={() => {
              setConfirmText('');
              setOutcomes(new Map());
              setReview(
                freezeFanout({
                  type,
                  payload: draft.payload,
                  summary: draft.summary.replace('the selected client', 'each selected session'),
                  targets: chosen,
                }),
              );
            }}
            className="inline-flex h-10 items-center bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Review {chosen.length > 0 ? `${chosen.length} ` : ''}command
            {chosen.length === 1 ? '' : 's'}
          </button>
          {blocker !== null && <span className="text-sm text-muted-foreground">{blocker}</span>}
        </div>
      </fieldset>

      {review !== null && (
        <section
          aria-labelledby={`${id}-review`}
          data-testid="fanout-review"
          className={cn(
            'flex flex-col gap-4 border p-5',
            review.type === 'abort' ? 'border-destructive/60' : 'border-primary/60',
          )}
        >
          <h3 id={`${id}-review`} className="font-display text-lg font-semibold">
            Send {TYPE_LABEL[review.type].label.toLowerCase()} to {review.targets.length} session
            {review.targets.length === 1 ? '' : 's'}
          </h3>
          <p className="text-sm">{review.summary}</p>
          {typeof review.payload.body === 'string' && (
            <blockquote className="whitespace-pre-wrap border-l-2 border-border pl-3 text-sm">
              {review.payload.body}
            </blockquote>
          )}
          <ul className="flex flex-col gap-1 text-sm" aria-label="Reviewed sessions">
            {review.targets.map((target) => (
              <li
                key={target.sessionId}
                className={cn(gone.has(target.sessionId) && 'text-muted-foreground line-through')}
              >
                {target.label}
                {gone.has(target.sessionId) && (
                  <span className="ml-2 no-underline">— ended, will be skipped</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Each session gets its own command, checked and audited by the server one by one.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm">
              Type <code className="font-mono font-semibold">{review.confirmWord}</code> to send
            </span>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              aria-label="Confirmation"
              className="h-10 w-48 border border-border bg-background px-3 font-mono text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={
                sending || confirmText !== review.confirmWord || gone.size === review.targets.length
              }
              onClick={() => void send()}
              className={cn(
                'inline-flex h-10 items-center gap-2 px-5 text-sm font-medium disabled:opacity-50',
                review.type === 'abort'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90',
              )}
            >
              {sending && <LoaderCircle className="size-4 animate-spin" />}
              Send to {review.targets.length - gone.size}
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => setReview(null)}
              className="inline-flex h-10 items-center border border-border px-5 text-sm hover:bg-muted"
            >
              Back
            </button>
          </div>
        </section>
      )}

      {review === null && outcomes.size > 0 && <FanoutSummary outcomes={outcomes} />}
    </div>
  );
}

function OutcomeMark({ outcome }: { outcome: FanoutOutcome }): ReactNode {
  if (outcome.state === 'sent')
    return (
      <span className="inline-flex items-center gap-1 text-xs text-success">
        <Check className="size-3.5" /> Sent
      </span>
    );
  return (
    <span
      title={outcome.reason}
      className={cn(
        'inline-flex items-center gap-1 text-xs',
        outcome.state === 'failed' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {outcome.state === 'failed' ? (
        <TriangleAlert className="size-3.5" />
      ) : (
        <CircleSlash className="size-3.5" />
      )}
      {outcome.state === 'failed' ? 'Failed' : 'Skipped'}
    </span>
  );
}

function FanoutSummary({ outcomes }: { outcomes: ReadonlyMap<string, FanoutOutcome> }): ReactNode {
  const list = [...outcomes.values()];
  const sent = list.filter((outcome) => outcome.state === 'sent').length;
  const problems = list.filter((outcome) => outcome.state !== 'sent');
  return (
    <div role="status" data-testid="fanout-result" className="flex flex-col gap-1 text-sm">
      <p className={problems.length === 0 ? 'text-success' : 'text-warning'}>
        Sent to {sent} of {list.length}. The audit on the right tracks delivery.
      </p>
      {problems.slice(0, 5).map((outcome, index) => (
        <p key={`${index}-${outcome.state}`} className="text-muted-foreground">
          {'reason' in outcome ? outcome.reason : ''}
        </p>
      ))}
    </div>
  );
}
