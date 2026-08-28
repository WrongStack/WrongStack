import * as path from 'node:path';
import type { Director } from '@wrongstack/core/coordination';
import { type AgentMonitorService, createAgentMonitorService } from '@wrongstack/core/coordination';
import type { EternalAutonomyEngine, ParallelEternalEngine } from '@wrongstack/core/execution';
import type { EventBus } from '@wrongstack/core/kernel';
import type { AutonomyStage, Config, SessionWriter } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { expectDefined, sessionScopedPath } from '@wrongstack/core/utils';
import { resolveFleetBudgetSources } from '../fleet/budget-source.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persistent ref for autonomy mode — set once here, read elsewhere via
 * `autonomyModeRef.current`. Matches the shape created in cli-main.ts.
 */
interface AutonomyModeRef {
  current: import('../services/autonomy-mode.js').AutonomyMode;
}

interface DirectorAutonomyDeps {
  flags: Record<string, string | boolean>;
  config: Config;
  wpaths: WstackPaths;
  session: SessionWriter;
  events: EventBus;
  autonomyModeRef: AutonomyModeRef;
}

export interface DirectorAutonomyResult {
  director: Director | null;
  directorMode: boolean;
  maxConcurrent: number | undefined;
  /** Lifetime spawn ceiling resolved from flag/env/profile/default. */
  maxSpawns: number;
  maxConcurrentSource: import('../fleet/budget-source.js').FleetBudgetSource;
  maxSpawnsSource: import('../fleet/budget-source.js').FleetBudgetSource;
  autonomyMode: import('../services/autonomy-mode.js').AutonomyMode;
  nextPredictEnabled: boolean;
  currentSuggestions: string[];
  eternalEngine: EternalAutonomyEngine | null;
  parallelEngine: ParallelEternalEngine | null;
  eternalListeners: Set<(entry: import('@wrongstack/core/goal').JournalEntry) => void>;
  broadcastEternalIteration: (entry: import('@wrongstack/core/goal').JournalEntry) => void;
  stageListeners: Set<(stage: AutonomyStage) => void>;
  broadcastAutonomyStage: (stage: AutonomyStage) => void;
  fleetRoot: string | undefined;
  manifestPath: string | undefined;
  sharedScratchpadPath: string | undefined;
  subagentSessionsRoot: string | undefined;
  stateCheckpointPath: string | undefined;
  fleetRootForPromotion: string;
  agentMonitor: AgentMonitorService;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Wire director / autonomy mode, fleet paths, eternal-engine scaffolding,
 * and the Agent Monitor service. Returns everything the caller needs to
 * reference later in the launch flow.
 *
 * The `director`, `eternalEngine`, `parallelEngine`, `autonomyMode`,
 * `nextPredictEnabled`, and `currentSuggestions` fields are returned at
 * their initial value — the caller may reassign `director` (from
 * `multiAgentHost.ensureDirector()`) and the other mutable fields later.
 */
export function setupDirectorAndAutonomy(deps: DirectorAutonomyDeps): DirectorAutonomyResult {
  const { flags, config, wpaths, session, events, autonomyModeRef } = deps;

  // ── Director mode (permanently on) ────────────────────────────────────
  const directorMode = true;

  // Concurrent + lifetime spawn ceilings. Priority: CLI flag → env → config → default.
  // Returns source labels for `/fleet status` and WebUI (issue #323).
  const {
    maxConcurrent: resolvedMaxConcurrent,
    maxConcurrentSource,
    maxSpawns,
    maxSpawnsSource,
  } = resolveFleetBudgetSources({ flags, config });
  // Preserve prior "undefined when nothing set" semantics for maxConcurrent so
  // MultiAgentHost can still fall back to coordinator default (4) when callers
  // pass through undefined. Only flag/env/profile produce a concrete value;
  // pure default leaves it undefined.
  const maxConcurrent = maxConcurrentSource === 'default' ? undefined : resolvedMaxConcurrent;

  // ── Autonomy mode ──────────────────────────────────────────────────────
  const autonomyMode: import('../services/autonomy-mode.js').AutonomyMode = (() => {
    const v = flags['autonomy'];
    if (v === 'auto' || v === 'suggest' || v === 'eternal' || v === 'eternal-parallel') return v;
    if (v === 'off') return 'off';
    return (config.autonomy?.defaultMode ??
      'off') as import('../services/autonomy-mode.js').AutonomyMode;
  })();
  autonomyModeRef.current = autonomyMode;

  const nextPredictEnabled = config.nextPrediction === true;
  const currentSuggestions: string[] = [];

  // ── Eternal / parallel engine scaffolding ──────────────────────────────
  const eternalEngine: EternalAutonomyEngine | null = null;
  const parallelEngine: ParallelEternalEngine | null = null;
  const eternalListeners = new Set<(entry: import('@wrongstack/core/goal').JournalEntry) => void>();
  const broadcastEternalIteration = (entry: import('@wrongstack/core/goal').JournalEntry): void => {
    for (const fn of eternalListeners) {
      try {
        fn(entry);
      } catch {
        // listener failures must never break the engine — swallow
      }
    }
  };
  const stageListeners = new Set<(stage: AutonomyStage) => void>();
  const broadcastAutonomyStage = (stage: AutonomyStage): void => {
    for (const fn of stageListeners) {
      try {
        fn(stage);
      } catch {
        // listener failures must never break the engine — swallow
      }
    }
  };

  // ── Fleet root paths ───────────────────────────────────────────────────
  const fleetRoot = directorMode
    ? sessionScopedPath(wpaths.projectSessions, session.id, '')
    : undefined;
  const manifestPath = directorMode
    ? typeof process.env['WRONGSTACK_FLEET_MANIFEST'] === 'string'
      ? process.env['WRONGSTACK_FLEET_MANIFEST']
      : path.join(expectDefined(fleetRoot), 'fleet.json')
    : undefined;
  const sharedScratchpadPath = directorMode
    ? path.join(expectDefined(fleetRoot), 'shared')
    : undefined;
  const subagentSessionsRoot = directorMode
    ? path.join(expectDefined(fleetRoot), 'subagents')
    : undefined;
  const stateCheckpointPath = directorMode
    ? path.join(expectDefined(fleetRoot), 'director-state.json')
    : undefined;
  const fleetRootForPromotion = sessionScopedPath(wpaths.projectSessions, session.id, '');

  // ── Agent Monitor — subagent conversation tracking ─────────────────────
  const agentMonitor = createAgentMonitorService({
    events,
    sessionId: session.id,
    transcriptsDir: path.join(fleetRootForPromotion, 'subagents', 'transcripts'),
    maxEntriesPerAgent: 500,
    streamEnabled: false,
  });

  return {
    director: null,
    directorMode,
    maxConcurrent,
    maxSpawns,
    maxConcurrentSource,
    maxSpawnsSource,
    autonomyMode,
    nextPredictEnabled,
    currentSuggestions,
    eternalEngine,
    parallelEngine,
    eternalListeners,
    broadcastEternalIteration,
    stageListeners,
    broadcastAutonomyStage,
    fleetRoot,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
    stateCheckpointPath,
    fleetRootForPromotion,
    agentMonitor,
  };
}
