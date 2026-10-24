/**
 * User-chosen limits. WrongStack ships NO invented ceilings: every field here
 * is optional, and an unset field means "no limit" — the model, the catalog or
 * the provider decides (see the `no invented limits` rule). A field is set only
 * when the user wants to trade completeness for cost, speed or a small window.
 *
 * User config only: a repo-committed config is denied this section, since a
 * tiny value (`historyMessages: 1`, `responseOutputTokens: 10`) would silently
 * cripple every session in that checkout.
 */
export interface LimitsConfig {
  /**
   * Output-token cap per model response (main agent and helper calls alike).
   * Unset = the model's own ceiling from the catalog. An explicit per-call
   * value (a Brain/Council budget the user set) still wins for that call.
   */
  responseOutputTokens?: number | undefined;
  /**
   * Size of the inline preview a large tool output shows the model before the
   * pointer to its full spool file. Never a loss: the whole output stays on
   * disk. Unset = the built-in preview size.
   */
  toolOutputPreviewBytes?: number | undefined;
  /** Bytes of a fetched web page returned to the model. Unset = the whole page. */
  fetchBytes?: number | undefined;
  /** Characters of AGENTS.md / CLAUDE.md injected per file. Unset = the whole file. */
  projectInstructionsChars?: number | undefined;
  /**
   * Characters of automatically injected SAGE memory per turn or tool call.
   * Unset = the built-in injection budgets.
   */
  memoryInjectChars?: number | undefined;
  /**
   * Messages kept in the live conversation; older ones are evicted. Unset =
   * no count cap (history is bounded by the model's window and compaction).
   */
  historyMessages?: number | undefined;
  /**
   * Characters of a subagent's result delivered inline to the leader (the full
   * result always stays reachable via `roll_up`). Unset = the built-in excerpt.
   */
  subagentResultChars?: number | undefined;
  /**
   * Default budget for a subagent spawned without one. Unset fields fall back
   * to the roster's light tier (which auto-extends while the agent progresses).
   */
  subagentDefaultBudget?:
    | {
        maxIterations?: number | undefined;
        maxToolCalls?: number | undefined;
        timeoutMs?: number | undefined;
      }
    | undefined;
}

/** Every `LimitsConfig` scalar key, in display order (settings surfaces). */
export const LIMITS_SCALAR_KEYS = [
  'responseOutputTokens',
  'toolOutputPreviewBytes',
  'fetchBytes',
  'projectInstructionsChars',
  'memoryInjectChars',
  'historyMessages',
  'subagentResultChars',
] as const satisfies ReadonlyArray<keyof LimitsConfig>;

export type LimitsScalarKey = (typeof LIMITS_SCALAR_KEYS)[number];

/** `subagentDefaultBudget` sub-keys, in display order. */
export const LIMITS_BUDGET_KEYS = ['maxIterations', 'maxToolCalls', 'timeoutMs'] as const;

export type LimitsBudgetKey = (typeof LIMITS_BUDGET_KEYS)[number];

/**
 * Largest body a tool holds in memory (fetch, read_url_content, parsed command
 * output). It is a RAM guard, not a context budget, and so the real upper
 * bound for the byte limits below: nothing larger is ever held to cut.
 */
export const TOOL_MEMORY_GUARD_BYTES = 64 * 1024 * 1024;

/** Node's `setTimeout` overflows above this and fires immediately. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The range a user-set limit may take. These bound what the user types; they
 * never apply to an unset field (unset = no limit). A `min` is the point below
 * which the setting breaks the agent rather than trimming it; a `max` exists
 * only where something real sits above it (the RAM guard, the timer overflow),
 * otherwise the model, the catalog or the provider is the upper bound.
 */
export interface LimitBound {
  min: number;
  max?: number | undefined;
  unit: string;
  /** What the upper bound is when `max` is absent. */
  maxNote?: string | undefined;
  /** Why the range is what it is — shown next to the input. */
  why: string;
}

