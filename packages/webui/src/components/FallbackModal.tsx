/**
 * Fallback model modal — shown when `provider.fallback_pending` fires.
 *
 * Displays the failed model, a list of fallback candidates with a live
 * countdown, and lets the user manually pick a model or wait for
 * auto-switch. The modal always renders on top regardless of what
 * view is active, ensuring the user sees every model switch.
 */
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { getWSClient } from '@/lib/ws-client';
import { resolvePendingFallback } from '@/stores/chat-lanes';
import { useFallbackStore } from '@/stores/fallback-store';

export function FallbackModal() {
  const pending = useFallbackStore((s) => s.pending);
  const selected = useFallbackStore((s) => s.selected);
  const move = useFallbackStore((s) => s.move);
  const clear = useFallbackStore((s) => s.clear);

  const [remaining, setRemaining] = useState(0);
  const resolvedRef = useRef(false);
  // This state-controlled dialog has no Radix trigger, so retain its opener
  // explicitly and return focus once the pending fallback is resolved.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Track the live `selected` index so the countdown expiry closure
  // reads the current value, not the stale mount-time snapshot.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    if (pending || !restoreFocusRef.current?.isConnected) return;
    restoreFocusRef.current.focus();
    restoreFocusRef.current = null;
  }, [pending]);

  // Reset countdown when a new pending event arrives.
  useEffect(() => {
    if (pending) {
      resolvedRef.current = false;
      setRemaining(Math.max(1, pending.autoSwitchSeconds));
    }
  }, [pending?.requestId]);

  // Countdown timer.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          if (!resolvedRef.current) {
            resolvedRef.current = true;
            // Auto-switch: pick the currently highlighted entry.
            const chosen = pending.candidates[selectedRef.current] ?? null;
            sendChoice(pending.requestId, chosen);
            clear();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.requestId]);

  const resolve = (choice: { providerId: string; model: string } | null) => {
    if (!pending || resolvedRef.current) return;
    resolvedRef.current = true;
    sendChoice(pending.requestId, choice);
    clear();
  };

  const fromLabel = pending ? `${pending.from.providerId}/${pending.from.model}` : '';

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(nextOpen) => {
        // Preserve the previous contract: pointer dismissal does nothing, and
        // the only explicit dismiss path (Escape) chooses the auto fallback.
        if (!nextOpen) resolve(null);
      }}
    >
      {pending ? (
        <DialogContent
          showCloseButton={false}
          className="max-w-md gap-0 overflow-hidden border-warning/50 p-5"
          onOpenAutoFocus={() => {
            const activeElement = document.activeElement;
            restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            const restoreTarget = restoreFocusRef.current;
            if (!restoreTarget?.isConnected) return;
            event.preventDefault();
            restoreTarget.focus();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            resolve(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              resolve(pending.candidates[selectedRef.current] ?? null);
            }
          }}
        >
          <DialogTitle className="text-sm font-bold text-warning">⚠ MODEL FALLBACK</DialogTitle>
          <DialogDescription className="sr-only">
            Choose a fallback model or wait for the automatic switch.
          </DialogDescription>
          {/* Header */}
          <div className="flex items-center justify-between">
            <span aria-hidden="true" />
            <span className="text-xs text-warning">{remaining}s</span>
          </div>

          {/* Failed model */}
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-mono text-card-foreground">{fromLabel}</span> returned{' '}
            <span className="font-mono text-warning">{pending.status}</span>
          </p>

          {/* Candidate list */}
          <div className="mt-4 space-y-1">
            <p className="text-xs text-muted-foreground">
              Select a fallback model (↑/↓ to move, Enter to pick, Esc for auto):
            </p>
            {pending.candidates.map((c, i) => {
              const isSel = i === selected;
              const label = `${c.providerId}/${c.model}`;
              return (
                <button
                  key={`fb-${i}`}
                  type="button"
                  onClick={() => {
                    if (resolvedRef.current) return;
                    resolvedRef.current = true;
                    sendChoice(pending.requestId, c);
                    clear();
                  }}
                  onMouseEnter={() => useFallbackStore.getState().setSelected(i)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors ${
                    isSel
                      ? 'bg-warning/15 text-card-foreground ring-1 ring-warning/50'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <span className={isSel ? 'text-warning' : 'text-transparent'}>▸</span>
                  <span className="font-mono">{label}</span>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <p className="mt-4 text-[10px] text-muted-foreground">
            Enter picks · Esc auto-switches · countdown picks highlighted entry
          </p>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/**
 * Send the user's choice back to the server via WS.
 *
 * Addressed at the tab whose request stalled — the dialog is one surface over
 * four conversations, and an unaddressed answer is applied to whichever
 * session the runtime is pointing at. The parked copy is retired here too, so
 * an answered prompt cannot reopen on the next tab switch.
 */
function sendChoice(requestId: string, choice: { providerId: string; model: string } | null): void {
  resolvePendingFallback(requestId);
  try {
    const client = getWSClient();
    const base = choice
      ? { requestId, providerId: choice.providerId, model: choice.model }
      : // null = auto-switch (countdown expired or Esc); tell the server to proceed.
        { requestId, autoSwitch: true };
    client.send({ type: 'model.fallback_choice', payload: client.withSession(base) });
  } catch {
    // Best-effort — the countdown will auto-switch anyway.
  }
}
