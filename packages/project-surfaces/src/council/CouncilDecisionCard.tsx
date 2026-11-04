import {
  AlertTriangle,
  Award,
  Check,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  Cpu,
  Gavel,
  HelpCircle,
  Layers,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { CouncilSeatCard } from './CouncilSeatCard';
import { OPTION_THEME_CLASSES, parseCouncilMarkdown } from './council-decision-format';
import type { CouncilDecisionData } from './types';

export { parseCouncilMarkdown } from './council-decision-format';

interface CouncilDecisionCardProps {
  /** The structured decision, or null to fall back to the markdown a replay left. */
  decision?: CouncilDecisionData | null | undefined;
  /** The chat message's text, parsed when no structured decision is attached. */
  content?: string | undefined;
}

export const CouncilDecisionCard = memo(function CouncilDecisionCard({
  decision,
  content,
}: CouncilDecisionCardProps) {
  const { t } = useAppTranslation();
  const [expandedRationales, setExpandedRationales] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  const councilData = useMemo<CouncilDecisionData | null>(() => {
    if (decision) return decision;
    return content ? parseCouncilMarkdown(content) : null;
  }, [decision, content]);

  if (!councilData) return null;

  const {
    requestId,
    phase = 'resolved',
    status = 'decided',
    resolution = 'decided',
    optionId,
    question,
    reason,
    configuredSeatCount,
    validVoteCount,
    distinctTargetCount,
    judgeUsed,
    judgeModel,
    judgeIsVoter,
    judgeRationale,
    totalTokens,
    durationMs,
    rounds,
    deliberationChanges,
    warnings = [],
    seats = [],
  } = councilData;

  const totalSeats = configuredSeatCount ?? seats.length;
  const validSeats = validVoteCount ?? seats.filter((s) => s.status === 'valid').length;
  const isVoting = phase === 'voting';
  const isVetoed =
    resolution === 'veto' ||
    seats.some(
      (s) => s.veto && s.status === 'valid' && (s.optionId === 'deny' || s.optionId === 'veto'),
    );
  const isDenied = status === 'denied' || isVetoed;
  const isCorrelated = !isVoting && validSeats > 1 && (distinctTargetCount ?? 0) < validSeats;
  const deliberated = (rounds ?? 1) > 1;
  const movedSeats = deliberationChanges ?? seats.filter((seat) => seat.changed).length;
  /**
   * A majority of the panel moving in one round is the signature of
   * conformity, not of one decisive argument — and the unanimous verdict it
   * produces looks BETTER than the split it came from, so it needs saying.
   */
  const converged = deliberated && validSeats > 0 && movedSeats > validSeats / 2;

  const voteDistribution = useMemo(() => {
    const counts: Record<string, { count: number; weight: number; voters: string[] }> = {};
    let totalWeight = 0;

    for (const seat of seats) {
      if (seat.status !== 'valid') continue;
      const key = seat.optionId ?? (seat.veto ? 'Veto' : seat.stance ? 'Stance' : 'Approved');
      const w = seat.weight ?? 1.0;
      if (!counts[key]) {
        counts[key] = { count: 0, weight: 0, voters: [] };
      }
      counts[key].count += 1;
      counts[key].weight += w;
      counts[key].voters.push(seat.persona);
      totalWeight += w;
    }

    const items = Object.entries(counts).map(([name, stat], idx) => {
      const color = OPTION_THEME_CLASSES[idx % OPTION_THEME_CLASSES.length]!;
      const pct = totalWeight > 0 ? Math.round((stat.weight / totalWeight) * 100) : 0;
      return {
        name,
        count: stat.count,
        weight: stat.weight,
        pct,
        voters: stat.voters,
        color,
      };
    });

    items.sort((a, b) => b.pct - a.pct);
    return { items, totalWeight };
  }, [seats]);

  const distinctModelsList = useMemo(() => {
    const models = new Set<string>();
    for (const s of seats) {
      if (s.model) models.add(s.model);
    }
    return Array.from(models);
  }, [seats]);

  const toggleRationale = (seatId: string) => {
    setExpandedRationales((prev) => ({ ...prev, [seatId]: !prev[seatId] }));
  };

  const toggleAllRationales = () => {
    const anyClosed = seats.some((s) => !expandedRationales[s.seatId]);
    const next: Record<string, boolean> = {};
    for (const s of seats) next[s.seatId] = anyClosed;
    setExpandedRationales(next);
  };

  const handleCopySummary = async () => {
    const summaryLines = [
      `Council Verdict: ${resolution} (${optionId ?? status})`,
      question ? `Proposal: ${question}` : '',
      `Seats: ${validSeats}/${totalSeats} valid (${distinctTargetCount ?? distinctModelsList.length} models)`,
      judgeUsed ? `Judge Used (${judgeModel ?? 'Judicial Arbiter'}): ${judgeRationale ?? ''}` : '',
      ...seats.map(
        (s) =>
          `• ${s.persona} (${s.model ?? 'model'}): ${s.optionId ?? s.status}${s.veto ? ' [VETO]' : ''}`,
      ),
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await navigator.clipboard.writeText(summaryLines);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard error in headless
    }
  };

  return (
    <div
      className="mx-auto max-w-6xl w-full px-3 sm:px-5 lg:px-6 py-2"
      data-council-decision-card={requestId ?? 'council'}
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border shadow-sm transition-all duration-200',
          'bg-gradient-to-br from-background via-surface-1/50 to-surface-2/70 backdrop-blur-sm',
          isDenied
            ? 'border-destructive/35 shadow-destructive/5'
            : isVetoed
              ? 'border-warning/40 shadow-warning/5'
              : judgeUsed
                ? 'border-info/35 shadow-info/5'
                : 'border-success/35 shadow-success/5',
        )}
      >
        {/* Top Accent Line */}
        <div
          className={cn(
            'h-1 w-full',
            isDenied
              ? 'bg-gradient-to-r from-destructive via-warning to-destructive'
              : isVetoed
                ? 'bg-gradient-to-r from-warning via-brand-orange to-destructive'
                : judgeUsed
                  ? 'bg-gradient-to-r from-info via-primary to-warning'
                  : 'bg-gradient-to-r from-success via-info to-primary',
          )}
        />

        <div className="p-4 sm:p-5 space-y-4">
          {/* Header Row */}
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-xs transition-transform duration-200 hover:scale-105',
                  isDenied
                    ? 'border-destructive/30 bg-destructive/10 text-destructive'
                    : isVetoed
                      ? 'border-warning/30 bg-warning/10 text-warning'
                      : judgeUsed
                        ? 'border-info/30 bg-info/10 text-info'
                        : 'border-success/30 bg-success/10 text-success',
                )}
              >
                {judgeUsed ? (
                  <Gavel className="h-5 w-5" />
                ) : isVetoed ? (
                  <ShieldAlert className="h-5 w-5" />
                ) : (
                  <Scale className="h-5 w-5" />
                )}
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-1.5">
                    <span>
                      {t('activity:councilDecision.title', { defaultValue: 'Council Consensus' })}
                    </span>
                    {isVoting ? (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-primary animate-pulse">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        {t('activity:councilDecision.voting', {
                          defaultValue: 'Voting in flight…',
                        })}
                      </span>
                    ) : null}
                  </h3>
                  {requestId ? (
                    <span className="font-mono text-[10px] text-muted-foreground/70 bg-muted/60 px-1.5 py-0.5 rounded">
                      {requestId}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('activity:councilDecision.subtitle', {
                    defaultValue: 'Multi-LLM independent deliberative decision panel',
                  })}
                </p>
              </div>
            </div>

            {/* Badges & Copy Action */}
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={handleCopySummary}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-1/60 hover:bg-surface-1 px-2.5 py-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title={t('activity:councilDecision.copySummary', {
                  defaultValue: 'Copy Council Summary',
                })}
              >
                {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                <span className="text-[11px]">{copied ? 'Copied' : 'Copy'}</span>
              </button>

              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold border shadow-2xs',
                  isDenied
                    ? 'border-destructive/30 bg-destructive/15 text-destructive'
                    : isVetoed
                      ? 'border-warning/30 bg-warning/15 text-warning'
                      : judgeUsed
                        ? 'border-info/30 bg-info/15 text-info'
                        : 'border-success/30 bg-success/15 text-success',
                )}
              >
                {isDenied ? (
                  <XCircle className="h-3.5 w-3.5" />
                ) : isVetoed ? (
                  <ShieldAlert className="h-3.5 w-3.5" />
                ) : judgeUsed ? (
                  <Gavel className="h-3.5 w-3.5" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                <span className="capitalize font-bold">{resolution ?? status ?? 'Resolved'}</span>
                {optionId ? <span className="ml-0.5 opacity-90">({optionId})</span> : null}
              </span>

              {judgeUsed ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-info/30 bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
                  <Gavel className="h-3 w-3" />
                  <span>
                    {t('activity:councilDecision.judgeUsed', { defaultValue: 'Judge Broke Tie' })}
                  </span>
                </span>
              ) : null}

              {converged ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/15 px-2 py-0.5 text-[10px] font-bold text-destructive"
                  title={t('activity:councilDecision.convergedTitle', {
                    defaultValue:
                      'A majority of the panel changed position after seeing the other ballots — this reads as convergence rather than independent revision.',
                  })}
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>
                    {t('activity:councilDecision.converged', { defaultValue: 'Converged Panel' })}
                  </span>
                </span>
              ) : null}
              {judgeIsVoter ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/15 px-2 py-0.5 text-[10px] font-bold text-destructive"
                  title={t('activity:councilDecision.judgeIsVoterTitle', {
                    defaultValue:
                      'The tie-breaker had already cast one of the votes it is breaking, so its verdict restates its own position with the deciding weight.',
                  })}
                >
                  <ShieldAlert className="h-3 w-3" />
                  <span>
                    {t('activity:councilDecision.judgeIsVoter', {
                      defaultValue: 'Judge Also Voted',
                    })}
                  </span>
                </span>
              ) : null}
              {isCorrelated ? (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
                  title={t('activity:councilDecision.correlatedTitle', {
                    defaultValue: 'All seats were served by the same underlying model',
                  })}
                >
                  <AlertTriangle className="h-3 w-3 text-warning" />
                  <span>
                    {t('activity:councilDecision.correlated', { defaultValue: 'Correlated Panel' })}
                  </span>
                </span>
              ) : null}
            </div>
          </div>

          {/* Proposal Box */}
          {question ? (
            <div className="rounded-xl border border-border/70 bg-surface-1/60 p-3.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-muted-foreground mb-1.5">
                <HelpCircle className="h-3.5 w-3.5 text-primary" />
                <span>
                  {t('activity:councilDecision.evaluatedQuestion', {
                    defaultValue: 'Deliberated Proposal / Question:',
                  })}
                </span>
              </div>
              <p className="text-foreground font-medium whitespace-pre-wrap leading-relaxed">
                {question}
              </p>
            </div>
          ) : null}

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-surface-1/40 p-2.5 transition-colors hover:bg-surface-1/70">
              <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <Users className="h-4 w-4 shrink-0" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                  Seats Quorum
                </div>
                <div className="font-semibold text-foreground truncate">
                  {validSeats}/{totalSeats} Valid
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-surface-1/40 p-2.5 transition-colors hover:bg-surface-1/70">
              <div className="p-1.5 rounded-lg bg-info/10 text-info">
                <Cpu className="h-4 w-4 shrink-0" />
              </div>
              <div className="min-w-0">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                  Diversity
                </div>
                <div className="font-semibold text-foreground truncate flex items-center gap-1">
                  <span>{distinctTargetCount ?? distinctModelsList.length} Models</span>
                  {!isCorrelated && (distinctTargetCount ?? 0) > 1 ? (
                    <Sparkles className="h-3 w-3 text-success shrink-0" />
                  ) : null}
                </div>
              </div>
            </div>

            {deliberated ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-surface-1/40 p-2.5 transition-colors hover:bg-surface-1/70">
                <div
                  className={cn(
                    'p-1.5 rounded-lg',
                    converged ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary',
                  )}
                >
                  <RefreshCw className="h-4 w-4 shrink-0" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                    Deliberation
                  </div>
                  <div className="font-semibold text-foreground truncate">
                    {rounds} rounds ·{' '}
                    {/* 0 is the honest signal that the extra rounds bought
                        cost and nothing else. */}
                    {movedSeats === 0 ? 'none moved' : `${movedSeats} moved`}
                  </div>
                </div>
              </div>
            ) : null}

            {durationMs !== undefined ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-surface-1/40 p-2.5 transition-colors hover:bg-surface-1/70">
                <div className="p-1.5 rounded-lg bg-warning/10 text-warning">
                  <Clock className="h-4 w-4 shrink-0" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                    Latency
                  </div>
                  <div className="font-semibold text-foreground truncate">
                    {(durationMs / 1000).toFixed(1)}s
                  </div>
                </div>
              </div>
            ) : null}

            {totalTokens !== undefined ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-border/50 bg-surface-1/40 p-2.5 transition-colors hover:bg-surface-1/70">
                <div className="p-1.5 rounded-lg bg-success/10 text-success">
                  <Coins className="h-4 w-4 shrink-0" />
                </div>
                <div className="min-w-0">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
                    Tokens
                  </div>
                  <div className="font-semibold text-foreground truncate font-mono">
                    {totalTokens.toLocaleString()} tok
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Multi-Model Visual Vote Breakdown Chart */}
          {voteDistribution.items.length > 0 ? (
            <div className="space-y-2.5 rounded-xl border border-border/60 bg-surface-1/40 p-3.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Layers className="h-3.5 w-3.5 text-primary" />
                  <span>
                    {t('activity:councilDecision.votingDistribution', {
                      defaultValue: 'Consensus Voting Distribution',
                    })}
                  </span>
                </span>
                <span className="text-[11px] text-muted-foreground font-mono">
                  {t('activity:councilDecision.quorumWeight', {
                    defaultValue: 'Total Weight: {{weight}}',
                    weight: voteDistribution.totalWeight.toFixed(1),
                  })}
                </span>
              </div>

              {/* Stacked Percentage Bar Chart */}
              <div className="h-3.5 w-full rounded-full bg-muted/60 overflow-hidden flex shadow-inner p-0.5 border border-border/40">
                {voteDistribution.items.map((item) => (
                  <div
                    key={item.name}
                    style={{ width: `${Math.max(item.pct, 4)}%` }}
                    className={cn(
                      'h-full transition-all duration-500 relative first:rounded-l-full last:rounded-r-full',
                      item.color.bg,
                    )}
                    title={`${item.name}: ${item.count} votes (${item.pct}%)`}
                  />
                ))}
              </div>

              {/* Legend & Distribution Badges */}
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {voteDistribution.items.map((item) => (
                  <div
                    key={item.name}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs border font-medium transition-transform duration-150 hover:scale-102',
                      item.color.badge,
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full', item.color.bg)} />
                    <span className="font-semibold">{item.name}</span>
                    <span className="opacity-80 font-mono text-[11px]">
                      {item.count} {item.count === 1 ? 'vote' : 'votes'} ({item.pct}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Seats & Voters Visual Matrix */}
          {seats.length > 0 ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground px-0.5">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  <Award className="h-3.5 w-3.5 text-primary" />
                  <span>
                    {t('activity:councilDecision.voterSeats', {
                      defaultValue: 'Deliberating Model Seats',
                    })}
                  </span>
                </span>
                <div className="flex items-center gap-3">
                  <span className="text-[11px]">
                    {seats.length} {seats.length === 1 ? 'seat' : 'seats'}
                  </span>
                  {seats.some((s) => s.rationale || s.stance) ? (
                    <button
                      type="button"
                      onClick={toggleAllRationales}
                      className="text-[11px] text-muted-foreground hover:underline font-medium cursor-pointer"
                    >
                      Toggle All Details
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {seats.map((seat, sIdx) => (
                  <CouncilSeatCard
                    key={seat.seatId || `seat-${sIdx}`}
                    seat={seat}
                    isExpanded={expandedRationales[seat.seatId] ?? false}
                    toggleRationale={toggleRationale}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {/* Judge Tie-Breaker Section */}
          {judgeUsed ? (
            <div className="rounded-xl border border-info/30 bg-info/[0.06] p-3.5 text-xs space-y-1.5 shadow-xs">
              <div className="flex items-center gap-1.5 font-semibold text-info">
                <Gavel className="h-4 w-4 shrink-0" />
                <span>
                  {t('activity:councilDecision.judgeResolutionTitle', {
                    defaultValue: 'Judicial Arbiter Tie-Breaker',
                  })}
                </span>
                {judgeModel ? (
                  <span className="font-mono text-[10px] bg-info/15 text-info px-2 py-0.5 rounded border border-info/20">
                    {judgeModel}
                  </span>
                ) : null}
              </div>
              <p className="text-foreground/90 leading-relaxed">
                {judgeRationale ||
                  t('activity:councilDecision.judgeResolutionDesc', {
                    defaultValue:
                      'The voting seats were evenly divided or deadlocked; the independent judge reviewed all voter stances and rendered the binding final verdict.',
                  })}
              </p>
            </div>
          ) : null}

          {/* Warnings & Diagnostics */}
          {warnings.length > 0 ? (
            <div className="space-y-1 rounded-xl border border-warning/30 bg-warning/[0.06] p-3.5 text-xs text-warning shadow-xs">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                <span>
                  {t('activity:councilDecision.warningsTitle', {
                    defaultValue: 'Council Diagnostics & Notices',
                  })}
                </span>
              </div>
              {warnings.map((w, wIdx) => (
                <p key={wIdx} className="text-[11px] leading-normal pl-5">
                  • {w}
                </p>
              ))}
            </div>
          ) : null}

          {/* Resolution Statement */}
          {reason && status !== 'decided' ? (
            <div className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground flex items-start gap-2 border border-border/50">
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary mt-0.5" />
              <div>
                <span className="font-semibold text-foreground">Verdict Context: </span>
                <span>{reason}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
