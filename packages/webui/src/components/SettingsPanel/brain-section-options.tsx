import { cn } from '@/lib/utils';
import type { BrainConfigWire } from '@/types/brain';

export const RISK_LEVELS = ['off', 'low', 'medium', 'high', 'all'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_COLORS: Record<RiskLevel, string> = {
  off: 'bg-muted-foreground',
  low: 'bg-success',
  medium: 'bg-warning',
  high: 'bg-warning ring-2 ring-warning/25',
  all: 'bg-destructive',
};

export const RISK_COPY: Record<RiskLevel, string> = {
  off: 'Human decides everything',
  low: 'Auto-decide low risk only',
  medium: 'Auto-decide up to medium risk',
  high: 'Auto-decide up to high risk',
  all: 'Auto-decide everything',
};

/**
 * Fallback lens list for servers that publish no `personaCatalog`.
 *
 * Prefer {@link councilPersonaOptions}, which reads the server's registry —
 * this list is only three of the six built-in lenses, and hard-coding it here
 * is what made `security`, `maintainer` and `user-advocate` unselectable.
 */
export const PERSONAS = ['executor', 'skeptic', 'auditor'] as const;

/** One entry of the lens picker. */
export interface CouncilPersonaOption {
  id: string;
  name: string;
  description?: string | undefined;
}

/** Lens options for a config snapshot: server catalog first, fallback second. */
export function councilPersonaOptions(
  catalog: BrainConfigWire['personaCatalog'],
): CouncilPersonaOption[] {
  if (catalog && catalog.length > 0) {
    return catalog.map((persona) => ({
      id: persona.id,
      name: persona.name,
      description: persona.description,
    }));
  }
  return PERSONAS.map((id) => ({ id, name: id }));
}

export const DECISION_TIMEOUTS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default (15s)' },
  { value: '5000', label: '5s' },
  { value: '10000', label: '10s' },
  { value: '20000', label: '20s' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '60s' },
];

export const HUMAN_TIMEOUTS: Array<{ value: string; label: string }> = [
  { value: 'off', label: 'Wait forever' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '1m' },
  { value: '120000', label: '2m' },
  { value: '300000', label: '5m' },
];

export const FRACTIONS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default (0.5)' },
  { value: '0.34', label: '1/3' },
  { value: '0.5', label: '1/2' },
  { value: '0.67', label: '2/3' },
  { value: '0.75', label: '3/4' },
  { value: '1', label: 'All' },
];

/** Effective-valued numbers: the snapshot always carries a resolved number, so
 *  the default is a LABELLED concrete option rather than a `default` sentinel. */
export const LLM_MAX_TOKENS: Array<{ value: string; label: string }> = [
  { value: '100', label: '100' },
  { value: '200', label: '200 (default)' },
  { value: '400', label: '400' },
  { value: '800', label: '800' },
  { value: '1600', label: '1600' },
];

export const MIN_CONFIDENCE: Array<{ value: string; label: string }> = [
  { value: '0', label: 'Off (default)' },
  { value: '0.3', label: '0.3' },
  { value: '0.5', label: '0.5' },
  { value: '0.7', label: '0.7' },
  { value: '0.9', label: '0.9' },
];

export const DECISION_LOG_SIZES: Array<{ value: string; label: string }> = [
  { value: '10', label: '10' },
  { value: '20', label: '20 (default)' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
];

export const CACHE_TTLS: Array<{ value: string; label: string }> = [
  { value: '60000', label: '1m' },
  { value: '300000', label: '5m (default)' },
  { value: '900000', label: '15m' },
  { value: '3600000', label: '1h' },
];

export const CACHE_MAX_ENTRIES: Array<{ value: string; label: string }> = [
  { value: '50', label: '50' },
  { value: '200', label: '200 (default)' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' },
];

/** Optional-valued knobs: `default` clears the field back to core's default. */
export const COUNCIL_CALL_TIMEOUTS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: '10000', label: '10s' },
  { value: '20000', label: '20s' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '60s' },
];

export const COUNCIL_CONCURRENCY: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: '1', label: '1 (serial)' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
];

export const JUDGE_MAX_TOKENS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: '200', label: '200' },
  { value: '400', label: '400' },
  { value: '800', label: '800' },
  { value: '1600', label: '1600' },
];

export const LEDGER_MEMORY_ENTRIES: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default (500)' },
  { value: '100', label: '100' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' },
  { value: '5000', label: '5000' },
];

export const INTERVENTION_WINDOWS: Array<{ value: string; label: string }> = [
  { value: 'default', label: 'Default (10m)' },
  { value: '120000', label: '2m' },
  { value: '600000', label: '10m' },
  { value: '1800000', label: '30m' },
  { value: '3600000', label: '1h' },
];

/**
 * Presets plus the live value when the config holds something off-menu — a
 * hand-edited config must not render as an empty select (which would then
 * write the first preset back on the next change).
 */
export function withCurrent(
  options: Array<{ value: string; label: string }>,
  current: string,
): Array<{ value: string; label: string }> {
  return options.some((o) => o.value === current)
    ? options
    : [...options, { value: current, label: current }];
}

/** `undefined` snapshot field → the `default` sentinel used by the selects. */
export function optionalValue(n: number | undefined): string {
  return n !== undefined ? String(n) : 'default';
}

export function RiskDot({ level }: { level: RiskLevel }) {
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full', RISK_COLORS[level])} />;
}

export function entryLabel(entry: { provider?: string | undefined; model: string }): string {
  return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

/** What the shared ModelPickDialog is currently choosing a model FOR. */
export type PickTarget = 'pool' | 'voter' | 'judge' | null;

export const PICK_TITLES: Record<Exclude<PickTarget, null>, { title: string; hint: string }> = {
  pool: { title: 'Add Brain pool model', hint: 'Ordered decision pool — first is primary.' },
  voter: {
    title: 'Add council voter',
    hint: 'Dialog stays open — add ≥2 voters, then close.',
  },
  judge: { title: 'Pick council judge', hint: 'Tie-breaker that sees every vote.' },
};
