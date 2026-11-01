'use client';

/**
 * Write into a project's mailbox. The message lands in the mailbox itself, so
 * it reaches the next agent that runs there even when nothing is connected.
 */
import { type MailboxSendType, postMailboxSend } from '@hq/data/api';
import type { FlatMessage } from '@hq/domain/mailbox-grouping';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { cn } from '@/lib/cn';
import type { ComposeDraft } from './model';

const TYPES: { value: MailboxSendType; label: string; hint: string }[] = [
  { value: 'steer', label: 'Steer', hint: 'Redirect the work in progress.' },
  { value: 'ask', label: 'Question', hint: 'The receiver is expected to answer.' },
  { value: 'assign', label: 'Assignment', hint: 'Hand over ownership of a piece of work.' },
  { value: 'note', label: 'Note', hint: 'General information.' },
  { value: 'btw', label: 'FYI', hint: 'For information, no action needed.' },
  { value: 'queue', label: 'Queued note', hint: 'Picked up by the next agent to start.' },
  { value: 'broadcast', label: 'Broadcast', hint: 'Every agent in the project.' },
  { value: 'status', label: 'Status', hint: 'A meaningful checkpoint.' },
  { value: 'result', label: 'Result', hint: 'Finished output or evidence.' },
  { value: 'review', label: 'Review request', hint: 'Ask for an inspection.' },
];

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'sent'; to: string }
  | { phase: 'error'; message: string };

export function Composer({
  projects,
  initial,
  replyingTo,
  onClose,
}: {
  projects: readonly { id: string; name: string }[];
  initial: ComposeDraft;
  replyingTo: FlatMessage | undefined;
  onClose: () => void;
}): ReactNode {
  const [draft, setDraft] = useState<ComposeDraft>(initial);
  const [state, setState] = useState<SendState>({ phase: 'idle' });
  const id = useId();
  const set = (patch: Partial<ComposeDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
    if (state.phase !== 'sending') setState({ phase: 'idle' });
  };
  const type = TYPES.find((option) => option.value === draft.type) ?? TYPES[0];
  const broadcast = draft.type === 'broadcast';
  const canSend = state.phase !== 'sending' && draft.body.trim() !== '' && draft.projectId !== '';

  const send = async (): Promise<void> => {
    if (!canSend) return;
    setState({ phase: 'sending' });
    try {
      const result = await postMailboxSend({
        projectId: draft.projectId,
        type: draft.type as MailboxSendType,
        // A broadcast has no single recipient; sending `to` would misroute it.
        ...(broadcast ? {} : { to: draft.to.trim() || 'leader' }),
        subject: draft.subject.trim() || 'HQ message',
        body: draft.body.trim(),
        priority: draft.priority,
        audience: draft.leadersOnly ? 'leaders' : 'all',
      });
      setState({ phase: 'sent', to: result.to });
      setDraft((current) => ({ ...current, subject: '', body: '' }));
    } catch (cause) {
      setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const field = 'h-10 w-full border border-border bg-background px-3 text-sm';
  const label = 'text-sm font-medium';

  return (
    <form
      className="mx-auto flex max-w-3xl flex-col gap-5"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <header className="flex items-start gap-3">
        <div className="flex-1">
          <h2 id={`${id}-title`} className="font-display text-2xl font-semibold">
            {replyingTo !== undefined ? 'Reply' : 'Write a message'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {replyingTo !== undefined
              ? `To ${replyingTo.message.from}, about “${replyingTo.message.subject.trim() || 'no subject'}”.`
              : 'It lands in the project’s mailbox and reaches the next agent that runs there, even if none is connected now.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close composer"
          className="grid size-9 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-project`} className={label}>
            Project
          </label>
          <select
            id={`${id}-project`}
            value={draft.projectId}
            onChange={(event) => set({ projectId: event.target.value })}
            className={field}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-type`} className={label}>
            Kind
          </label>
          <select
            id={`${id}-type`}
            value={draft.type}
            onChange={(event) => set({ type: event.target.value })}
            className={field}
            aria-describedby={`${id}-type-hint`}
          >
            {TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span id={`${id}-type-hint`} className="text-xs text-muted-foreground">
            {type?.hint}
          </span>
        </div>
        {!broadcast && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-to`} className={label}>
              To
            </label>
            <input
              id={`${id}-to`}
              value={draft.to}
              onChange={(event) => set({ to: event.target.value })}
              placeholder="leader"
              className={field}
              aria-describedby={`${id}-to-hint`}
            />
            <span id={`${id}-to-hint`} className="text-xs text-muted-foreground">
              An agent name, or “leader” for whoever leads the project.
            </span>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-priority`} className={label}>
            Priority
          </label>
          <select
            id={`${id}-priority`}
            value={draft.priority}
            onChange={(event) => set({ priority: event.target.value as ComposeDraft['priority'] })}
            className={field}
          >
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.leadersOnly}
          onChange={(event) => set({ leadersOnly: event.target.checked })}
          className="mt-0.5 size-4 accent-primary"
        />
        <span>
          Leaders only
          <span className="block text-xs text-muted-foreground">
            Subagents will not pick this message up.
          </span>
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-subject`} className={label}>
          Subject
        </label>
        <input
          id={`${id}-subject`}
          value={draft.subject}
          onChange={(event) => set({ subject: event.target.value })}
          placeholder="Optional"
          className={field}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-body`} className={label}>
          Message
        </label>
        <textarea
          id={`${id}-body`}
          value={draft.body}
          onChange={(event) => set({ body: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
          rows={8}
          placeholder="e.g. After the current task, run the full test suite and report the failures."
          className="w-full resize-y border border-border bg-background px-3 py-2 text-base leading-relaxed"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canSend}
          className="h-10 bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {state.phase === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <span className="text-xs text-muted-foreground">Ctrl+Enter sends</span>
        {state.phase !== 'idle' && state.phase !== 'sending' && (
          <p
            role="status"
            className={cn(
              'basis-full text-sm',
              state.phase === 'sent' ? 'text-success' : 'text-destructive',
            )}
          >
            {state.phase === 'sent'
              ? `Delivered to ${state.to}. It appears in the list once the project reports it.`
              : state.message}
          </p>
        )}
      </div>
    </form>
  );
}
