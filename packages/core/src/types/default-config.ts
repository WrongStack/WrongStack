/**
 * Shared configuration constants used across execution, storage, CLI, and WebUI.
 * Centralized here to avoid cross-domain import cycles.
 */

/** Default tools config — mirrors values baked into CONFIG_BEHAVIOR_DEFAULTS. */
export const DEFAULT_TOOLS_CONFIG = Object.freeze({
  defaultExecutionStrategy: 'smart',
  maxIterations: 100,
  iterationTimeoutMs: 300_000,
  maxToolTimeoutMs: 300_000,
  sessionTimeoutMs: 1_800_000,
  perIterationOutputCapBytes: 100_000,
  descriptionMode: Object.freeze({}) as Record<string, 'extend' | 'simple' | undefined>,
  disabledTools: Object.freeze([]) as readonly string[],
  // Extension requires an explicit host/user policy. Without that boundary a
  // nominal maxIterations cap can grow forever in autonomous sessions.
  autoExtendLimit: false,
  restrictToProjectRoot: true,
  // Off by default: the board is a record of the work, not a permit for it.
  // See ToolsConfig.kanbanGovernance for what turning it on costs and gates.
  kanbanGovernance: false,
  loopDetection: Object.freeze({
    mode: 'steer-then-cut',
    steerThreshold: 3,
    cutThreshold: 5,
    windowSize: 12,
    callRepeatThreshold: 4,
  }) as Readonly<{
    mode: 'steer-then-cut' | 'cut' | 'off';
    steerThreshold: number;
    cutThreshold: number;
    windowSize: number;
    callRepeatThreshold: number;
  }>,
  // Off by default — the user opts in via `/settings autothin on`. The
  // `disabledToolMeta` field starts empty; the pipeline writes it on the
  // first successful `apply` and clears it on `undo`.
  autoThin: Object.freeze({
    enabled: false,
    idleDays: 30,
    minInvocations: 3,
    applyOnBoot: false,
  }) as Readonly<{
    enabled: boolean;
    idleDays: number;
    minInvocations: number;
    applyOnBoot: boolean;
  }>,
});

/** Default context config — mirrors CONFIG_BEHAVIOR_DEFAULTS.context. */
export const DEFAULT_CONTEXT_CONFIG = Object.freeze({
  warnThreshold: 0.55,
  softThreshold: 0.7,
  hardThreshold: 0.85,
  targetLoad: 0.65,
  preserveK: 8,
  eliseThreshold: 1200,
});

/** Default autonomy config — auto-proceed delay etc. */
export const DEFAULT_AUTONOMY_CONFIG = Object.freeze({
  autoProceedDelayMs: 45_000,
});

/**
 * Default process circuit-breaker config. Protection is OFF by default — the
 * breaker only gates `bash`/`exec` once the user opts in via `/settings breaker on`.
 * The auto kill/reset delay is only consulted when protection is enabled.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG = Object.freeze({
  enabled: false,
  autoKillResetMs: 60_000,
});

/** Default session logging / audit configuration. */
export const DEFAULT_SESSION_LOGGING_CONFIG = Object.freeze({
  auditLevel: 'standard' as const,
  sampling: {
    toolProgress: {
      sampleRate: 8,
    },
  },
  storage: Object.freeze({
    hotKeepSessions: 20,
    archiveAfterDays: 7,
    autoArchive: true,
    includeSubagents: true,
  }),
});

/** Default retention window for local session pruning. */
export const DEFAULT_SESSION_PRUNE_DAYS = 30;
