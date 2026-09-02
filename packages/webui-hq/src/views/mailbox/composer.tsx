/**
 * Mailbox composer — write straight into a project's mailbox file.
 *
 * This is the "send even when nothing is connected" path: the message lands in
 * the mailbox, and the next agent to run picks it up. It complements Control,
 * which can only steer clients currently attached to HQ.
 *
 * Collapsed to a button by default so the Mailbox stays a feed; opens as a
 * dialog rather than expanding inline, which kept pushing the feed around.
 */
import { MailPlus } from 'lucide-react';
import type * as React from 'react';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.js';
import { Input, Select, Textarea } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import {
  type MailboxSendInput,
  type MailboxSendResult,
  type MailboxSendType,
  postMailboxSend,
} from '../../data/api.js';
import { cn } from '../../lib/utils.js';

export interface ComposerProject {
  projectId: string;
  /** Human-readable name when known; falls back to the id. */
  label?: string | undefined;
}

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'sent'; messageId: string | undefined }
  | { phase: 'error'; message: string };

const TYPE_OPTIONS: { value: MailboxSendType; label: string }[] = [
  { value: 'note', label: 'note — general information' },
  { value: 'ask', label: 'ask — reply required' },
  { value: 'assign', label: 'assign — work ownership' },
  { value: 'steer', label: 'steer — redirect the current work' },
  { value: 'btw', label: 'btw — FYI, no action required' },
  { value: 'queue', label: 'queue — note for the next agent' },
  { value: 'broadcast', label: 'broadcast — all agents in the project' },
  { value: 'status', label: 'status — meaningful checkpoint' },
  { value: 'result', label: 'result — completed output / evidence' },
  { value: 'review', label: 'review — passive inspection request' },
];

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

export function MailboxComposer({
  projects,
  sender,
}: {
  projects: readonly ComposerProject[];
  /** Injectable for tests; defaults to the real API call. */
  sender?: (input: MailboxSendInput) => Promise<MailboxSendResult>;
}): React.ReactElement {
  const send = sender ?? postMailboxSend;
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [type, setType] = useState<MailboxSendType>('steer');
  const [to, setTo] = useState('leader');
  const [priority, setPriority] = useState<'high' | 'normal' | 'low'>('normal');
  const [leadersOnly, setLeadersOnly] = useState(false);
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
        // A broadcast has no single recipient; sending `to` would be ignored
        // at best and misroute at worst.
        ...(type !== 'broadcast' ? { to: to.trim() || 'leader' } : {}),
        subject: subject.trim() || 'HQ prompt',
        body: body.trim(),
        priority,
        audience: leadersOnly ? 'leaders' : 'all',
      });
      setState({ phase: 'sent', messageId: result.messageId });
      setBody('');
    } catch (cause) {
      setState({ phase: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <div data-testid="mailbox-composer" className="flex items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            disabled={projects.length === 0}
            title={
              projects.length === 0
                ? 'No projects reported yet — connect a client first'
                : 'Write into a project mailbox (works with zero connected agents)'
            }
          >
            <MailPlus />
            Compose
          </Button>
        </DialogTrigger>

        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Send to project mailbox</DialogTitle>
            <DialogDescription>
              Lands in the mailbox file and is picked up by the next agent — no live client needed.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="project" htmlFor="composer-project">
              <Select
                id="composer-project"
                value={effectiveProjectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.projectId} value={project.projectId}>
                    {project.label ?? project.projectId}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="type" htmlFor="composer-type">
              <Select
                id="composer-type"
                value={type}
                onChange={(event) => setType(event.target.value as MailboxSendType)}
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            {type !== 'broadcast' && (
              <Field label="to" htmlFor="composer-to">
                <Input
                  id="composer-to"
                  value={to}
                  placeholder="leader"
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
            )}

            <Field label="audience" htmlFor="composer-audience">
              <Select
                id="composer-audience"
                value={leadersOnly ? 'leaders' : 'all'}
                onChange={(event) => setLeadersOnly(event.target.value === 'leaders')}
              >
                <option value="all">all agents</option>
                <option value="leaders">leaders only — subagents cannot consume</option>
              </Select>
            </Field>

            <Field label="priority" htmlFor="composer-priority">
              <Select
                id="composer-priority"
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as 'high' | 'normal' | 'low')
                }
              >
                <option value="high">high</option>
                <option value="normal">normal</option>
                <option value="low">low</option>
              </Select>
            </Field>
          </div>

          <Field label="subject" htmlFor="composer-subject">
            <Input
              id="composer-subject"
              value={subject}
              placeholder="subject (optional)"
              onChange={(event) => setSubject(event.target.value)}
            />
          </Field>

          <Field label="body" htmlFor="composer-body">
            <Textarea
              id="composer-body"
              value={body}
              rows={4}
              placeholder="e.g. “after the current task, run the full test suite”"
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>

          <DialogFooter>
            {state.phase === 'error' && (
              <span
                data-testid="composer-status"
                data-tone="error"
                title={state.message}
                className="mr-auto self-center truncate text-[11px] text-destructive"
              >
                {state.message}
              </span>
            )}
            <Button disabled={!canSend} onClick={() => void submit()}>
              {state.phase === 'sending' ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {state.phase === 'sent' && (
        <span
          data-testid="composer-status"
          data-tone="ok"
          className={cn('text-[11px] text-success')}
        >
          delivered
          {state.messageId !== undefined ? ` · ${state.messageId.slice(0, 8)}` : ''}
        </span>
      )}
    </div>
  );
}
