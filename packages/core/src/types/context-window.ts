import { expectDefined } from '../utils/expect-defined.js';

export type ContextWindowModeId = 'balanced' | 'frugal' | 'deep';
export type DeprecatedContextWindowModeId = 'archival';
export type ContextWindowModeSelectionId = ContextWindowModeId | DeprecatedContextWindowModeId;

export type ContextWindowAggressiveOn = 'hard' | 'soft' | 'warn';

/**
 * Context-window usage snapshot returned by the host's `onResumeSession`
 * callback when a session is resumed. The TUI reducer seeds
 * `state.leader.ctxTokens` / `state.leader.ctxMaxTokens` from this snapshot
 * so the statusline chip and `/context` panel reflect the rebuilt context
 * immediately, instead of staying at zero until the next ctx.pct event.
 * Single source of truth — do not redeclare as an inline structural type at
 * call sites; import this named type instead so the contract cannot drift.
 */
export interface ContextSnapshot {
  /** Estimated total tokens currently in the context window. */
  tokens: number;
  /** Provider max context in tokens for the active model. */
  maxContext: number;
}

export interface ContextWindowThresholds {
  warn: number;
  soft: number;
  hard: number;
}

export interface ContextWindowMode {
  id: ContextWindowModeId;
  name: string;
  description: string;
  thresholds: ContextWindowThresholds;
  aggressiveOn: ContextWindowAggressiveOn;
  preserveK: number;
  /** Per-block elision baseline used to derive the bounded recent raw tool-I/O window. */
  eliseThreshold: number;
  targetLoad: number;
}

export interface ContextWindowPolicy extends ContextWindowMode {}

export interface ContextWindowConfigLike {
  mode?: ContextWindowModeSelectionId | string | undefined;
  warnThreshold?: number | undefined;
  softThreshold?: number | undefined;
  hardThreshold?: number | undefined;
  preserveK?: number | undefined;
  eliseThreshold?: number | undefined;
  targetLoad?: number | undefined;
}

export const DEFAULT_CONTEXT_WINDOW_MODE_ID: ContextWindowModeId = 'balanced';

/**
 * Windows at or above this size default to the `deep` policy instead of
 * `balanced`: 1M-class windows exist to be filled, and balanced's hard line
 * (0.85) would compact at ~890K of a 1.05M window, stranding the tail. Deep
 * holds compaction until 0.96 and keeps a wider verbatim tail. An explicit
 * `frugal`/`deep` choice, custom modes, and per-field threshold overrides are
 * always respected as-is; only the balanced default is swapped.
 */
export const LARGE_WINDOW_DEEP_MODE_THRESHOLD = 1_000_000;

/**
 * Meta key the mode-switch surfaces (`/context mode`, WebUI `context.mode.switch`,
 * `/context thresholds`) set after the user deliberately picks a policy for the
 * session. Window-change flows re-resolve the default policy against the new
 * window (so a 1M↔200K model switch keeps the policy scaled to the window) but
 * must leave a user-pinned choice alone.
 */
export const CONTEXT_WINDOW_MODE_PINNED_META_KEY = 'contextWindowModePinned';

export const DEPRECATED_CONTEXT_WINDOW_MODE_ALIASES: Readonly<
  Record<DeprecatedContextWindowModeId, ContextWindowModeId>
> = Object.freeze({
  archival: 'balanced',
});

