'use client';

/**
 * Control — send a command to a running client, deliberately.
 *
 * Compose, then review, then send. The review freezes the target and the exact
 * payload; while it is open the form is locked, and if the target disappears
 * the send is refused rather than redirected. Abort and shell commands also
 * need their confirmation word typed. The server still enforces every grant
 * (`control.receive`, `--hq-allow-exec`, `control.execute`); this screen
 * explains them and never relaxes them.
 */
import { fetchJson, postCommand } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import {
  buildControlDraft,
  type ControlCommandType,
  confirmWordFor,
  payloadForSession,
} from '@hq/domain/control-draft';
import { controlClientLabel } from '@hq/domain/control-format';
import type { HqClientRecord, HqCommandAuditEntry, HqSessionSnapshotPayload } from '@wrongstack/hq';
import { SquareTerminal, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { useScopedSnapshot } from '@/lib/use-scope';
import { CommandAudit } from './command-audit';
import { FanoutPanel } from './fanout-panel';
import {
  canReceiveControl,
  canSend,
  freezeReview,
  mergeAudit,
  type Review,
  reviewProblem,
  sessionsForClient,
} from './model';

const AUDIT_LIMIT = 30;
const AUDIT_POLL_MS = 15_000;
const EMPTY_CLIENTS: readonly HqClientRecord[] = [];
const EMPTY_SESSIONS: readonly HqSessionSnapshotPayload[] = [];
const EMPTY_AUDIT: readonly HqCommandAuditEntry[] = [];

const KINDS: { type: ControlCommandType; label: string; hint: string; danger?: boolean }[] = [
  {
    type: 'steer',
    label: 'Steer',
    hint: 'Interrupts at the next safe turn with a high-priority message.',
  },
  { type: 'btw', label: 'FYI', hint: 'Rides alongside the run without interrupting it.' },
  { type: 'queue', label: 'Queue', hint: 'Picked up after the current run finishes.' },
  {
    type: 'spawn',
    label: 'Start a subagent',
    hint: 'Launches a role subagent, optionally with a task.',
  },
  {
    type: 'broadcast',
    label: 'Broadcast',
    hint: 'A mailbox message to every agent in the project.',
  },
  { type: 'abort', label: 'Abort', hint: 'Stops the leader run, or every subagent.', danger: true },
  {
    type: 'run-command',
    label: 'Shell command',
    hint: 'Routes a shell command to the client. Needs --hq-allow-exec and control.execute.',
    danger: true,
  },
];

const SPAWN_ROLES = [
  'bug-hunter',
  'refactor-planner',
  'critic',
  'security-scanner',
  'code-reviewer',
];

export function ControlView(): ReactNode {
  // Targets come from the operator's scope; a target that leaves it mid-review
  // is refused like any other that disappears.
  const snapshot = useScopedSnapshot();
  const liveStatuses = useHqStore((state) => state.commandStatuses ?? EMPTY_AUDIT);
  const allClients = snapshot?.clients ?? EMPTY_CLIENTS;
  const allSessions = snapshot?.liveSessions ?? EMPTY_SESSIONS;
  const clients = useMemo(() => allClients.filter(canReceiveControl), [allClients]);
  const id = useId();

  const [clientId, setClientId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const client = clients.find((candidate) => candidate.clientId === clientId) ?? clients[0] ?? null;
  const sessions = useMemo(
    () => (client === null ? [] : sessionsForClient(client, allSessions)),
    [client, allSessions],
  );
  const session = sessions.find((candidate) => candidate.sessionId === sessionId) ?? sessions[0];

  const [type, setType] = useState<ControlCommandType>('steer');
  const [to, setTo] = useState('leader');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [spawnRole, setSpawnRole] = useState(SPAWN_ROLES[0] ?? 'critic');
  const [spawnTask, setSpawnTask] = useState('');
  const [abortTarget, setAbortTarget] = useState<'leader' | 'fleet'>('leader');
  const [runCommand, setRunCommand] = useState('');
  const [runCwd, setRunCwd] = useState('');

  const [mode, setMode] = useState<'one' | 'many'>('one');
  // A fan-out run in flight locks the mode switch (the panel reports it).
  const [fanoutSending, setFanoutSending] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [lastCommandId, setLastCommandId] = useState<string | null>(null);

  const [polled, setPolled] = useState<HqCommandAuditEntry[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const loadAudit = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchJson<{ commands: HqCommandAuditEntry[] }>(
        `/api/commands?limit=${AUDIT_LIMIT}`,
      );
      setPolled(data.commands);
      setAuditError(null);
    } catch (cause) {
      setAuditError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void loadAudit();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadAudit();
    }, AUDIT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadAudit]);
  const audit = useMemo(
    () => mergeAudit(polled, liveStatuses, AUDIT_LIMIT),
    [polled, liveStatuses],
  );

  const draft = useMemo(
    () =>
      buildControlDraft({
        type,
        steerTo: to,
        steerSubject: subject,
        steerBody: body,
        spawnRole,
        spawnTask,
        abortTarget,
        broadcastSubject: subject,
        broadcastBody: body,
        runCommand,
        runCwd,
      }),
    [type, to, subject, body, spawnRole, spawnTask, abortTarget, runCommand, runCwd],
  );
  const problem = review === null ? null : reviewProblem(review, allClients, allSessions);

  const startReview = (): void => {
    if (client === null || draft.disabledReason !== null) return;
    const sessionPart =
      session !== undefined && type !== 'broadcast'
        ? ` · session ${session.sessionId.slice(0, 8)}`
        : '';
    setReview(
      freezeReview({
        clientId: client.clientId,
        target: `${controlClientLabel(client, snapshot)}${sessionPart}`,
        sessionId: type === 'broadcast' ? undefined : session?.sessionId,
        type: draft.type,
        payload: payloadForSession(draft, session?.sessionId),
        summary: draft.summary,
        danger: draft.risk === 'danger',
        confirmWord: confirmWordFor(draft.type),
      }),
    );
    setConfirmText('');
    setResult(null);
  };

  const send = async (): Promise<void> => {
    if (review === null || sending) return;
    // Re-check against the newest snapshot at the moment of sending.
    const latest = useHqStore.getState().snapshot;
    const latestProblem = reviewProblem(review, latest?.clients ?? [], latest?.liveSessions ?? []);
    if (!canSend(review, confirmText, latestProblem)) return;
    setSending(true);
    try {
      const sent = await postCommand(review.clientId, review.type, review.payload);
      setLastCommandId(sent.commandId);
      setResult({
        tone: 'ok',
        text: `Queued. The command appears on the right as it is delivered and answered.`,
      });
      setReview(null);
      setConfirmText('');
      if (review.type === 'run-command') setRunCommand('');
      void loadAudit();
    } catch (cause) {
      setResult({ tone: 'error', text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSending(false);
    }
  };

  const onFormKey = (event: KeyboardEvent<HTMLFormElement>): void => {
    // Ctrl+Enter only ever opens the review; sending always takes a click.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      startReview();
    }
  };

  if (clients.length === 0) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-6 py-16">
        <SquareTerminal className="size-6 text-muted-foreground" />
        <h2 className="font-display text-2xl font-semibold">
          No client accepts commands right now
        </h2>
        <p className="text-base text-muted-foreground">
          A connected CLI, TUI or WebUI that advertises <code>control.receive</code> shows up here.
        </p>
        <Link href="/fleet/" className="text-sm underline-offset-4 hover:underline">
          See the Fleet
        </Link>
      </div>
    );
  }

  const field = 'h-10 w-full border border-border bg-background px-3 text-sm disabled:opacity-60';
  const area =
    'w-full resize-y border border-border bg-background px-3 py-2 text-base leading-relaxed disabled:opacity-60';
  const label = 'text-sm font-medium';
  const locked = review !== null;

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-6">
        <fieldset
          className="inline-flex w-fit border border-border"
          disabled={locked || fanoutSending}
        >
          <legend className="sr-only">Targets</legend>
          {(['one', 'many'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={mode === candidate}
              data-control-mode={candidate}
              onClick={() => setMode(candidate)}
              className={cn(
                'h-9 px-3 text-sm',
                mode === candidate
                  ? 'bg-muted font-medium'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {candidate === 'one' ? 'One session' : 'Several sessions'}
            </button>
          ))}
        </fieldset>
        {mode === 'many' ? (
          <FanoutPanel
            snapshot={snapshot}
            onSent={() => void loadAudit()}
            onSendingChange={setFanoutSending}
          />
        ) : (
          <>
            <form
              onKeyDown={onFormKey}
              onSubmit={(event) => {
                event.preventDefault();
                startReview();
              }}
              className="flex flex-col gap-6"
            >
              <fieldset disabled={locked} className="flex flex-col gap-6">
                <section className="grid gap-4 sm:grid-cols-2">
                  {/* Alone, the target takes the full row: its label is a long path. */}
                  <div
                    className={cn('flex flex-col gap-1.5', sessions.length <= 1 && 'sm:col-span-2')}
                  >
                    <label htmlFor={`${id}-client`} className={label}>
                      Target
                    </label>
                    <select
                      id={`${id}-client`}
                      value={client?.clientId ?? ''}
                      onChange={(event) => {
                        setClientId(event.target.value);
                        setSessionId(null);
                      }}
                      className={field}
                    >
                      {clients.map((candidate) => (
                        <option key={candidate.clientId} value={candidate.clientId}>
                          {controlClientLabel(candidate, snapshot)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {sessions.length > 1 && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`${id}-session`} className={label}>
                        Session
                      </label>
                      <select
                        id={`${id}-session`}
                        value={session?.sessionId ?? ''}
                        onChange={(event) => setSessionId(event.target.value)}
                        className={field}
                      >
                        {sessions.map((candidate) => (
                          <option key={candidate.sessionId} value={candidate.sessionId}>
                            {candidate.sessionId.slice(0, 8)} · {candidate.status} ·{' '}
                            {candidate.agentCount} agents
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </section>

                <fieldset className="flex flex-col gap-2">
                  <legend className={cn(label, 'mb-2')}>Command</legend>
                  <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
                    {KINDS.map((kind) => (
                      <label
                        key={kind.type}
                        className={cn(
                          'flex cursor-pointer flex-col gap-1 border px-3 py-2.5 focus-within:ring-2 focus-within:ring-ring',
                          kind.type === type
                            ? kind.danger
                              ? 'border-destructive bg-destructive/10'
                              : 'border-foreground bg-muted'
                            : 'border-border hover:bg-muted/50',
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="radio"
                            name={`${id}-kind`}
                            value={kind.type}
                            checked={kind.type === type}
                            onChange={() => setType(kind.type)}
                            className="size-4 accent-primary"
                          />
                          {kind.label}
                          {kind.danger && (
                            <TriangleAlert
                              className="size-3.5 text-destructive"
                              aria-label="Destructive"
                            />
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">{kind.hint}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <section className="flex flex-col gap-4">
                  {(type === 'steer' || type === 'btw' || type === 'queue') && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`${id}-to`} className={label}>
                        To
                      </label>
                      <input
                        id={`${id}-to`}
                        value={to}
                        onChange={(event) => setTo(event.target.value)}
                        className={field}
                      />
                      <span className="text-xs text-muted-foreground">
                        “leader”, “leader@sessionTag”, or a subagent id.
                      </span>
                    </div>
                  )}
                  {(type === 'steer' ||
                    type === 'btw' ||
                    type === 'queue' ||
                    type === 'broadcast') && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-subject`} className={label}>
                          Subject
                        </label>
                        <input
                          id={`${id}-subject`}
                          value={subject}
                          placeholder="Optional"
                          onChange={(event) => setSubject(event.target.value)}
                          className={field}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-body`} className={label}>
                          Message
                        </label>
                        <textarea
                          id={`${id}-body`}
                          value={body}
                          rows={5}
                          onChange={(event) => setBody(event.target.value)}
                          className={area}
                        />
                      </div>
                    </>
                  )}
                  {type === 'spawn' && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-role`} className={label}>
                          Role
                        </label>
                        <select
                          id={`${id}-role`}
                          value={spawnRole}
                          onChange={(event) => setSpawnRole(event.target.value)}
                          className={field}
                        >
                          {SPAWN_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-task`} className={label}>
                          Task
                        </label>
                        <textarea
                          id={`${id}-task`}
                          value={spawnTask}
                          rows={4}
                          placeholder="Optional"
                          onChange={(event) => setSpawnTask(event.target.value)}
                          className={area}
                        />
                      </div>
                    </>
                  )}
                  {type === 'abort' && (
                    <fieldset className="flex flex-col gap-2">
                      <legend className={cn(label, 'mb-1')}>Stop</legend>
                      {(
                        [
                          ['leader', 'The leader run of the session'],
                          ['fleet', 'Every subagent of the session'],
                        ] as const
                      ).map(([value, text]) => (
                        <label key={value} className="flex items-center gap-2 text-sm">
                          <input
                            type="radio"
                            name={`${id}-abort`}
                            value={value}
                            checked={abortTarget === value}
                            onChange={() => setAbortTarget(value)}
                            className="size-4 accent-primary"
                          />
                          {text}
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {type === 'run-command' && (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-command`} className={label}>
                          Shell command
                        </label>
                        <textarea
                          id={`${id}-command`}
                          value={runCommand}
                          rows={3}
                          spellCheck={false}
                          autoComplete="off"
                          onChange={(event) => setRunCommand(event.target.value)}
                          className={cn(area, 'font-mono text-sm')}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-cwd`} className={label}>
                          Working directory
                        </label>
                        <input
                          id={`${id}-cwd`}
                          value={runCwd}
                          placeholder="The agent’s project root"
                          spellCheck={false}
                          onChange={(event) => setRunCwd(event.target.value)}
                          className={cn(field, 'font-mono')}
                        />
                      </div>
                      <p className="text-sm text-muted-foreground">
                        The client must run with <code>--hq-allow-exec</code> and your login needs{' '}
                        <code>control.execute</code>, or the server refuses it. It arrives as a
                        steer, so the agent’s own permission rules still apply. Never kept between
                        visits.
                      </p>
                    </>
                  )}
                </section>
              </fieldset>

              {!locked && (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={draft.disabledReason !== null}
                    className="h-10 bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Review
                  </button>
                  <span className="text-sm text-muted-foreground">
                    {draft.disabledReason ??
                      'Ctrl+Enter opens the review. Nothing is sent from here.'}
                  </span>
                </div>
              )}
            </form>

            {review !== null && (
              <ReviewPanel
                review={review}
                problem={problem}
                confirmText={confirmText}
                onConfirmText={setConfirmText}
                sending={sending}
                onSend={() => void send()}
                onEdit={() => {
                  setReview(null);
                  setConfirmText('');
                }}
              />
            )}
            {result !== null && (
              <p
                role="status"
                className={cn(
                  'text-sm',
                  result.tone === 'ok' ? 'text-success' : 'text-destructive',
                )}
              >
                {result.text}
              </p>
            )}
          </>
        )}
      </div>

      <CommandAudit
        entries={audit}
        error={auditError}
        clients={allClients}
        snapshot={snapshot}
        targetClientId={client?.clientId ?? null}
        highlightId={lastCommandId}
        onRefresh={() => void loadAudit()}
      />
    </div>
  );
}

function ReviewPanel({
  review,
  problem,
  confirmText,
  onConfirmText,
  sending,
  onSend,
  onEdit,
}: {
  review: Review;
  problem: string | null;
  confirmText: string;
  onConfirmText: (value: string) => void;
  sending: boolean;
  onSend: () => void;
  onEdit: () => void;
}): ReactNode {
  const id = useId();
  const ready = canSend(review, confirmText, problem);
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        'flex flex-col gap-4 border p-5',
        review.danger ? 'border-destructive/60 bg-destructive/5' : 'border-border bg-card',
      )}
    >
      <h2 id={`${id}-title`} className="font-display text-xl font-semibold">
        Review before sending
      </h2>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">What happens</dt>
        <dd className="font-medium">{review.summary}</dd>
        <dt className="text-muted-foreground">Target</dt>
        <dd className="break-words">{review.target}</dd>
      </dl>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
          Exact request
        </summary>
        <pre className="mt-2 overflow-x-auto border border-border bg-muted/30 p-3 font-mono text-[0.8125rem] leading-relaxed">
          {JSON.stringify(
            { clientId: review.clientId, type: review.type, payload: review.payload },
            null,
            2,
          )}
        </pre>
      </details>
      {problem !== null && (
        <p role="alert" className="flex items-start gap-2 text-sm font-medium text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {problem}
        </p>
      )}
      {review.confirmWord !== null && problem === null && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-confirm`} className="text-sm font-medium">
            Type <span className="font-mono">{review.confirmWord}</span> to send this
          </label>
          <input
            id={`${id}-confirm`}
            value={confirmText}
            onChange={(event) => onConfirmText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-10 w-48 border border-border bg-background px-3 font-mono text-sm"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!ready || sending}
          onClick={onSend}
          className={cn(
            'h-10 px-5 text-sm font-medium disabled:opacity-50',
            review.danger
              ? 'bg-destructive text-white hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="h-10 border border-border px-4 text-sm hover:bg-muted"
        >
          Edit
        </button>
      </div>
    </section>
  );
}
