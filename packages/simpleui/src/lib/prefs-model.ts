/** Settings model — the small slice of server prefs SimpleUI exposes.
 *
 * The server is the source of truth: `prefs.get` seeds us, `prefs.update`
 * writes through to `agent.ctx.meta` + config.json, and the server answers
 * with a `prefs.updated` broadcast that every tab re-reads. We deliberately
 * project only the handful of keys SimpleUI surfaces — the snapshot carries
 * the full `PREF_KEYS` set and unknown keys must survive untouched.
 */

export type AutonomyMode = 'off' | 'suggest' | 'auto';

export interface SimplePrefs {
  subagentsAllowed: boolean;
  subagentsPolicyLocked: boolean;
  autonomy: AutonomyMode;
  yolo: boolean;
  enhanceEnabled: boolean;
  /** Pre-refine grace countdown (seconds). 0 = skip. */
  preRefineSeconds: number;
  showModelReasoning: boolean;
  chime: boolean;
  confirmExit: boolean;
  refinerProvider: string;
  refinerModel: string;
  refinerFallbackProfile: string;
  fallbackProfiles: Record<string, string[]>;
}

export const DEFAULT_PREFS: SimplePrefs = {
  subagentsAllowed: true,
  subagentsPolicyLocked: false,
  autonomy: 'off',
  yolo: false,
  enhanceEnabled: false,
  preRefineSeconds: 3,
  showModelReasoning: true,
  chime: false,
  confirmExit: false,
  refinerProvider: '',
  refinerModel: '',
  refinerFallbackProfile: '',
  fallbackProfiles: {},
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
  };
}
