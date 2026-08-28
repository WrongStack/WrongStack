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
  off: 'settings:brain.riskCopy.off',
  low: 'settings:brain.riskCopy.low',
  medium: 'settings:brain.riskCopy.medium',
  high: 'settings:brain.riskCopy.high',
  all: 'settings:brain.riskCopy.all',
};

/**
 * Fallback lens list for servers that publish no `personaCatalog`.
 *
 * Prefer {@link councilPersonaOptions}, which reads the server's registry —
 * this list is only three of the six built-in lenses, and hard-coding it here
 * is what made `security`, `maintainer` and `user-advocate` unselectable.
 */
const PERSONAS = ['executor', 'skeptic', 'auditor'] as const;

/** One entry of the lens picker. */
interface CouncilPersonaOption {
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

export const DECISION_TIMEOUTS: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default15s' },
  { value: '5000', label: '5s' },
  { value: '10000', label: '10s' },
  { value: '20000', label: '20s' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '60s' },
];

export const HUMAN_TIMEOUTS: BrainOption[] = [
  { value: 'off', labelKey: 'settings:brainOpt.waitForever' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '1m' },
  { value: '120000', label: '2m' },
  { value: '300000', label: '5m' },
];

export const FRACTIONS: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.defaultHalf' },
  { value: '0.34', label: '1/3' },
  { value: '0.5', label: '1/2' },
  { value: '0.67', label: '2/3' },
  { value: '0.75', label: '3/4' },
  { value: '1', labelKey: 'settings:brainOpt.all' },
];

/** Effective-valued numbers: the snapshot always carries a resolved number, so
 *  the default is a LABELLED concrete option rather than a `default` sentinel. */
export const LLM_MAX_TOKENS: BrainOption[] = [
  { value: '100', label: '100' },
  { value: '200', labelKey: 'settings:brainOpt.n200Default' },
  { value: '400', label: '400' },
  { value: '800', label: '800' },
  { value: '1600', label: '1600' },
];

export const MIN_CONFIDENCE: BrainOption[] = [
  { value: '0', labelKey: 'settings:brainOpt.offDefault' },
  { value: '0.3', label: '0.3' },
  { value: '0.5', label: '0.5' },
  { value: '0.7', label: '0.7' },
  { value: '0.9', label: '0.9' },
];

export const DECISION_LOG_SIZES: BrainOption[] = [
  { value: '10', label: '10' },
  { value: '20', labelKey: 'settings:brainOpt.n20Default' },
  { value: '50', label: '50' },
  { value: '100', label: '100' },
];

export const CACHE_TTLS: BrainOption[] = [
  { value: '60000', label: '1m' },
  { value: '300000', labelKey: 'settings:brainOpt.m5Default' },
  { value: '900000', label: '15m' },
  { value: '3600000', label: '1h' },
];

export const CACHE_MAX_ENTRIES: BrainOption[] = [
  { value: '50', label: '50' },
  { value: '200', labelKey: 'settings:brainOpt.n200Default' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' },
];

/** Optional-valued knobs: `default` clears the field back to core's default. */
export const COUNCIL_CALL_TIMEOUTS: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default' },
  { value: '10000', label: '10s' },
  { value: '20000', label: '20s' },
  { value: '30000', label: '30s' },
  { value: '60000', label: '60s' },
];

export const COUNCIL_CONCURRENCY: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default' },
  { value: '1', labelKey: 'settings:brainOpt.oneSerial' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '5', label: '5' },
];

/** Per-seat output budget. Default 2000 — reasoning models think from this budget. */
export const VOTER_MAX_TOKENS: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' },
  { value: '2000', label: '2000' },
  { value: '4000', label: '4000' },
  { value: '8000', label: '8000' },
];

export const JUDGE_MAX_TOKENS: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default' },
  { value: '200', label: '200' },
  { value: '400', label: '400' },
  { value: '800', label: '800' },
  { value: '1600', label: '1600' },
];

export const LEDGER_MEMORY_ENTRIES: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default500' },
  { value: '100', label: '100' },
  { value: '500', label: '500' },
  { value: '1000', label: '1000' },
  { value: '5000', label: '5000' },
];

export const INTERVENTION_WINDOWS: BrainOption[] = [
  { value: 'default', labelKey: 'settings:brainOpt.default10m' },
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
/**
 * A select option. Numeric/unit choices ("5s", "800") carry a literal `label`;
 * anything with words carries `labelKey` and is resolved at render time —
 * this module is hook-free, so it cannot call `t()` itself.
 */
interface BrainOption {
  value: string;
  label?: string;
  labelKey?: string;
}

export function withCurrent(options: BrainOption[], current: string): BrainOption[] {
  return options.some((o) => o.value === current)
    ? options
    : [...options, { value: current, label: current }];
}

/** Resolve `labelKey` options against the active catalog for rendering. */
export function localizeOptions(
  options: BrainOption[],
  t: (key: string) => string,
): Array<{ value: string; label: string }> {
  return options.map((o) => ({
    value: o.value,
    label: o.labelKey ? t(o.labelKey) : (o.label ?? o.value),
  }));
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
  pool: { title: 'settings:brain.pickPoolTitle', hint: 'settings:brain.pickPoolHint' },
  voter: {
    title: 'settings:brain.pickVoterTitle',
    hint: 'settings:brain.pickVoterHint',
  },
  judge: { title: 'settings:brain.pickJudgeTitle', hint: 'settings:brain.pickJudgeHint' },
};
