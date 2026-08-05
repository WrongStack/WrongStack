/**
 * Fallback model modal — shown when `provider.fallback_pending` fires.
 *
 * Displays the failed model, a list of fallback candidates with a live
 * countdown, and lets the user manually pick a model or wait for
 * auto-switch. The modal always renders on top regardless of what
 * view is active, ensuring the user sees every model switch.
 */
import { useEffect, useRef, useState } from 'react';
import { useFallbackStore } from '@/stores/fallback-store';
import { getWSClient } from '@/lib/ws-client';

export function FallbackModal() {
  const pending = useFallbackStore((s) => s.pending);
  const selected = useFallbackStore((s) => s.selected);
  const move = useFallbackStore((s) => s.move);
  const clear = useFallbackStore((s) => s.clear);

  const [remaining, setRemaining] = useState(0);
  const resolvedRef = useRef(false);
  // Track the live `selected` index so the countdown expiry closure
  // reads the current value, not the stale mount-time snapshot.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

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

  // Keyboard navigation.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (resolvedRef.current) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolvedRef.current = true;
        const chosen = pending.candidates[selectedRef.current] ?? null;
        sendChoice(pending.requestId, chosen);
        clear();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        resolvedRef.current = true;
        // Esc = accept auto-switch (null → chain head).
        sendChoice(pending.requestId, null);
        clear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.requestId, selected]);

  if (!pending) return null;

  const fromLabel = `${pending.from.providerId}/${pending.from.model}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Model fallback"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
    >
      <div className="w-full max-w-md rounded-xl border border-amber-500/50 bg-zinc-900 p-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-amber-400">⚠ MODEL FALLBACK</h2>
          <span className="text-xs text-amber-400">{remaining}s</span>
        </div>

        {/* Failed model */}
        <p className="mt-2 text-xs text-zinc-400">
          <span className="font-mono text-zinc-300">{fromLabel}</span> returned{' '}
          <span className="font-mono text-amber-400">{pending.status}</span>
        </p>

        {/* Candidate list */}
        <div className="mt-4 space-y-1">
          <p className="text-xs text-zinc-500">
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
                    ? 'bg-amber-500/15 text-zinc-100 ring-1 ring-amber-500/50'
                    : 'text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                <span className={isSel ? 'text-amber-400' : 'text-transparent'}>▸</span>
                <span className="font-mono">{label}</span>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <p className="mt-4 text-[10px] text-zinc-600">
          Enter picks · Esc auto-switches · countdown picks highlighted entry
        </p>
      </div>
    </div>
  );
}

/** Send the user's choice back to the server via WS. */
function sendChoice(
  requestId: string,
  choice: { providerId: string; model: string } | null,
): void {
  try {
    const client = getWSClient();
    if (choice) {
      client.send({
        type: 'model.fallback_choice',
        payload: { requestId, providerId: choice.providerId, model: choice.model },
      });
    } else {
      // null = auto-switch (countdown expired or Esc); tell the server to proceed.
      client.send({
        type: 'model.fallback_choice',
        payload: { requestId, autoSwitch: true },
      });
    }
  } catch {
    // Best-effort — the countdown will auto-switch anyway.
  }
}
