import {
  formatLimitRange,
  LIMIT_BOUNDS,
  limitValueError,
} from '@wrongstack/contracts/types/config/limits';
import { Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type LocalPrefs, useLocalPrefs } from '@/stores/local-prefs';

/**
 * LimitsSection — the browser editor for `Config.limits`.
 *
 * WrongStack ships no invented caps: an empty field means no limit (the model,
 * catalog or provider decides). A number here is the user's own ceiling. This
 * writes the same `limits` block that `/settings limits` writes, and the
 * runtime reads it live, so a change applies on the next use.
 */

type Limits = LocalPrefs['limits'];
type ScalarKey = Exclude<keyof Limits, 'subagentDefaultBudget'>;
type BudgetKey = keyof NonNullable<Limits['subagentDefaultBudget']>;

const SCALAR_FIELDS: Array<{ key: ScalarKey; label: string; hint: string }> = [
  {
    key: 'responseOutputTokens',
    label: 'Response output tokens',
    hint: 'Output tokens per model response. Lowered to the model maximum when that is smaller.',
  },
  {
    key: 'historyMessages',
    label: 'History messages',
    hint: 'Messages kept in the live conversation before the oldest are dropped.',
  },
  {
    key: 'toolOutputPreviewBytes',
    label: 'Tool output preview (bytes)',
    hint: 'Inline preview of large tool output. The full output is still saved to disk.',
  },
  {
    key: 'fetchBytes',
    label: 'Fetched page (bytes)',
    hint: 'Bytes kept from a fetched web page.',
  },
  {
    key: 'projectInstructionsChars',
    label: 'Project instructions (chars)',
    hint: 'Characters of AGENTS.md / CLAUDE.md put into the prompt.',
  },
  {
    key: 'memoryInjectChars',
    label: 'Memory injection (chars)',
    hint: 'Characters of automatically injected SAGE memory.',
  },
  {
    key: 'subagentResultChars',
    label: 'Subagent result (chars)',
    hint: 'Characters of a subagent result shown inline.',
  },
];

const BUDGET_FIELDS: Array<{ key: BudgetKey; label: string; hint: string }> = [
  {
    key: 'maxIterations',
    label: 'Subagent iterations',
    hint: 'Default iterations for a subagent spawned without its own budget.',
  },
  {
    key: 'maxToolCalls',
    label: 'Subagent tool calls',
    hint: 'Default tool calls for a subagent spawned without its own budget.',
  },
  {
    key: 'timeoutMs',
    label: 'Subagent timeout (ms)',
    hint: 'Default timeout for a subagent spawned without its own budget.',
  },
];

/**
 * Empty → undefined (no limit). Otherwise the number, or the reason it is
 * outside the range `LIMIT_BOUNDS` allows (the server checks the same table).
 */
function parseLimit(
  key: ScalarKey | BudgetKey,
  raw: string,
): { value: number | undefined; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: undefined, error: null };
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const error = limitValueError(key, parsed);
  return error ? { value: undefined, error } : { value: parsed, error: null };
}

function LimitInput({
  limitKey,
  label,
  hint,
  value,
  testId,
  onCommit,
}: {
  limitKey: ScalarKey | BudgetKey;
  label: string;
  hint: string;
  value: number | undefined;
  testId: string;
  onCommit: (next: number | undefined) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  useEffect(() => setDraft(value === undefined ? '' : String(value)), [value]);
  const { value: parsed, error } = parseLimit(limitKey, draft);
  const invalid = error !== null;
  const bound = LIMIT_BOUNDS[limitKey];

  // Committed on blur / Enter, not per keystroke: each commit writes config.
  const commit = () => {
    if (invalid || parsed === value) return;
    onCommit(parsed);
  };

  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <input
        type="number"
        min={bound.min}
        max={bound.max}
        step={1}
        inputMode="numeric"
        value={draft}
        placeholder="no limit"
        aria-invalid={invalid}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        className={`w-full rounded-md border bg-background px-2 py-1 text-xs ${
          invalid ? 'border-destructive' : 'border-border'
        }`}
        data-testid={testId}
      />
      <span
        className={`block text-[11px] leading-snug ${invalid ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {invalid
          ? `Must be ${formatLimitRange(limitKey)}, or empty for no limit. ${bound.why}`
          : hint}
      </span>
      <span className="block text-[10px] text-muted-foreground/80" data-testid={`${testId}-range`}>
        {formatLimitRange(limitKey)}
      </span>
    </label>
  );
}

interface LimitsSectionProps {
  /** Writes the pref locally AND pushes it to the server (see SettingsPanel). */
  syncPref: (key: string, value: unknown) => void;
}

export function LimitsSection({ syncPref }: LimitsSectionProps): React.ReactElement {
  const limits: Limits = useLocalPrefs().limits ?? {};
  const budget = limits.subagentDefaultBudget ?? {};

  // Always send the WHOLE block: the server replaces `limits` rather than
  // merging it, and an absent field is how a limit is cleared.
  const setScalar = (key: ScalarKey, next: number | undefined) => {
    const updated: Limits = { ...limits };
    if (next === undefined) delete updated[key];
    else updated[key] = next;
    syncPref('limits', updated);
  };

  const setBudget = (key: BudgetKey, next: number | undefined) => {
    const nextBudget = { ...budget };
    if (next === undefined) delete nextBudget[key];
    else nextBudget[key] = next;
    const updated: Limits = { ...limits };
    if (Object.keys(nextBudget).length > 0) updated.subagentDefaultBudget = nextBudget;
    else delete updated.subagentDefaultBudget;
    syncPref('limits', updated);
  };

  return (
    <div
      className="rounded-xl border border-border/70 bg-card/80 p-5 shadow-sm"
      data-testid="limits-section"
    >
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
          <Gauge className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">Limits</h3>
          <p className="text-xs text-muted-foreground">
            Empty means no limit — the model, catalog or provider decides. Set a number only when
            you want a ceiling of your own. Same as <code>/settings limits</code>.
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {SCALAR_FIELDS.map((field) => (
          <LimitInput
            key={field.key}
            limitKey={field.key}
            label={field.label}
            hint={field.hint}
            value={limits[field.key]}
            testId={`limit-${field.key}`}
            onCommit={(next) => setScalar(field.key, next)}
          />
        ))}
        {BUDGET_FIELDS.map((field) => (
          <LimitInput
            key={field.key}
            limitKey={field.key}
            label={field.label}
            hint={field.hint}
            value={budget[field.key]}
            testId={`limit-subagent-${field.key}`}
            onCommit={(next) => setBudget(field.key, next)}
          />
        ))}
      </div>
    </div>
  );
}
