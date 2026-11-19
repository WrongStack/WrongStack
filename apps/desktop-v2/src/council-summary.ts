import type { CouncilDecisionData } from '@wrongstack/project-surfaces/council/types';

export interface CouncilTallyItem {
  option: string;
  count: number;
  /** Share of the cast vote weight, 0–100, rounded. */
  percent: number;
}

/** A seat's vote as a short label: its option, or what kind of ballot it cast. */
export function seatVote(seat: CouncilDecisionData['seats'][number]): string {
  return seat.optionId ?? (seat.veto ? 'veto' : seat.stance ? 'stance' : 'approved');
}

/**
 * The council's valid votes by option, heaviest first, weighted as the WebUI card weighs them
 * (a seat without a weight counts as 1). Seats that failed or are still voting cast nothing.
 */
export function councilTally(seats: CouncilDecisionData['seats']): CouncilTallyItem[] {
  const counts = new Map<string, { count: number; weight: number }>();
  let total = 0;
  for (const seat of seats) {
    if (seat.status !== 'valid') continue;
    const option = seatVote(seat);
    const weight = typeof seat.weight === 'number' && seat.weight > 0 ? seat.weight : 1;
    const entry = counts.get(option) ?? { count: 0, weight: 0 };
    entry.count += 1;
    entry.weight += weight;
    counts.set(option, entry);
    total += weight;
  }
  return [...counts]
    .map(([option, entry]) => ({
      option,
      count: entry.count,
      percent: total > 0 ? Math.round((entry.weight / total) * 100) : 0,
    }))
    .sort((a, b) => b.percent - a.percent || b.count - a.count);
}

/** A veto resolution, or a valid seat that vetoed with a deny/veto ballot. */
export function councilVetoed(decision: CouncilDecisionData): boolean {
  return (
    decision.resolution === 'veto' ||
    decision.seats.some(
      (seat) =>
        seat.veto &&
        seat.status === 'valid' &&
        (seat.optionId === 'deny' || seat.optionId === 'veto'),
    )
  );
}
