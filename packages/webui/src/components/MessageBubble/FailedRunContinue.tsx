import { useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { getWSClient } from '@/lib/ws-client';
import { useChatStore, useConfigStore } from '@/stores';
import { useAutoSubmitStreak } from '@/stores/auto-submit-streak.js';

/** Errors from expensive report passes (Chimera etc.) wait longer before the
 *  auto-continue fires — their operator may still be reading the report. */
const CHIMERA_PATTERN = /chimera/i;

/** A failure older than this is historical transcript, not a live failure:
 *  the Continue button stays manual (no countdown) for it, so reopening an
 *  old session never auto-fires a run nobody asked for. */
const FRESH_FAILURE_WINDOW_MS = 60_000;

export function autoTriggerMsFor(text: string): number {
  return CHIMERA_PATTERN.test(text) ? 30_000 : 15_000;
}

/**
 * Continue button for a failed assistant message, with an optional
 * self-triggering countdown (15s default, 30s for Chimera-style report
 * failures). The countdown arms only for FRESH failures; Cancel/Stop
 * disarms it; a run already restarted by the user disarms it too.
 */
export function FailedRunContinue({ text, timestamp }: { text: string; timestamp?: number }) {
  const { t } = useAppTranslation();
  const isLoading = useChatStore((s) => s.isLoading);
  const addMessage = useChatStore((s) => s.addMessage);
  const setLoading = useChatStore((s) => s.setLoading);
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const { canAutoSubmit, recordPrompt, recordAutoSubmit } = useAutoSubmitStreak();

  const prompt = t('activity:failedRun.continuePrompt', {
    defaultValue:
      'The previous run failed — continue from where it stopped and finish the remaining work.',
  });

  const [remainingMs, setRemainingMs] = useState<number | null>(() => {
    if (timestamp === undefined || Date.now() - timestamp >= FRESH_FAILURE_WINDOW_MS) return null;
    return autoTriggerMsFor(text);
  });
  const firedRef = useRef(false);
  const [gone, setGone] = useState(false);

  const fire = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    // A run the user already restarted takes precedence over the auto-fire.
    if (useChatStore.getState().isLoading) return;
    if (!canAutoSubmit()) return;
    const client = getWSClient(wsUrl);
    if (!client.isConnected) return;
    // Same shared streak guard the auto-submit path uses — one session-wide
    // loop breaker for every automated send.
    if (!recordPrompt(prompt)) {
      addMessage({ role: 'assistant', content: t('activity:message.autoLoopHalted') });
      return;
    }
    recordAutoSubmit();
    addMessage({ role: 'user', content: prompt });
    setLoading(true);
    client.sendMessage(prompt);
    setGone(true);
  };

  // 1s countdown ticks; each tick re-checks the live loading flag so a
  // manually restarted run disarms the auto-fire immediately.
  useEffect(() => {
    if (remainingMs === null) return;
    if (remainingMs <= 0) {
      fire();
      return;
    }
    if (useChatStore.getState().isLoading) {
      setRemainingMs(null);
      return;
    }
    const timer = setTimeout(
      () => setRemainingMs((ms) => (ms === null ? null : Math.max(0, ms - 1000))),
      1000,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingMs]);

  if (gone) return null;
  const seconds = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        onClick={fire}
        className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
      >
        ▶ {t('activity:failedRun.continue', { defaultValue: 'Continue' })}
        {seconds !== null ? ` · ${seconds}s` : ''}
      </button>
      {seconds !== null && (
        <button
          type="button"
          onClick={() => setRemainingMs(null)}
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('activity:failedRun.cancel', { defaultValue: 'Cancel' })}
        </button>
      )}
    </div>
  );
}