export const CONTEXT_WINDOW_MODES: readonly ContextWindowMode[] = Object.freeze([
  {
    id: 'balanced',
    name: 'Balanced',
    description:
      'Default rolling compaction: recent work stays verbatim, old tool output is trimmed. Windows of 1M+ tokens default to Deep.',
    thresholds: { warn: 0.55, soft: 0.7, hard: 0.85 },
    aggressiveOn: 'soft',
    preserveK: 8,
    eliseThreshold: 1200,
    targetLoad: 0.65,
  },
  {
    id: 'frugal',
    name: 'Frugal',
    description: 'Token-saver mode: compacts early and keeps a tight verbatim tail.',
    thresholds: { warn: 0.4, soft: 0.55, hard: 0.7 },
    aggressiveOn: 'warn',
    preserveK: 4,
    eliseThreshold: 500,
    targetLoad: 0.45,
  },
  {
    id: 'deep',
    name: 'Deep',
    description: 'Long-reasoning mode: delays compaction and keeps more recent turns intact.',
    thresholds: { warn: 0.72, soft: 0.86, hard: 0.96 },
    aggressiveOn: 'hard',
    preserveK: 18,
    eliseThreshold: 5000,
    targetLoad: 0.82,
  },
]);

export function listContextWindowModes(): ContextWindowMode[] {
  return CONTEXT_WINDOW_MODES.map((m) => ({ ...m, thresholds: { ...m.thresholds } }));
}

export function normalizeContextWindowModeId(
  id: string | null | undefined,
): ContextWindowModeId | null {
  if (!id) return null;
  if (isContextWindowModeId(id)) return id;
  return DEPRECATED_CONTEXT_WINDOW_MODE_ALIASES[id as DeprecatedContextWindowModeId] ?? null;
}

export function isDeprecatedContextWindowModeId(id: string): id is DeprecatedContextWindowModeId {
  return Object.hasOwn(DEPRECATED_CONTEXT_WINDOW_MODE_ALIASES, id);
}

export function isContextWindowModeSelectionId(id: string): id is ContextWindowModeSelectionId {
  return isContextWindowModeId(id) || isDeprecatedContextWindowModeId(id);
}

export function getContextWindowMode(id: string | null | undefined): ContextWindowMode | null {
  const normalized = normalizeContextWindowModeId(id);
  if (!normalized) return null;
  const mode = CONTEXT_WINDOW_MODES.find((m) => m.id === normalized);
  return mode ? { ...mode, thresholds: { ...mode.thresholds } } : null;
}

export function isContextWindowModeId(id: string): id is ContextWindowModeId {
  return CONTEXT_WINDOW_MODES.some((m) => m.id === id);
}

export function resolveContextWindowPolicy(
  config: ContextWindowConfigLike = {},
  overrideMode?: string | null | undefined,
  maxContext?: number | undefined,
): ContextWindowPolicy {
  const requested = overrideMode ?? config.mode ?? DEFAULT_CONTEXT_WINDOW_MODE_ID;
  const normalized = normalizeContextWindowModeId(requested) ?? DEFAULT_CONTEXT_WINDOW_MODE_ID;
  // Big-window default: see {@link LARGE_WINDOW_DEEP_MODE_THRESHOLD}. The swap
  // applies only when the mode resolved to the balanced default; a deliberate
  // frugal/deep choice is kept verbatim, and explicit per-field overrides
  // still win on top of whichever base mode was selected.
  const baseId =
    normalized === DEFAULT_CONTEXT_WINDOW_MODE_ID &&
    typeof maxContext === 'number' &&
    maxContext >= LARGE_WINDOW_DEEP_MODE_THRESHOLD
      ? 'deep'
      : normalized;
  const mode = expectDefined(getContextWindowMode(baseId));

  return {
    ...mode,
    thresholds: {
      warn: config.warnThreshold ?? mode.thresholds.warn,
      soft: config.softThreshold ?? mode.thresholds.soft,
      hard: config.hardThreshold ?? mode.thresholds.hard,
    },
    preserveK: config.preserveK ?? mode.preserveK,
    eliseThreshold: config.eliseThreshold ?? mode.eliseThreshold,
    targetLoad: config.targetLoad ?? mode.targetLoad,
  };
}

export function formatContextWindowModeList(activeId?: string | null): string {
  const active = normalizeContextWindowModeId(activeId);
  return CONTEXT_WINDOW_MODES.map((m) => {
    const marker = m.id === active ? '*' : ' ';
    return `${marker} ${m.id.padEnd(9)} ${m.name} - ${m.description}`;
  }).join('\n');
}
