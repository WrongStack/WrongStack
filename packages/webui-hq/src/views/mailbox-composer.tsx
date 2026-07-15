/**
 * Mailbox composer — write a prompt straight into a project's GlobalMailbox
 * from the HQ browser via `POST /api/mailbox-send`.
 *
 * This is the "send even when no active agent" path: the message lands in
 * the project mailbox file, so the next agent to run (or any live terminal/
 * webui) picks it up. Complements the Control view, which can only steer
 * clients that are currently CONNECTED to HQ.
 *
 * Collapsed to a single button by default so the Mailbox view stays a feed;
 * expands into a small form. `sender` is injectable for tests (defaults to
 * the store's `postMailboxSend`).
 */
import type React from 'react';
import { useState } from 'react';
import { MailPlus } from 'lucide-react';
import { type MailboxSendInput, type MailboxSendResult, postMailboxSend } from '../store.js';

export interface ComposerProject {
  projectId: string;
  /** Human-readable name when known; falls back to the id. */
  label?: string | undefined;
}

export interface MailboxComposerProps {
  projects: readonly ComposerProject[];
  /** Injectable sender (tests). Defaults to the store's postMailboxSend. */
  sender?: ((input: MailboxSendInput) => Promise<MailboxSendResult>) | undefined;
}

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'sent'; messageId: string | undefined }
  | { phase: 'error'; message: string };

const TYPE_OPTIONS: { value: MailboxSendInput['type']; label: string }[] = [
  { value: 'steer', label: 'steer — redirect the current work' },
  { value: 'btw', label: 'btw — FYI, no action required' },
  { value: 'queue', label: 'queue — note for the next agent' },
  { value: 'broadcast', label: 'broadcast — all agents in the project' },
];

export function MailboxComposer({ projects, sender }: MailboxComposerProps): React.ReactElement {
  const send = sender ?? postMailboxSend;
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [type, setType] = useState<MailboxSendInput['type']>('steer');
  const [to, setTo] = useState('leader');
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>('normal');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [state, setState] = useState<SendState>({ phase: 'idle' });

  const effectiveProjectId = projectId || projects[0]?.projectId || '';
  const canSend =
    state.phase !== 'sending' && body.trim().length > 0 && effectiveProjectId.length > 0;

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    setState({ phase: 'sending' });
    try {
      const result = await send({
        projectId: effectiveProjectId,
        type,
        ...(type !== 'broadcast' ? { to: to.trim() || 'leader' } : {}),
        subject: subject.trim() || 'HQ prompt',
        body: body.trim(),
        priority,
      });
      setState({ phase: 'sent', messageId: result.messageId });
      setBody('');
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (!open) {
    return (
      <div className="hq-composer-bar">
        <button
          type="button"
          className="hq-btn"
          disabled={projects.length === 0}
          title={
            projects.length === 0
              ? 'No projects reported yet — connect a client first'
              : 'Write a message into a project mailbox (works with zero connected agents)'
          }
          onClick={() => setOpen(true)}
        >
          <MailPlus size={13} /> Compose
        </button>
        {state.phase === 'sent' && (
          <span className="hq-composer-status ok">
            delivered{state.messageId !== undefined ? ` · ${state.messageId.slice(0, 8)}` : ''}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="hq-card hq-composer">
      <div className="hq-row hq-row-baseline">
        <span className="hq-card-title hq-title-inline">
          Send to project mailbox
        </span>
        <span className="hq-composer-hint">
          lands in the mailbox file — picked up by the next agent, no live client needed
        </span>
        <button
          type="button"
          className="hq-toggle hq-ml-auto"
          aria-label="Collapse composer"
          onClick={() => setOpen(false)}
        >
          ▾
        </button>
      </div>
      <div className="hq-composer-grid">
        <label className="hq-composer-field">
          <span>project</span>
          <select
            className="hq-select"
            value={effectiveProjectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>
                {p.label ?? p.projectId}
              </option>
            ))}
          </select>
        </label>
        <label className="hq-composer-field">
          <span>type</span>
          <select
            className="hq-select"
            value={type}
            onChange={(e) => setType(e.target.value as MailboxSendInput['type'])}
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {type !== 'broadcast' && (
          <label className="hq-composer-field">
            <span>to</span>
            <input
              className="hq-input"
              value={to}
              placeholder="leader"
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        )}
        <label className="hq-composer-field">
          <span>priority</span>
          <select
            className="hq-select"
            value={priority}
            onChange={(e) => setPriority(e.target.value as 'high' | 'normal' | 'low')}
          >
            <option value="high">high</option>
            <option value="normal">normal</option>
            <option value="low">low</option>
          </select>
        </label>
      </div>
      <input
        className="hq-input"
        value={subject}
        placeholder="subject (optional)"
        onChange={(e) => setSubject(e.target.value)}
      />
      <textarea
        className="hq-input hq-composer-body"
        value={body}
        rows={3}
        placeholder="Message body — e.g. “after the current task, run the full test suite”"
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="hq-row">
        <button type="button" className="hq-btn" disabled={!canSend} onClick={() => void submit()}>
          {state.phase === 'sending' ? 'Sending…' : 'Send'}
        </button>
        {state.phase === 'sent' && (
          <span className="hq-composer-status ok">
            delivered{state.messageId !== undefined ? ` · ${state.messageId.slice(0, 8)}` : ''}
          </span>
        )}
        {state.phase === 'error' && (
          <span className="hq-composer-status err" title={state.message}>
            {state.message}
          </span>
        )}
      </div>
    </div>
  );
}
