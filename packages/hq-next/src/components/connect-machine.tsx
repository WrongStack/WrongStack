'use client';

/**
 * How to attach another machine to this HQ. Used by the Overview while the
 * fleet is empty and by the Fleet's "Add a machine" dialog afterwards.
 *
 * An admin can mint the client token right here; it is shown once, inside
 * the ready-to-paste commands. Otherwise the steps fall back to the CLI on the
 * HQ machine and show a placeholder.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@hq/components/ui/dialog';
import { Check, Copy, MonitorUp, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { hubAddressAdvice } from '@/lib/hub-address';
import { MachineTokenForm, type MintedToken } from './machine-token-form';

export function CopyLine({ text, label }: { text: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 border border-border bg-background px-3 py-2">
      {/* Wraps instead of scrolling: a scroll box would need keyboard focus. */}
      <code className="min-w-0 flex-1 break-all font-mono text-sm">{text}</code>
      <button
        type="button"
        aria-label={label ?? 'Copy command'}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="grid size-8 shrink-0 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

function useOrigin(): string {
  const [origin, setOrigin] = useState('http://<this-hq-host>:3499');
  useEffect(() => setOrigin(window.location.origin), []);
  return origin;
}

export function ConnectMachineSteps(): ReactNode {
  const origin = useOrigin();
  const [minted, setMinted] = useState<MintedToken | null>(null);
  const token = minted?.token ?? '<client-token>';
  const advice = hubAddressAdvice(origin);
  const url = advice.kind === 'loopback' ? advice.example : origin;
  return (
    <div className="flex flex-col gap-4 text-sm">
      {advice.kind === 'loopback' && (
        <p
          role="note"
          className="flex gap-2 border border-warning/50 bg-warning/5 px-3 py-2 text-warning"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            You opened HQ as <code className="font-mono">{advice.host}</code>, which other machines
            cannot reach. Use this machine’s network address or hostname instead — HQ listens on
            every interface unless it was started with <code className="font-mono">--host</code>.
          </span>
        </p>
      )}
      <ol className="flex flex-col gap-4">
        <li className="flex flex-col gap-2">
          <span>
            <span className="font-semibold">1.</span> Create a token for the machine:
          </span>
          {minted === null ? (
            <>
              <MachineTokenForm onMinted={setMinted} />
              <span className="text-muted-foreground">
                Or on the HQ machine:{' '}
                <code className="font-mono">wstack hq token create --client</code>
              </span>
            </>
          ) : (
            <p
              role="status"
              className="border border-success/50 bg-success/5 px-3 py-2"
              data-testid="machine-token-minted"
            >
              Token for <span className="font-semibold">{minted.label}</span> created
              {minted.expiresAt !== undefined
                ? `, valid until ${new Date(minted.expiresAt).toLocaleDateString()}`
                : ', with no expiry'}
              {minted.shell ? ', with remote shell' : ''}. It is in the commands below and will not
              be shown again — copy it now. Revoke it any time under Fleet → Machines.
            </p>
          )}
        </li>
        <li className="flex flex-col gap-2">
          <span>
            <span className="font-semibold">2.</span> On the new machine, inside WrongStack (CLI,
            TUI or WebUI), point it at HQ. This is saved and applies live:
          </span>
          <CopyLine text={`/hq set ${url} ${token}`} />
          <span className="text-muted-foreground">
            For a one-off run or a script, the environment works too:
          </span>
          <CopyLine text={`WRONGSTACK_HQ_URL=${url} WRONGSTACK_HQ_TOKEN=${token} wstack`} />
        </li>
        <li className="text-muted-foreground">
          <span className="font-semibold text-foreground">3.</span> It appears in the Fleet within a
          few seconds. <code className="font-mono">/hq</code> on that machine shows whether it
          reached HQ.
        </li>
      </ol>
    </div>
  );
}

/** Fleet toolbar button: the same steps in a dialog, any time. */
export function AddMachineButton(): ReactNode {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted">
        <MonitorUp className="size-4" />
        Add a machine
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogTitle>Add a machine</DialogTitle>
        <DialogDescription>
          Any machine running WrongStack can report to this HQ and take commands from it.
        </DialogDescription>
        <ConnectMachineSteps />
      </DialogContent>
    </Dialog>
  );
}