export const LIMIT_BOUNDS: Readonly<Record<LimitsScalarKey | LimitsBudgetKey, LimitBound>> = {
  responseOutputTokens: {
    min: 1024,
    unit: 'tokens',
    maxNote: "the model's own output ceiling",
    why: 'Below this a reply that calls a tool or reasons first comes back cut off or empty.',
  },
  toolOutputPreviewBytes: {
    min: 1024,
    max: TOOL_MEMORY_GUARD_BYTES,
    unit: 'bytes',
    why: 'The preview is a head and a tail; below 1 KiB neither is readable. Tools hold at most 64 MiB.',
  },
  fetchBytes: {
    min: 1024,
    max: TOOL_MEMORY_GUARD_BYTES,
    unit: 'bytes',
    why: 'Below 1 KiB a page is only its markup header. Tools hold at most 64 MiB.',
  },
  projectInstructionsChars: {
    min: 1000,
    unit: 'chars',
    maxNote: 'the whole file',
    why: 'Below this only the heading of an instructions file survives.',
  },
  memoryInjectChars: {
    min: 500,
    unit: 'chars',
    maxNote: 'the whole memory',
    why: 'Below this not even one memory entry fits.',
  },
  historyMessages: {
    min: 20,
    unit: 'messages',
    maxNote: "the model's window (compaction)",
    why: "Fewer would evict the running turn's own tool calls and results.",
  },
  subagentResultChars: {
    min: 500,
    unit: 'chars',
    maxNote: 'the whole result',
    why: "Below this a subagent's summary line does not fit.",
  },
  maxIterations: {
    min: 2,
    unit: 'iterations',
    maxNote: 'none',
    why: 'A subagent needs one iteration to call a tool and one to report.',
  },
  maxToolCalls: {
    min: 1,
    unit: 'calls',
    maxNote: 'none',
    why: 'A subagent with no tool calls cannot act.',
  },
  timeoutMs: {
    min: 10_000,
    max: MAX_TIMER_MS,
    unit: 'ms',
    why: "Below 10 s a subagent times out before its first model reply; above ~24.8 days Node's timer overflows and fires at once.",
  },
};

/** "1,024 – 67,108,864 bytes" / "≥ 1,024 tokens (max: …)". */
export function formatLimitRange(key: LimitsScalarKey | LimitsBudgetKey): string {
  const bound = LIMIT_BOUNDS[key];
  const n = (value: number) => value.toLocaleString('en-US');
  return bound.max !== undefined
    ? `${n(bound.min)} – ${n(bound.max)} ${bound.unit}`
    : `≥ ${n(bound.min)} ${bound.unit}${bound.maxNote ? ` (max: ${bound.maxNote})` : ''}`;
}

/**
 * Why `value` is not a valid setting for `key`, or null when it is. `undefined`
 * (clearing the limit) is always valid.
 */
export function limitValueError(
  key: LimitsScalarKey | LimitsBudgetKey,
  value: unknown,
): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return 'must be a whole number';
  }
  const bound = LIMIT_BOUNDS[key];
  if (value < bound.min || (bound.max !== undefined && value > bound.max)) {
    return `must be ${formatLimitRange(key)}`;
  }
  return null;
}

/** A set limit pulled into its range; undefined when unset or not a number. */
export function clampLimit(
  key: LimitsScalarKey | LimitsBudgetKey,
  value: unknown,
): number | undefined {
  const n = positiveLimit(value);
  if (n === undefined) return undefined;
  const bound = LIMIT_BOUNDS[key];
  return Math.min(Math.max(n, bound.min), bound.max ?? Number.MAX_SAFE_INTEGER);
}

/**
 * `limits` with every set field pulled into its range. A hand-edited
 * config.json is not validated on write, so the range is enforced on read.
 */
export function clampLimits(limits: LimitsConfig | undefined): LimitsConfig {
  if (!limits || typeof limits !== 'object') return {};
  const out: LimitsConfig = {};
  for (const key of LIMITS_SCALAR_KEYS) {
    const value = clampLimit(key, limits[key]);
    if (value !== undefined) out[key] = value;
  }
  const budget = limits.subagentDefaultBudget;
  if (budget && typeof budget === 'object') {
    const next: NonNullable<LimitsConfig['subagentDefaultBudget']> = {};
    for (const key of LIMITS_BUDGET_KEYS) {
      const value = clampLimit(key, budget[key]);
      if (value !== undefined) next[key] = value;
    }
    if (Object.keys(next).length > 0) out.subagentDefaultBudget = next;
  }
  return out;
}

let activeLimitsSource: (() => LimitsConfig | undefined) | undefined;

/**
 * Install the live limits reader. Hosts (CLI, WebUI) pass a getter over their
 * config store so a settings change takes effect on the next use, with no
 * restart. Returns an uninstall function.
 */
export function installLimitsSource(source: () => LimitsConfig | undefined): () => void {
  activeLimitsSource = source;
  return () => {
    if (activeLimitsSource === source) activeLimitsSource = undefined;
  };
}

/**
 * The user's current limits, each set field pulled into {@link LIMIT_BOUNDS}.
 * Never throws; `{}` (no limits) when no host installed a source or the
 * source fails.
 */
export function activeLimits(): LimitsConfig {
  try {
    return clampLimits(activeLimitsSource?.());
  } catch {
    return {};
  }
}

/** A positive integer limit, or undefined when unset/invalid (= no limit). */
export function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
