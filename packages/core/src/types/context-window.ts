import { expectDefined } from '../utils/expect-defined.js';
export type ContextWindowModeId = 'balanced' | 'frugal' | 'deep' | 'archival';

export type ContextWindowAggressiveOn = 'hard' | 'soft' | 'warn';

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
  eliseThreshold: number;
  targetLoad: number;
}

export interface ContextWindowPolicy extends ContextWindowMode {}

export interface ContextWindowConfigLike {
  mode?: ContextWindowModeId | string | undefined;
  warnThreshold?: number | undefined;
  softThreshold?: number | undefined;
  hardThreshold?: number | undefined;
  preserveK?: number | undefined;
  eliseThreshold?: number | undefined;
}

export const DEFAULT_CONTEXT_WINDOW_MODE_ID: ContextWindowModeId = 'frugal';

export const CONTEXT_WINDOW_MODES: readonly ContextWindowMode[] = Object.freeze([
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Default rolling compaction: recent work stays verbatim, old tool output is trimmed.',
    thresholds: { warn: 0.5, soft: 0.65, hard: 0.8 },
    aggressiveOn: 'soft',
    preserveK: 8,
    eliseThreshold: 1000,
    targetLoad: 0.55,
  },
  {
    id: 'frugal',
    name: 'Frugal',
    description: 'Token-saver mode: compacts early and keeps a tighter verbatim tail.',
    thresholds: { warn: 0.45, soft: 0.6, hard: 0.75 },
    aggressiveOn: 'warn',
    preserveK: 6,
    eliseThreshold: 700,
    targetLoad: 0.5,
  },
  {
    id: 'deep',
    name: 'Deep',
    description: 'Long-reasoning mode: delays compaction and keeps more recent turns intact.',
    thresholds: { warn: 0.72, soft: 0.86, hard: 0.96 },
    aggressiveOn: 'hard',
    preserveK: 18,
    eliseThreshold: 5000,
    targetLoad: 0.78,
  },
  {
    id: 'archival',
    name: 'Archival',
    description: 'Decision-preserving mode: compacts steadily while keeping summaries prominent.',
    thresholds: { warn: 0.55, soft: 0.7, hard: 0.84 },
    aggressiveOn: 'soft',
    preserveK: 8,
    eliseThreshold: 1200,
    targetLoad: 0.58,
  },
]);

export function listContextWindowModes(): ContextWindowMode[] {
  return CONTEXT_WINDOW_MODES.map((m) => ({ ...m, thresholds: { ...m.thresholds } }));
}

export function getContextWindowMode(id: string | null | undefined): ContextWindowMode | null {
  if (!id) return null;
  const mode = CONTEXT_WINDOW_MODES.find((m) => m.id === id);
  return mode ? { ...mode, thresholds: { ...mode.thresholds } } : null;
}

export function isContextWindowModeId(id: string): id is ContextWindowModeId {
  return CONTEXT_WINDOW_MODES.some((m) => m.id === id);
}

export function resolveContextWindowPolicy(
  config: ContextWindowConfigLike = {},
  overrideMode?: string | null | undefined,
): ContextWindowPolicy {
  const requested = overrideMode ?? config.mode ?? DEFAULT_CONTEXT_WINDOW_MODE_ID;
  const mode = getContextWindowMode(requested) ?? expectDefined(getContextWindowMode(DEFAULT_CONTEXT_WINDOW_MODE_ID));

  return {
    ...mode,
    thresholds: {
      warn: config.warnThreshold ?? mode.thresholds.warn,
      soft: config.softThreshold ?? mode.thresholds.soft,
      hard: config.hardThreshold ?? mode.thresholds.hard,
    },
    preserveK: config.preserveK ?? mode.preserveK,
    eliseThreshold: config.eliseThreshold ?? mode.eliseThreshold,
  };
}

export function formatContextWindowModeList(activeId?: string | null): string {
  return CONTEXT_WINDOW_MODES.map((m) => {
    const marker = m.id === activeId ? '*' : ' ';
    return `${marker} ${m.id.padEnd(9)} ${m.name} - ${m.description}`;
  }).join('\n');
}
