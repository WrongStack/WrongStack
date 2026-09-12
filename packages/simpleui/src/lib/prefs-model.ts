/** Settings model — the small slice of server prefs SimpleUI exposes.
 *
 * The server is the source of truth: `prefs.get` seeds us, `prefs.update`
 * writes through to `agent.ctx.meta` + config.json, and the server answers
 * with a `prefs.updated` broadcast that every tab re-reads. We deliberately
 * project only the handful of keys SimpleUI surfaces — the snapshot carries
 * the full `PREF_KEYS` set and unknown keys must survive untouched.
 */

export type AutonomyMode = 'off' | 'suggest' | 'auto';

/** One subagent model lane (see `coordination/session-subagent-models`). */
export interface SubagentLane {
  provider?: string;
  model?: string;
  tier?: string;
  fallbackProfile?: string;
  label?: string;
}

/**
 * Session-scoped subagent model plan. Each live subagent holds one lane, so a
 * fan-out runs on as many different models as there are pinned lanes; `lock`
 * decides whether a lane outranks the model the leader asked for.
 */
export interface SubagentModelPlan {
  enabled: boolean;
  lock: boolean;
  /** Run every plain subagent on the session's own model; outranks the lanes. */
  followSessionModel: boolean;
  slots: SubagentLane[];
}

/** Hard ceiling mirrored from `MAX_SUBAGENT_SLOTS` in core. */
export const MAX_SUBAGENT_LANES = 16;

export interface SimplePrefs {
  subagentsAllowed: boolean;
  subagentsPolicyLocked: boolean;
  autonomy: AutonomyMode;
  yolo: boolean;
  enhanceEnabled: boolean;
  /** Pre-refine grace countdown (seconds). 0 = skip. */
  preRefineSeconds: number;
  showModelReasoning: boolean;
  showTimestamps: boolean;
  chime: boolean;
  confirmExit: boolean;
  refinerProvider: string;
  refinerModel: string;
  refinerFallbackProfile: string;
  fallbackProfiles: Record<string, string[]>;
  subagentModelPlan: SubagentModelPlan;
}

export const DEFAULT_PREFS: SimplePrefs = {
  subagentsAllowed: true,
  subagentsPolicyLocked: false,
  autonomy: 'off',
  yolo: false,
  enhanceEnabled: false,
  preRefineSeconds: 3,
  showModelReasoning: true,
  showTimestamps: false,
  chime: false,
  confirmExit: false,
  refinerProvider: '',
  refinerModel: '',
  refinerFallbackProfile: '',
  fallbackProfiles: {},
  subagentModelPlan: { enabled: true, lock: true, followSessionModel: false, slots: [] },
};

export const AUTONOMY_MODES: readonly AutonomyMode[] = ['off', 'suggest', 'auto'];

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Project a `prefs.updated` snapshot onto the keys SimpleUI renders.
 *  Anything absent or malformed keeps the previous value so a partial
 *  snapshot can never blank the panel. */
export function parsePrefs(payload: unknown, previous: SimplePrefs = DEFAULT_PREFS): SimplePrefs {
  if (!payload || typeof payload !== 'object') return previous;
  const raw = payload as Record<string, unknown>;
  const autonomy = raw['autonomy'];
  return {
    subagentsAllowed: bool(raw['subagentsAllowed'], previous.subagentsAllowed),
    subagentsPolicyLocked: bool(raw['subagentsPolicyLocked'], previous.subagentsPolicyLocked),
    autonomy: AUTONOMY_MODES.includes(autonomy as AutonomyMode)
      ? (autonomy as AutonomyMode)
      : // `eternal` and friends are live-only modes the server may report;
        // they have no SimpleUI control, so hold the previous value rather
        // than misrepresenting the running mode as `off`.
        previous.autonomy,
    yolo: bool(raw['yolo'], previous.yolo),
    enhanceEnabled: bool(raw['enhanceEnabled'], previous.enhanceEnabled),
    preRefineSeconds:
      typeof raw['preRefineSeconds'] === 'number' && raw['preRefineSeconds'] >= 0
        ? raw['preRefineSeconds']
        : previous.preRefineSeconds,
    showModelReasoning: bool(raw['showModelReasoning'], previous.showModelReasoning),
    showTimestamps: bool(raw['showTimestamps'], previous.showTimestamps),
    chime: bool(raw['chime'], previous.chime),
    confirmExit: bool(raw['confirmExit'], previous.confirmExit),
    refinerProvider:
      typeof raw['refinerProvider'] === 'string'
        ? raw['refinerProvider']
        : previous.refinerProvider,
    refinerModel:
      typeof raw['refinerModel'] === 'string' ? raw['refinerModel'] : previous.refinerModel,
    refinerFallbackProfile:
      typeof raw['refinerFallbackProfile'] === 'string'
        ? raw['refinerFallbackProfile']
        : previous.refinerFallbackProfile,
    fallbackProfiles:
      raw['fallbackProfiles'] && typeof raw['fallbackProfiles'] === 'object'
        ? (raw['fallbackProfiles'] as Record<string, string[]>)
        : previous.fallbackProfiles,
    subagentModelPlan: parseSubagentModelPlan(raw['subagentModelPlan'], previous.subagentModelPlan),
  };
}

/**
 * Project a plan from the snapshot. The server's
 * `normalizeSubagentModelPlan` is the canonical coercion; this only has to
 * refuse shapes the editor cannot render, and hold the previous value rather
 * than blanking the panel on a partial snapshot.
 */
function parseSubagentModelPlan(value: unknown, previous: SubagentModelPlan): SubagentModelPlan {
  if (!value || typeof value !== 'object') return previous;
  const raw = value as Record<string, unknown>;
  const slots = Array.isArray(raw['slots'])
    ? raw['slots'].slice(0, MAX_SUBAGENT_LANES).map((slot): SubagentLane => {
        if (!slot || typeof slot !== 'object') return {};
        const entry = slot as Record<string, unknown>;
        const lane: SubagentLane = {};
        for (const key of ['provider', 'model', 'tier', 'fallbackProfile', 'label'] as const) {
          const field = entry[key];
          if (typeof field === 'string' && field.length > 0) lane[key] = field;
        }
        return lane;
      })
    : previous.slots;
  return {
    enabled: bool(raw['enabled'], previous.enabled),
    lock: bool(raw['lock'], previous.lock),
    followSessionModel: bool(raw['followSessionModel'], previous.followSessionModel),
    slots,
  };
}
