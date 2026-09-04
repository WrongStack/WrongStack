import type React from 'react';
import { Box, Text } from '../../ink.js';
import { sanitizeTerminalText } from '../../terminal-width.js';
import type { HistoryEntry } from './types.js';

/**
 * Per-memory proof costs two rows each, so an 8-hint run would push a 20-row
 * card into the transcript. Show the top few (the list arrives score-sorted)
 * and count the rest; the side panel keeps the full set.
 */
export const MAX_MEMORY_PROOF_ROWS = 4;

/**
 * Render the signed score contributions as `metadata 0.72×0.48 +0.34 │ …`.
 * Uses U+2212 for negatives so a minus is not mistaken for a hyphen inside
 * the labels, which themselves contain `×` and digits.
 */
export function formatScoreTerms(terms: ReadonlyArray<{ label: string; value: number }>): string {
  if (terms.length === 0) return 'no score breakdown (emitted by an older core build)';
  return terms
    .map((term) => {
      const magnitude = Math.abs(term.value).toFixed(2);
      return `${term.label} ${term.value < 0 ? '−' : '+'}${magnitude}`;
    })
    .join(' │ ');
}

export function brainStatusStyle(status: Extract<HistoryEntry, { kind: 'brain' }>['status']): {
  icon: string;
  color: string;
} {
  switch (status) {
    case 'thinking':
      return { icon: '…', color: 'magenta' };
    case 'answered':
      return { icon: '⚖', color: 'cyan' };
    case 'ask_human':
      return { icon: '?', color: 'yellow' };
    case 'denied':
      return { icon: '×', color: 'red' };
  }
}

/**
 * One-line summary of how a council resolved.
 *
 * `distinctTargetCount` is on the headline on purpose: a panel where several
 * seats resolved to the SAME model produces a perfectly normal-looking verdict
 * while adding cost without adding independence, and that is invisible unless
 * the count is shown next to the seat count.
 */
export function councilHeadline(
  council: NonNullable<Extract<HistoryEntry, { kind: 'brain' }>['council']>,
): string {
  const parts = [
    `↳ Council: ${council.resolution}`,
    `${council.validVoteCount}/${council.configuredSeatCount} seats`,
    `${council.distinctTargetCount} distinct target${council.distinctTargetCount === 1 ? '' : 's'}`,
  ];
  // Deliberation multiplies the panel's cost, so the round count belongs on
  // the same line as the seat count — and the change count is what says
  // whether the extra rounds bought anything.
  if (council.rounds !== undefined && council.rounds > 1) {
    const changed = council.deliberationChanges ?? 0;
    parts.push(
      `${council.rounds} rounds` + (changed > 0 ? `, ${changed} changed` : ', none changed'),
    );
  }
  if (council.judgeUsed) {
    // A tie-breaker that already cast one of the tied votes is not an
    // independent opinion; naming it is the only way that shows up.
    parts.push(
      `judge${council.judgeLabel ? ` ${council.judgeLabel}` : ''}` +
        (council.judgeIsVoter ? ' (also a voter)' : ''),
    );
  }
  if (council.durationMs !== undefined) parts.push(`${Math.round(council.durationMs / 100) / 10}s`);
  if (council.totalTokens) parts.push(`${council.totalTokens} tok`);
  return parts.join(' · ');
}

/** Longest seat verdict rendered inline before it is elided. */
const SEAT_VERDICT_MAX = 60;

/** One seat's line under the council headline. */
export function councilSeatLine(
  seat: NonNullable<Extract<HistoryEntry, { kind: 'brain' }>['council']>['seats'][number],
): string {
  // An optionless panel votes with free-text stances. Printing the literal
  // word "stance" said only that the seat had voted, never what it said —
  // which is the entire content of an open-question council.
  const verdict =
    seat.status === 'valid'
      ? (seat.optionId ?? truncateVerdict(seat.stance) ?? 'no stance')
      : (seat.error ?? seat.status);
  const suffix = [seat.model, seat.veto ? 'veto' : undefined].filter(Boolean).join(', ');
  // A seat that moved after reading the others is the single most
  // interesting row in a deliberating panel.
  const marker = seat.status !== 'valid' ? '×' : seat.changed ? '↺' : '•';
  return `   ${marker} ${seat.persona} → ${verdict}${suffix ? ` (${suffix})` : ''}`;
}

function truncateVerdict(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > SEAT_VERDICT_MAX ? `${trimmed.slice(0, SEAT_VERDICT_MAX - 1)}…` : trimmed;
}

/**
 * Colour for a decision tier chip: the deterministic tiers are free and stay
 * dim, the model-backed ones are what a reader is scanning for.
 */
export function brainTierColor(tier: string): string | undefined {
  return tier === 'council' || tier === 'llm' ? 'magenta' : tier === 'human' ? 'yellow' : undefined;
}

export function memoryLifecycleStyle(
  action: Extract<HistoryEntry, { kind: 'memory-lifecycle' }>['action'],
): {
  icon: string;
  color: string;
} {
  if (action === 'entered' || action === 'recovered') return { icon: '↳', color: 'green' };
  if (action === 'exited') return { icon: '↲', color: 'red' };
  if (action === 'related') return { icon: '◇', color: 'magenta' };
  return { icon: '•', color: 'cyan' };
}

export function brainRiskColor(risk: Extract<HistoryEntry, { kind: 'brain' }>['risk']): string {
  switch (risk) {
    case 'low':
      return 'green';
    case 'medium':
      return 'cyan';
    case 'high':
      return 'yellow';
    case 'critical':
      return 'red';
  }
}

/**
 * Full-bordered notice card for `warn`/`error` entries. A rounded box with an
 * icon + label header in the accent color and the message body below, wrapped
 * to the terminal width and split across lines so multi-line diagnostics stay
 * readable instead of overflowing a single-line strip. Slash-command output
 * is normalized before it reaches Ink so cursor/control sequences can never
 * paint outside the notice card's measured geometry.
 */
export function NoticeCard({
  icon,
  label,
  color,
  text,
  termWidth,
}: {
  icon: string;
  label: string;
  color: string;
  text: string;
  termWidth: number;
}): React.ReactElement {
  // 2 border columns + 2 paddingX columns of chrome.
  const contentWidth = Math.max(1, termWidth - 4);
  const lines = sanitizeTerminalText(text).split('\n');
  return (
    <Box
      flexDirection="column"
      marginX={0}
      marginY={1}
      borderStyle="round"
      borderColor={color}
      paddingX={1}
    >
      <Text bold color={color}>{`${icon} ${label}`}</Text>
      <Box flexDirection="column" width={contentWidth}>
        {lines.map((line, i) => (
          <Text key={i} color={color}>
            {line.length > 0 ? line : ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
