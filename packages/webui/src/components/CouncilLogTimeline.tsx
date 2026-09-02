/**
 * CouncilLogTimeline — live Brain council panel log.
 *
 * Renders the panels assembled by `council-log-store` newest-first: how each
 * seat voted, which model served it, and how the tally resolved. A panel shows
 * up the moment its first seat votes, so a council that is still running reads
 * as in-progress rather than as a stalled request.
 *
 * Two things are surfaced loudly because they otherwise look like ordinary
 * successful verdicts:
 *   - a CORRELATED panel (several seats on the same model) — it agrees with
 *     itself and adds cost without adding independence;
 *   - a seat with veto power, whose single refusal denies the whole proposal.
 */
import { AlertTriangle, Gavel, Scale, ShieldAlert } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { CouncilPanelEntry, CouncilSeatVote } from '@/stores';
import { summarizeCouncilPanel, useCouncilLogStore } from '@/stores';

export function CouncilLogTimeline() {
  const { t } = useAppTranslation();
  const panels = useCouncilLogStore((s) => s.panels);
  const clear = useCouncilLogStore((s) => s.clear);

  if (panels.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Scale className="h-6 w-6 text-muted-foreground/60" />
        <p className="text-xs text-muted-foreground">
          {t('activity:inspector.councilEmpty', {
            defaultValue: 'No council has convened yet in this session.',
          })}
        </p>
        <p className="max-w-[22rem] text-[11px] text-muted-foreground/70">
          {t('activity:inspector.councilEmptyHint', {
            defaultValue:
              'The Brain convenes a multi-model panel for questions at or above its council risk floor. Configure it under Settings › Brain › Council.',
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground">
          {t('activity:inspector.councilCount', {
            defaultValue: '{{count}} panel(s)',
            count: panels.length,
          })}
        </span>
        <button
          type="button"
          onClick={clear}
          className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('activity:inspector.councilClear', { defaultValue: 'Clear' })}
        </button>
      </div>
      <ul className="flex min-h-0 flex-col divide-y divide-border/50">
        {panels.map((panel) => (
          <CouncilPanelRow key={panel.requestId} panel={panel} />
        ))}
      </ul>
    </div>
  );
}

function CouncilPanelRow({ panel }: { panel: CouncilPanelEntry }) {
  const { t } = useAppTranslation();
  const voting = panel.phase === 'voting';
  // `distinctTargetCount < validVoteCount` is the correlated-panel signal the
  // server already computes; recomputing it here from display strings is how
  // surfaces drift, so trust the count.
  const correlated =
    !voting &&
    (panel.validVoteCount ?? 0) > 1 &&
    (panel.distinctTargetCount ?? 0) < (panel.validVoteCount ?? 0);

  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2">
        <Scale
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0',
            voting
              ? 'animate-pulse text-primary'
              : panel.status === 'denied'
                ? 'text-destructive'
                : 'text-muted-foreground',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'truncate text-[11px] font-medium',
                voting ? 'text-primary' : 'text-foreground',
              )}
            >
              {summarizeCouncilPanel(panel)}
            </span>
            {panel.judgeUsed ? (
              <Gavel
                className="h-3 w-3 shrink-0 text-info"
                aria-label={t('activity:councilLogTimeline.judgeUsed')}
              />
            ) : null}
            {correlated ? (
              <AlertTriangle
                className="h-3 w-3 shrink-0 text-warning"
                aria-label={t('activity:councilLogTimeline.panelNotDiverse')}
              />
            ) : null}
          </div>
          {panel.question ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
              {panel.question}
            </p>
          ) : null}
          <ul className="mt-1 flex flex-col gap-0.5">
            {panel.seats.map((seat) => (
              <CouncilSeatRow key={seat.seatId} seat={seat} />
            ))}
          </ul>
          {panel.reason && panel.status !== 'decided' ? (
            <p className="mt-1 text-[10px] text-muted-foreground/80">{panel.reason}</p>
          ) : null}
          {(panel.warnings ?? []).map((warning) => (
            <p key={warning} className="mt-1 flex items-start gap-1 text-[10px] text-warning">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>{warning}</span>
            </p>
          ))}
        </div>
      </div>
    </li>
  );
}

function CouncilSeatRow({ seat }: { seat: CouncilSeatVote }) {
  const { t } = useAppTranslation();
  const failed = seat.status !== 'valid';
  const verdict = failed ? (seat.error ?? seat.status) : (seat.optionId ?? seat.stance ?? 'stance');

  return (
    <li className="flex items-baseline gap-1.5 font-mono text-[10px]">
      <span className={failed ? 'text-destructive' : 'text-muted-foreground/70'}>
        {failed ? '×' : '•'}
      </span>
      <span className="shrink-0 text-muted-foreground">{seat.persona}</span>
      {seat.veto ? (
        <ShieldAlert
          className="h-2.5 w-2.5 shrink-0 text-warning"
          aria-label={t('activity:councilLogTimeline.veto')}
        />
      ) : null}
      <span className="text-muted-foreground/50">→</span>
      <span className={cn('truncate', failed ? 'text-destructive' : 'text-foreground')}>
        {verdict}
      </span>
      {seat.model ? (
        <span className="ml-auto shrink-0 pl-2 text-muted-foreground/60">{seat.model}</span>
      ) : null}
    </li>
  );
}
