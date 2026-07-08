import * as path from 'node:path';
import {
  type AutonomyStage,
  type Config,
  type Director,
  type EventBus,
  type EternalAutonomyEngine,
  type ParallelEternalEngine,
  expectDefined,
  type SessionWriter,
} from '@wrongstack/core';
import { type AgentMonitorService, createAgentMonitorService } from '@wrongstack/core/coordination';
import { sessionScopedPath } from '@wrongstack/core/utils';
import type { WstackPaths } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Persistent ref for autonomy mode — set once here, read elsewhere via
 * `autonomyModeRef.current`. Matches the shape created in cli-main.ts.
 */
export interface AutonomyModeRef {
  current: import('../slash-commands/autonomy.js').AutonomyMode;
}

export interface DirectorAutonomyDeps {
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
  autonomyMode: import('../slash-commands/autonomy.js').AutonomyMode;
  nextPredictEnabled: boolean;
  currentSuggestions: string[];
  eternalEngine: EternalAutonomyEngine | null;
  parallelEngine: ParallelEternalEngine | null;
  eternalListeners: Set<(entry: import('@wrongstack/core').JournalEntry) => void>;
  broadcastEternalIteration: (entry: import('@wrongstack/core').JournalEntry) => void;
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

  // ── Director mode ──────────────────────────────────────────────────────
  const directorMode = flags['director'] === true || typeof flags['resume'] === 'string';

  // Concurrent subagent ceiling. Priority: CLI flag → env var → config → default (4).
  const maxConcurrentFromFlag =
    typeof flags['max-concurrent'] === 'string'
      ? Number.parseInt(flags['max-concurrent'], 10)
      : undefined;
  const maxConcurrentFromEnv =
    typeof process.env['WRONGSTACK_MAX_CONCURRENT'] === 'string'
      ? Number.parseInt(process.env['WRONGSTACK_MAX_CONCURRENT'], 10)
      : undefined;
  const maxConcurrentFromConfig =
    typeof config.maxConcurrent === 'number' && config.maxConcurrent > 0
      ? config.maxConcurrent
      : undefined;
  const maxConcurrent =
    Number.isFinite(maxConcurrentFromFlag) && (maxConcurrentFromFlag as number) > 0
      ? (maxConcurrentFromFlag as number)
      : Number.isFinite(maxConcurrentFromEnv) && (maxConcurrentFromEnv as number) > 0
        ? (maxConcurrentFromEnv as number)
        : Number.isFinite(maxConcurrentFromConfig) && (maxConcurrentFromConfig as number) > 0
          ? (maxConcurrentFromConfig as number)
          : undefined;

  // ── Autonomy mode ──────────────────────────────────────────────────────
  const autonomyMode: import('../slash-commands/autonomy.js').AutonomyMode = (() => {
    const v = flags['autonomy'];
    if (v === 'auto' || v === 'suggest' || v === 'eternal' || v === 'eternal-parallel') return v;
    if (v === 'off') return 'off';
    return (config.autonomy?.defaultMode ?? 'off') as import('../slash-commands/autonomy.js').AutonomyMode;
  })();
  autonomyModeRef.current = autonomyMode;

  const nextPredictEnabled = config.nextPrediction === true;
  const currentSuggestions: string[] = [];

  // ── Eternal / parallel engine scaffolding ──────────────────────────────
  const eternalEngine: EternalAutonomyEngine | null = null;
  const parallelEngine: ParallelEternalEngine | null = null;
  const eternalListeners = new Set<(entry: import('@wrongstack/core').JournalEntry) => void>();
  const broadcastEternalIteration = (entry: import('@wrongstack/core').JournalEntry): void => {
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
