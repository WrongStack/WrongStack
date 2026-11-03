import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { getPersonaColor, getPersonaIcon } from './council-decision-format';
import type { CouncilDecisionData } from './types';

type CouncilSeat = NonNullable<CouncilDecisionData['seats']>[number];

/** One voter's card: persona, model, vote pill, and its rationale drawer. */
export function CouncilSeatCard({
  seat,
  isExpanded,
  toggleRationale,
}: {
  seat: CouncilSeat;
  isExpanded: boolean;
  toggleRationale: (seatId: string) => void;
}) {
  const { t } = useAppTranslation();
  const failed = seat.status !== 'valid';
  const verdict = failed
    ? (seat.error ?? seat.status)
    : (seat.optionId ?? seat.stance ?? 'Approved');
  const hasRationale = Boolean(seat.rationale || seat.stance);

  return (
    <div
      className={cn(
        'group flex flex-col justify-between rounded-xl border p-3.5 transition-all duration-200',
        failed
          ? 'border-destructive/30 bg-destructive/5'
          : seat.veto
            ? 'border-warning/35 bg-warning/5 shadow-xs'
            : 'border-border/60 bg-surface-1/50 hover:bg-surface-1/80 hover:border-primary/30 shadow-xs',
      )}
    >
      <div>
        {/* Seat Header */}
        <div className="flex items-start justify-between gap-1.5 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-[11px] font-bold shadow-2xs',
                getPersonaColor(seat.persona),
              )}
            >
              {getPersonaIcon(seat.persona)}
            </span>
            <span className="font-semibold text-xs text-foreground truncate capitalize">
              {seat.persona}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {/* A seat that moved after reading the others is
                the single most interesting row in a
                deliberating panel — and a VETO seat that
                moved has surrendered the panel's safety
                property. */}
            {seat.changed ? (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-[10px] font-bold',
                  seat.veto
                    ? 'border-destructive/30 bg-destructive/15 text-destructive'
                    : 'border-primary/30 bg-primary/15 text-foreground',
                )}
                title={
                  seat.veto
                    ? 'This veto seat changed its vote after seeing the other ballots.'
                    : 'Changed its vote after seeing the other ballots.'
                }
              >
                <RefreshCw className="h-3 w-3" />
                <span>MOVED</span>
              </span>
            ) : null}
            {seat.veto ? (
              <span
                className="inline-flex items-center gap-0.5 rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-[10px] font-bold text-warning"
                title={t('activity:councilDecision.vetoTitle', {
                  defaultValue: 'Holds veto power',
                })}
              >
                <ShieldAlert className="h-3 w-3" />
                <span>VETO</span>
              </span>
            ) : null}
          </div>
        </div>

        {/* Model Badge */}
        {seat.model ? (
          <div className="mb-2.5">
            <span className="inline-block font-mono text-[10px] text-muted-foreground bg-muted/70 px-2 py-0.5 rounded-md max-w-full truncate border border-border/40">
              {seat.model}
            </span>
          </div>
        ) : null}

        {/* Vote Pill */}
        <div className="flex items-center gap-1.5 my-1">
          <span className="text-[11px] text-muted-foreground font-medium">Vote:</span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-xs font-bold capitalize shadow-2xs',
              failed
                ? 'bg-destructive/15 text-destructive border border-destructive/25'
                : seat.veto
                  ? 'bg-warning/15 text-warning border border-warning/25'
                  : 'bg-success/15 text-success border border-success/25',
            )}
          >
            {failed ? (
              <XCircle className="h-3 w-3 shrink-0" />
            ) : (
              <CheckCircle2 className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate">{verdict}</span>
          </span>
        </div>
      </div>

      {/* Seat Footer */}
      <div className="mt-2.5 pt-2 border-t border-border/40 flex items-center justify-between text-[10px] text-muted-foreground">
        <div className="flex items-center gap-2 font-mono">
          {seat.durationMs !== undefined ? <span>{seat.durationMs}ms</span> : null}
          {seat.weight !== undefined && seat.weight !== 1 ? <span>wt: {seat.weight}</span> : null}
        </div>

        {hasRationale ? (
          <button
            type="button"
            onClick={() => toggleRationale(seat.seatId)}
            className="inline-flex items-center gap-0.5 text-muted-foreground hover:underline font-medium cursor-pointer"
          >
            <span>{isExpanded ? 'Hide' : 'Rationale'}</span>
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </div>

      {/* Rationale Drawer */}
      {hasRationale && isExpanded ? (
        <div className="mt-2.5 pt-2 border-t border-border/50 text-xs text-foreground/90 font-normal whitespace-pre-wrap break-words bg-background/80 p-2.5 rounded-lg border border-border/40">
          {seat.rationale ?? seat.stance}
        </div>
      ) : null}
    </div>
  );
}
