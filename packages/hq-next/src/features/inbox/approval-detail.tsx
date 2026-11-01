'use client';

import {
  credentialAllows,
  useCredentialCapabilities,
} from '@hq/domain/use-credential-capabilities';
/**
 * One permission prompt, answered from HQ.
 *
 * The prompt stays live on the surface that raised it; whichever answer lands
 * first wins. One-off answers are a single click. Anything that writes a
 * persistent trust rule on the remote machine takes a second, explicit
 * confirmation that names the exact pattern it will store — a standing grant
 * is a security decision, not a convenience click.
 */
import {
  type ApprovalDecision,
  type PendingApproval,
  useAnswerApproval,
} from '@hq/domain/use-pending-approvals';
import { ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { remainingLabel } from '../attention/model';

/** Under this, answering from HQ is a race against the Brain arbiter. */
const URGENT_MS = 30_000;

type StandingDecision = Extract<
  ApprovalDecision,
  'always-exact' | 'always-command' | 'always-tool' | 'deny'
>;

interface StandingOption {
  decision: StandingDecision;
  label: string;
  explain: (approval: PendingApproval) => string;
  danger: boolean;
}

const STANDING_OPTIONS: readonly StandingOption[] = [
  {
    decision: 'always-exact',
    label: 'Always allow this exact call',
    explain: (a) => `Stores a trust rule for ${a.suggestedPattern}.`,
    danger: false,
  },
  {
    decision: 'always-command',
    label: 'Always allow this command, any arguments',
    explain: (a) => `Stores a trust rule for the ${a.toolName} command with any arguments.`,
    danger: false,
  },
  {
    decision: 'always-tool',
    label: 'Always allow this tool, any input',
    explain: (a) => `Stores a trust rule letting ${a.toolName} run with any input, unprompted.`,
    danger: false,
  },
  {
    decision: 'deny',
    label: 'Deny permanently',
    explain: (a) => `Stores a permanent denial for ${a.suggestedPattern}.`,
    danger: true,
  },
];

function riskLabel(approval: PendingApproval): { label: string; critical: boolean } {
  if (approval.boundaryReason) return { label: 'Governance boundary', critical: true };
  if (approval.destructive || approval.riskTier === 'destructive')
    return { label: 'Destructive', critical: true };
  if (approval.riskTier === 'safe') return { label: 'Low risk', critical: false };
  return { label: 'Standard risk', critical: false };
}

function stringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

export function ApprovalDetail({
  approval,
  projectName,
}: {
  approval: PendingApproval;
  /** Display name from the fleet snapshot; falls back to the project id. */
  projectName?: string | undefined;
}): ReactNode {
  const { answer, pendingFor } = useAnswerApproval();
  // Offer only what this login may do: the server re-checks every answer, and
  // a button that always comes back 403 is worse than no button. A phone login
  // holds `control.approve.once` — one-off answers, never standing rules.
  const capabilities = useCredentialCapabilities();
  const canAnswerOnce =
    credentialAllows(capabilities, 'control.approve') ||
    credentialAllows(capabilities, 'control.approve.once');
  const canRemember = credentialAllows(capabilities, 'control.approve');
  const sending = pendingFor(approval.toolUseId);
  const [confirming, setConfirming] = useState<StandingDecision | null>(null);
  const risk = riskLabel(approval);
  const urgent = approval.remainingMs <= URGENT_MS;
  const input = stringify(approval.inputSummary);
  const options = STANDING_OPTIONS.filter(
    (option) => option.decision !== 'always-command' || approval.toolName === 'exec',
  );
  const pending = options.find((option) => option.decision === confirming);

  // A different prompt must never inherit a half-confirmed standing grant.
  useEffect(() => setConfirming(null), [approval.toolUseId]);

  return (
    <article className="flex flex-col gap-6" aria-labelledby="approval-title">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">Permission requested</p>
          <h2 id="approval-title" className="mt-1 font-mono text-2xl font-semibold">
            {approval.toolName}
          </h2>
        </div>
        <span
          className={cn(
            'border px-2.5 py-1 text-sm',
            risk.critical
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : 'border-border text-muted-foreground',
          )}
        >
          {risk.label}
        </span>
        <span
          aria-live="polite"
          className={cn(
            'tabular border px-2.5 py-1 text-sm',
            urgent ? 'border-destructive/40 text-destructive' : 'border-border',
          )}
          title="After the deadline the Brain arbiter decides without you."
        >
          {remainingLabel(approval.remainingMs)}
        </span>
      </header>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Project</dt>
          <dd className="mt-0.5 truncate">{projectName ?? approval.projectId}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Session</dt>
          <dd className="mt-0.5 truncate font-mono">{approval.sessionId?.slice(0, 12) ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Client</dt>
          <dd className="mt-0.5 truncate font-mono">{approval.clientId}</dd>
        </div>
      </dl>

      {approval.boundaryReason && (
        <p className="flex items-start gap-2 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {approval.boundaryReason}
        </p>
      )}

      {approval.writeTargets !== undefined && approval.writeTargets.length > 0 && (
        <section>
          <h3 className="text-sm text-muted-foreground">Will write to</h3>
          <ul className="mt-1.5 flex flex-col gap-1 font-mono text-sm">
            {approval.writeTargets.map((target) => (
              <li key={target} className="truncate">
                {target}
              </li>
            ))}
          </ul>
        </section>
      )}

      {input !== null && (
        <section>
          <h3 className="text-sm text-muted-foreground">Input</h3>
          <pre className="mt-1.5 max-h-72 overflow-auto border border-border bg-background p-3 font-mono text-sm leading-relaxed">
            {input}
          </pre>
        </section>
      )}

      <section className="flex flex-col gap-3 border-t border-border pt-5">
        {canAnswerOnce ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sending}
              onClick={() => void answer(approval, 'yes')}
              className="h-10 bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Allow once
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => void answer(approval, 'no')}
              className="h-10 border border-border px-5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              Refuse once
            </button>
            {sending && <span className="self-center text-sm text-muted-foreground">Sending…</span>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This login can watch prompts but not answer them. Answer on the machine, or sign in with
            a login that may approve.
          </p>
        )}
        {canRemember && (
          <details className="group">
            <summary className="cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground">
              Remember a decision on this machine…
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              {options.map((option) => (
                <button
                  key={option.decision}
                  type="button"
                  disabled={sending}
                  aria-pressed={confirming === option.decision}
                  onClick={() =>
                    setConfirming((current) =>
                      current === option.decision ? null : option.decision,
                    )
                  }
                  className={cn(
                    'flex flex-col items-start border px-4 py-2.5 text-left text-sm disabled:opacity-50',
                    confirming === option.decision
                      ? 'border-foreground/50 bg-muted'
                      : 'border-border hover:bg-muted/60',
                    option.danger && 'text-destructive',
                  )}
                >
                  <span className="font-medium">{option.label}</span>
                  <span className="text-muted-foreground">{option.explain(approval)}</span>
                </button>
              ))}
            </div>
          </details>
        )}

        {pending !== undefined && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 border border-warning/50 bg-warning/10 px-4 py-3 text-sm"
          >
            <ShieldAlert className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">
              {pending.explain(approval)} It is written on{' '}
              <span className="font-mono">{approval.clientId}</span> and applies to future runs
              without asking.
            </span>
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                void answer(approval, pending.decision);
                setConfirming(null);
              }}
              className={cn(
                'h-9 px-4 font-medium disabled:opacity-50',
                pending.danger
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-foreground text-background',
              )}
            >
              Confirm: {pending.label.toLowerCase()}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="h-9 border border-border px-4 hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        )}
      </section>
    </article>
  );
}
