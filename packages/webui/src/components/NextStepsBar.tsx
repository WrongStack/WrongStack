import { ArrowRight, Lightbulb, MousePointerClick, Timer } from 'lucide-react';
import type React from 'react';
import { useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import {
  type ParseNextStepsResult,
  type ParsedNextStep as NextStep,
  parseNextSteps,
  stripNextStepsBlock,
} from '@wrongstack/tools/next-steps';

// Re-export the shared parser functions and types for back-compat with
// downstream consumers that import them from this file.
export { parseNextSteps, stripNextStepsBlock };
export type { NextStep, ParseNextStepsResult };

/**
 * Fill the chat input textarea with the given text.
 * Uses the native setter to trigger React's onChange.
 */
export function fillInput(text: string): void {
  const ta = document.querySelector('textarea');
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

  useEffect(() => {
    if (remaining <= 0) {
      onComplete();
      return;
    }
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining, onComplete]);

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
export function NextStepsBar({
  steps,
  yoloMode = false,
  autoMode = false,
  autoDelayMs = 30_000,
  onAutoSubmit,
  canAutoSubmit: canAutoSubmitProp = true,
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
}): React.ReactElement | null {
  const { t } = useAppTranslation();
  if (steps.length === 0) return null;

  // Don't show countdown if the consecutive auto-submit cap has been reached
  const showAutoCountdown = yoloMode && autoMode && canAutoSubmitProp;
  const autoStep = showAutoCountdown ? steps.find((s) => s.auto) : undefined;

  return (
    <div className="mt-4 rounded-xl border border-primary/20 bg-primary/[0.03] overflow-hidden animate-message">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-primary/10 bg-primary/[0.04]">
        <span className="flex items-center justify-center w-5 h-5 rounded-md bg-primary/15 text-primary">
          <Lightbulb className="h-3 w-3" />
        </span>
        <span className="text-xs font-semibold text-foreground/90">{t('activity:nextSteps.header')}</span>
        {showAutoCountdown && autoStep ? (
          <span className="ml-auto flex items-center gap-1 text-xs text-primary">
            <Timer className="h-3 w-3" />
            {t('activity:nextSteps.autoSubmitting')} <AutoCountdown delayMs={autoDelayMs} onComplete={() => onAutoSubmit?.(autoStep.text)} />
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {t('activity:nextSteps.clickToFill')}
          </span>
        )}
      </div>

      {/* ── Steps ── */}
      <div className="flex flex-col p-2 gap-1">
        {steps.map((s) => {
          const isAutoSelected = showAutoCountdown && s.auto;
          return (
            <button
              key={s.index}
              type="button"
              onClick={() => fillInput(s.text)}
              className={`group flex items-center gap-2.5 w-full text-left px-3 py-2 rounded-lg transition-all border ${
                isAutoSelected
                  ? 'bg-primary/10 border-primary/30 ring-1 ring-primary/20'
                  : 'border-transparent hover:bg-primary/[0.08] hover:shadow-sm hover:border-primary/20'
              }`}
              title={t('activity:nextSteps.clickToFillTitle', { text: s.text })}
            >
              {/* Index badge */}
              <span
                className={`flex items-center justify-center w-5 h-5 rounded-md text-[11px] font-mono font-semibold tabular-nums shrink-0 transition-colors ${
                  isAutoSelected
                    ? 'bg-primary/30 text-primary'
                    : 'bg-muted/80 group-hover:bg-primary/20 text-muted-foreground group-hover:text-primary'
                }`}
              >
                {s.index}
              </span>
              {/* Arrow */}
              <ArrowRight
                className={`h-3.5 w-3.5 shrink-0 transition-all ${
                  isAutoSelected
                    ? 'text-primary'
                    : 'text-muted-foreground/60 group-hover:text-primary group-hover:translate-x-0.5'
                }`}
              />
              {/* Text */}
              <span
                className={`text-sm leading-snug flex-1 min-w-0 transition-colors ${
                  isAutoSelected ? 'text-foreground font-medium' : 'text-foreground/80 group-hover:text-foreground'
                }`}
              >
                {s.text}
              </span>
              {/* Auto indicator — show countdown, ⏩ marker, or nothing */}
              {s.auto && (
                <span className="flex items-center gap-1 text-[10px] text-primary/70">
                  {autoMode && s.index === 1 && !showAutoCountdown ? (
                    <span title={t('activity:nextSteps.willAutoSubmit')}>⏩</span>
                  ) : (
                    <Timer className="h-3 w-3" />
                  )}
                  {t('activity:nextSteps.auto')}
                </span>
              )}
              {/* Click indicator — visible on hover */}
              <MousePointerClick
                className={`h-3.5 w-3.5 shrink-0 transition-all ${
                  isAutoSelected ? 'opacity-100 text-primary/60' : 'opacity-0 group-hover:opacity-100 text-primary/60'
                }`}
              />
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return parseNextSteps(content);
}
