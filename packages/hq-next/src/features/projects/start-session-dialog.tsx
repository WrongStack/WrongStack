'use client';

/**
 * Start a new session in a project from HQ: pick the machine, write what the
 * session should do, review exactly what will happen, then confirm. The target
 * client launches its own `wstack` with the prompt (no shell); the new session
 * connects to HQ and its permission requests come to the Inbox.
 *
 * The server re-checks everything (control.execute on this browser and on the
 * target's token, the trust boundary, the client's opt-in); this only decides
 * what to offer.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@hq/components/ui/dialog';
import { postCommand } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import { Play } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { errorText } from '@/lib/error-text';
import type { StartSessionTarget } from './model';

/** Same bound as the server's `HQ_START_SESSION_PROMPT_MAX`. */
const PROMPT_MAX = 16_000;

type Step = 'write' | 'review' | 'sent';

export function StartSessionDialog({
  projectName,
  root,
  targets,
}: {
  projectName: string;
  root: string;
  targets: readonly StartSessionTarget[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('write');
  const [clientId, setClientId] = useState(targets[0]?.clientId ?? '');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const statuses = useHqStore((state) => state.commandStatuses);
  const status = useMemo(
    () => statuses.find((entry) => entry.commandId === commandId),
    [statuses, commandId],
  );
  const target = targets.find((entry) => entry.clientId === clientId) ?? targets[0];
  const trimmed = prompt.trim();

  const reset = (): void => {
    setStep('write');
    setPrompt('');
    setError(null);
    setPending(false);
    setCommandId(null);
  };

  const send = async (): Promise<void> => {
    if (target === undefined) return;
    setPending(true);
    setError(null);
    try {
      const sent = await postCommand(target.clientId, 'start-session', { prompt: trimmed });
      setCommandId(sent.commandId);
      setStep('sent');
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        disabled={targets.length === 0}
        data-testid="start-session"
        className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted disabled:opacity-60"
      >
        <Play className="size-4" />
        Start a session
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Start a session in {projectName}</DialogTitle>
        <DialogDescription>
          The machine opens a new headless WrongStack session in the project folder and gives it
          your prompt. It shows up under Open sessions once it connects.
        </DialogDescription>

        {step === 'write' && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmed.length > 0 && target !== undefined) setStep('review');
            }}
          >
            {targets.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                Machine
                <select
                  value={target?.clientId ?? ''}
                  onChange={(event) => setClientId(event.target.value)}
                  className="h-9 border border-border bg-background px-2"
                >
                  {targets.map((entry) => (
                    <option key={entry.clientId} value={entry.clientId}>
                      {entry.hostname} · {entry.kind.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              What should the session do?
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                maxLength={PROMPT_MAX}
                rows={6}
                required
                data-testid="start-session-prompt"
                className="border border-border bg-background p-2 font-mono text-sm"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={trimmed.length === 0}
                className="inline-flex h-9 items-center border border-border px-3 text-sm hover:bg-muted disabled:opacity-60"
              >
                Review
              </button>
            </div>
          </form>
        )}

        {step === 'review' && target !== undefined && (
          <div className="flex flex-col gap-4" data-testid="start-session-review">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Machine</dt>
              <dd>
                {target.hostname} · {target.kind.toUpperCase()}
              </dd>
              <dt className="text-muted-foreground">Folder</dt>
              <dd className="break-all font-mono">{root || projectName}</dd>
              <dt className="text-muted-foreground">Prompt</dt>
              <dd className="max-h-40 overflow-auto whitespace-pre-wrap break-words border border-border p-2 font-mono text-xs">
                {trimmed}
              </dd>
            </dl>
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              <li>It runs under that machine&apos;s own permission settings.</li>
              <li>
                Its permission requests come to your Inbox. One left unanswered for two minutes is
                refused, or decided by the machine&apos;s Brain if one is configured there.
              </li>
              <li>You can stop it from the Console like any other session.</li>
            </ul>
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => void send()}
                data-testid="start-session-confirm"
                className="inline-flex h-9 items-center gap-2 bg-primary px-3 text-sm font-medium text-primary-foreground hover:ring-2 hover:ring-ring hover:ring-offset-2 hover:ring-offset-background disabled:opacity-60"
              >
                <Play className="size-4" />
                {pending ? 'Starting…' : 'Start session'}
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setStep('write')}
                className="inline-flex h-9 items-center border border-border px-3 text-sm hover:bg-muted disabled:opacity-60"
              >
                Back
              </button>
            </div>
          </div>
        )}

        {step === 'sent' && (
          <div className="flex flex-col gap-3" data-testid="start-session-status">
            <p role="status" className="text-sm">
              {status?.ackStatus === 'completed'
                ? `Started on ${target?.hostname}: ${status.ackMessage ?? 'session started'}. It appears under Open sessions when it connects.`
                : status?.ackStatus === 'failed' || status?.ackStatus === 'rejected'
                  ? `${target?.hostname} did not start it: ${status.ackMessage ?? status.ackStatus}`
                  : status?.status === 'delivered'
                    ? `Delivered to ${target?.hostname}, waiting for it to answer…`
                    : 'Queued, waiting for the machine to pick it up…'}
            </p>
            <div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className="inline-flex h-9 items-center border border-border px-3 text-sm hover:bg-muted"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
