import {
  type ParsedNextStep as NextStep,
  type ParseNextStepsResult,
  parseNextSteps,
  stripNextStepsBlock,
} from '@wrongstack/tools/next-steps';
import { ArrowRight, Check, Lightbulb, MousePointerClick, Timer } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';

export type { NextStep, ParseNextStepsResult };
// Re-export the shared parser functions and types for back-compat with
// downstream consumers that import them from this file.
export { parseNextSteps, stripNextStepsBlock };

/**
 * Fill the chat input textarea with the given text.
 * Uses the native setter to trigger React's onChange.
 */
export function fillInput(text: string): void {
  const ta =
    document.querySelector<HTMLTextAreaElement>('[data-chat-textarea]') ??
    document.querySelector('textarea');
  if (!ta) return;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  setter?.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

/** Auto-submit countdown timer component for YOLO+auto mode */
function AutoCountdown({
  delayMs,
  onComplete,
}: {
  delayMs: number;
  onComplete: () => void;
}): React.ReactElement {
  const [remaining, setRemaining] = useState(Math.ceil(delayMs / 1000));
  // Hold onComplete in a ref to decouple the timer effect from unstable
  // callback references. The parent re-renders frequently (Zustand selectors
  // return new arrays), which would otherwise cancel the timer on every tick.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (remaining <= 0) {
      onCompleteRef.current();
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  return (
    <span className="flex items-center gap-1 text-xs text-primary font-medium">
      <Timer className="h-3 w-3" />
      {remaining}s
    </span>
  );
}

/**
 * Renders extracted next steps as a prominent, clickable action bar.
 * Each button fills the chat input with the suggestion text.
 * Auto="true" items show a countdown timer when yolo+auto mode is active.
 *
 * Design goals:
 * - Immediately noticeable after the agent's reply (not buried in tiny text)
 * - Distinct from the message body via card-like appearance and accent colors
 * - One-click execution — no copy-paste, just click and send
 * - Auto items in YOLO+auto mode show countdown and auto-submit
 */
/**
 * Default countdown seconds for the session-end auto-fill, i.e. how long
 * after the completion sound before the first next-step suggestion is
 * placed into the input.
 */
const SESSION_END_FILL_SECONDS = 5;

/**
 * Countdown timer that fills the input (without submitting) when the
 * session-end event fires. Rendered as an inline timer badge.
 */
function SessionEndFillCountdown({
  seconds,
  onComplete,
}: {
  seconds: number;
  onComplete: () => void;
}): React.ReactElement {
  const [remaining, setRemaining] = useState(seconds);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (remaining <= 0) {
      onCompleteRef.current();
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  return (
    <span className="flex items-center gap-1 text-xs text-primary font-medium">
      <Timer className="h-3 w-3" />
      {remaining}s
    </span>
  );
}

export function NextStepsBar({
  steps,
  yoloMode = false,
  autoMode = false,
  autoDelayMs = 30_000,
  onAutoSubmit,
  canAutoSubmit: canAutoSubmitProp = true,
  /** If true, start a countdown that fills the input after session end */
  sessionEndAutoFill = false,
  /** Override the default 5s countdown for session-end auto-fill */
  sessionEndAutoFillSeconds = SESSION_END_FILL_SECONDS,
  isLatest = true,
  onBatchSubmit,
}: {
  steps: NextStep[];
  /** Whether YOLO mode is active */
  yoloMode?: boolean;
  /** Whether AUTO autonomy mode is active */
  autoMode?: boolean;
  /** Countdown delay in ms for auto items (default 30s) */
  autoDelayMs?: number;
  /** Callback when auto countdown completes */
  onAutoSubmit?: (text: string) => void;
  /** Whether auto-submit is currently allowed (cap not reached). */
  canAutoSubmit?: boolean;
  /** If true, start a countdown that fills the input after session end */
  sessionEndAutoFill?: boolean;
  /** Override the default countdown seconds for session-end auto-fill */
  sessionEndAutoFillSeconds?: number;
  /** Whether this bar belongs to the latest assistant message. When false,
   *  the session-end auto-fill listener is suppressed to prevent duplicate
   *  handler registration across multiple bars. */
  isLatest?: boolean;
  /** Callback to submit multiple selected step texts together (bypasses refine) */
  onBatchSubmit?: (texts: string[]) => void;
}): React.ReactElement | null {
  const { t } = useAppTranslation();

  // ── Multi-select state ──────────────────────────────────────────────
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const toggleIndex = useCallback((idx: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);
  const hasSelection = selectedIndices.size > 0;
  const batchTexts = useMemo(
    () => steps.filter((s) => selectedIndices.has(s.index)).map((s) => s.text),
    [steps, selectedIndices],
  );

  // ── Session-end auto-fill countdown ──────────────────────────────────
  // Listens for the custom event dispatched after the completion chime and
  // starts a countdown that fills the input (does NOT auto-submit — the
  // user can still edit or press Enter).
  const [autoFillActive, setAutoFillActive] = useState(false);
  const autoFillFired = useRef(false);
  useEffect(() => {
    if (!isLatest || !sessionEndAutoFill) return;
    if (autoFillActive || autoFillFired.current) return;
    const handler = () => {
      if (steps.length > 0) {
        autoFillFired.current = true;
        setAutoFillActive(true);
      }
    };
    document.addEventListener('chat:next-step-countdown', handler);
    return () => document.removeEventListener('chat:next-step-countdown', handler);
  }, [steps.length, autoFillActive, isLatest, sessionEndAutoFill]);

  // Cancel any in-flight session-end auto-fill when the autonomy gate CLOSES
  // mid-countdown. The trigger for arming the countdown is the `chat:next-step-
  // countdown` document event, which is dispatched unconditionally on every
  // done run — it does not consult the gate. So once `autoFillActive` is true
  // the countdown always starts; whether it should *finish* and fire
  // `onAutoSubmit` is what we gate here.
  //
  // We track the previous gate value in a ref so we only cancel on a true
  // CLOSING transition (open → closed). Checking the current gate alone is
  // wrong: a bar instance mounted while the gate is already closed (e.g. the
  // user toggled autonomy off before the assistant reply even finished) would
  // see `autoFillActive=true` and immediately cancel — silently killing the
  // `fillInput` path (the only escape hatch when the gate is closed). The
  // transition check makes the cancel a true response to a mid-run change.
  //
  // `autoFillFired` is NOT reset here so we don't re-arm the listener for
  // the same bar instance after a toggle-off-then-on; the next assistant
  // reply gets a fresh bar instance.
  const prevGateRef = useRef(yoloMode && autoMode && canAutoSubmitProp);
  useEffect(() => {
    const gateOpen = yoloMode && autoMode && canAutoSubmitProp;
    const wasOpen = prevGateRef.current;
    prevGateRef.current = gateOpen;
    if (!autoFillActive) return;
    if (wasOpen && !gateOpen) {
      setAutoFillActive(false);
    }
  }, [autoFillActive, yoloMode, autoMode, canAutoSubmitProp]);

  // The arming event `chat:next-step-countdown` is dispatched unconditionally on
  // every done run — it does NOT consult the autonomy gate. So when the
  // countdown completes we must re-check the gate here, not at arm time:
  // if the user flipped autonomy off between the run finishing and the
  // countdown elapsing, we fall through to `fillInput` instead of sending a
  // prompt the user explicitly disabled. Same gate as the YOLO countdown path
  // (showAutoCountdown) so a closed gate at the fire site never auto-submits.
  const gateOpen = yoloMode && autoMode && canAutoSubmitProp;
  const handleAutoFill = useCallback(() => {
    if (steps.length > 0) {
      const step = steps[0]!;
      if (step.auto && onAutoSubmit && gateOpen) {
        onAutoSubmit(step.text);
      } else {
        fillInput(step.text);
      }
    }
    setAutoFillActive(false);
  }, [steps, onAutoSubmit, gateOpen]);

  // Clear multi-selection when steps structurally change (new response, new indices).
  // Use a structural key to avoid Zalgo — step objects are new refs on every render
  // from Zustand selectors, but only a different count or different index=text pairs
  // means the user should lose their selection.
  // NOTE: must be before the early return so hooks run unconditionally (rules-of-hooks).
  const stepsKey = steps.map((s) => `${s.index}:${s.text}`).join('|');
  useEffect(() => {
    setSelectedIndices(new Set());
  }, [stepsKey]);

  if (steps.length === 0) return null;

  // Don't show YOLO countdown if the consecutive auto-submit cap has been reached
  const showAutoCountdown = yoloMode && autoMode && canAutoSubmitProp;
  const autoStep = showAutoCountdown ? steps.find((s) => s.auto) : undefined;

  // When auto mode is active but no step carries the auto="true" marker,
  // we still want the user to notice that auto mode is engaged.
  const autoModeUnmet = autoMode && !steps.some((s) => s.auto);

  return (
    <div className="mt-4 rounded-xl border border-primary/20 bg-primary/[0.03] overflow-hidden animate-message">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-primary/10 bg-primary/[0.04]">
        <span className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/15 text-primary">
          <Lightbulb className="h-3 w-3" />
        </span>
        <span className="text-xs font-semibold text-foreground/90">
          {t('activity:nextSteps.header', 'Suggestions')}
        </span>
        {autoFillActive ? (
          <span className="ml-auto flex items-center gap-1 text-xs text-primary font-medium">
            {steps[0]?.auto && onAutoSubmit
              ? t('activity:nextSteps.autoSubmitting', 'Auto-submitting in')
              : t('activity:nextSteps.autoFilling', 'Filling in')}{' '}
            <SessionEndFillCountdown
              seconds={sessionEndAutoFillSeconds}
              onComplete={handleAutoFill}
            />
          </span>
        ) : showAutoCountdown && autoStep ? (
          <span className="ml-auto flex items-center gap-1 text-xs text-primary">
            <Timer className="h-3 w-3" />
            {t('activity:nextSteps.autoSubmitting', 'Auto-submitting in')}{' '}
            <AutoCountdown delayMs={autoDelayMs} onComplete={() => onAutoSubmit?.(autoStep.text)} />
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {autoModeUnmet ? (
              <span className="flex items-center gap-1 text-[11px] font-medium text-accent2">
                <Timer className="h-3 w-3" />
                {t('activity:nextSteps.autoModeIdle', 'Auto — waiting for auto="true" marker')}
              </span>
            ) : (
              t('activity:nextSteps.clickToFill', 'Click to fill')
            )}
          </span>
        )}
      </div>

      {/* ── Multi-select batch submit bar ── */}
      {hasSelection && onBatchSubmit && batchTexts.length > 0 && (
        <div className="flex items-center justify-end gap-2 px-3.5 py-1.5 border-b border-primary/10 bg-primary/[0.06]">
          <span className="text-xs text-muted-foreground">
            {t('activity:nextSteps.nSelected', { count: batchTexts.length })}
          </span>
          <button
            type="button"
            onClick={() => {
              onBatchSubmit(batchTexts);
              setSelectedIndices(new Set());
            }}
            className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <ArrowRight className="h-3 w-3" />
            {t('activity:nextSteps.submitN', { count: batchTexts.length })}
          </button>
        </div>
      )}

      {/* ── Steps ── */}
      <div className="flex flex-col p-2 gap-1">
        {steps.map((s) => {
          const isAutoSelected = autoFillActive
            ? s.index === steps[0]?.index
            : showAutoCountdown && s.auto;
          const isSelected = selectedIndices.has(s.index);
          return (
            <button
              key={s.index}
              type="button"
              aria-pressed={onBatchSubmit ? isSelected : undefined}
              onClick={onBatchSubmit ? () => toggleIndex(s.index) : () => fillInput(s.text)}
              className={`group flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-lg transition-all border ${
                isSelected
                  ? 'bg-accent2/10 border-accent2/40 ring-1 ring-accent2/30'
                  : isAutoSelected
                    ? 'bg-primary/10 border-primary/30 ring-1 ring-primary/20'
                    : 'border-transparent hover:bg-primary/[0.08] hover:shadow-sm hover:border-primary/20'
              }`}
              title={
                onBatchSubmit
                  ? isSelected
                    ? t('activity:nextSteps.deselectTitle', 'Deselect')
                    : t('activity:nextSteps.selectTitle', 'Select for batch submit')
                  : t('activity:nextSteps.clickToFillTitle', { text: s.text })
              }
            >
              {/* Index badge + checkmark */}
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-md text-[11px] font-mono font-semibold tabular-nums shrink-0 transition-colors ${
                  isSelected
                    ? 'bg-accent2/30 text-accent2'
                    : isAutoSelected
                      ? 'bg-primary/30 text-primary'
                      : 'bg-muted/80 group-hover:bg-primary/20 text-muted-foreground group-hover:text-primary'
                }`}
              >
                {isSelected ? <Check className="h-3 w-3" /> : s.index}
              </span>
              {/* Arrow */}
              <ArrowRight
                className={`h-3.5 w-3.5 shrink-0 transition-all ${
                  isSelected
                    ? 'text-accent2'
                    : isAutoSelected
                      ? 'text-primary'
                      : 'text-muted-foreground/75 group-hover:text-primary group-hover:translate-x-0.5'
                }`}
              />
              {/* Text */}
              <span
                className={`text-sm leading-snug flex-1 min-w-0 transition-colors ${
                  isSelected
                    ? 'text-accent2 font-medium'
                    : isAutoSelected
                      ? 'text-foreground font-medium'
                      : 'text-foreground/80 group-hover:text-foreground'
                }`}
              >
                {s.text}
              </span>
              {/* Auto indicator — show countdown, ⏩ marker, or nothing */}
              {s.auto && (
                <span className="flex items-center gap-1 text-[10px] text-primary/70">
                  {autoMode && s.index === 1 && !showAutoCountdown ? (
                    <span title={t('activity:nextSteps.willAutoSubmit', 'Will auto-submit')}>
                      ⏩
                    </span>
                  ) : (
                    <Timer className="h-3 w-3" />
                  )}
                  {t('activity:nextSteps.auto', 'Auto')}
                </span>
              )}
              {/* Click indicator — visible on hover for unselected items; hidden on selected items where the checkmark badge already communicates selection state */}
              {!isSelected && (
                <MousePointerClick
                  className={`h-3.5 w-3.5 shrink-0 transition-all ${
                    isAutoSelected
                      ? 'opacity-100 text-primary/60'
                      : 'opacity-0 group-hover:opacity-100 text-primary/60'
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Hook-friendly version: takes raw markdown content and returns the parse
 * result, including the steps array and the content with the block stripped.
 */
export function useNextSteps(content: string): ParseNextStepsResult {
  return useMemo(() => parseNextSteps(content), [content]);
}
