// AutoPhase — Otonom faz tabanlı iş akışı sistemi
//
// AutoPhase, büyük projeleri fazlara ve alt görevlere böler,
// dependency-aware çalıştırır, ve otonom olarak faz faz ilerler.
//
// Kullanım:
//   const runner = new AutoPhaseRunner({
//     title: 'Auth Refactor',
//     phases: [
//       { name: 'Discovery', description: '...', priority: 'high', estimateHours: 2, parallelizable: false },
//       { name: 'Design', description: '...', priority: 'critical', estimateHours: 4, parallelizable: false },
//       { name: 'Implementation', description: '...', priority: 'critical', estimateHours: 12, parallelizable: false },
//       { name: 'Testing', description: '...', priority: 'high', estimateHours: 6, parallelizable: true },
//     ],
//     executeTask: async (task, phaseId) => { /* AI agent task execution */ },
//     onProgress: (p) => console.log(`${p.percentComplete}%`),
//   });
//   await runner.start();

export {
  AutoPhaseRunner,
  createAutoPhaseFromTaskGraph,
  type AutoPhaseRunnerOptions,
} from './auto-phase-runner.js';

export {
  PhaseOrchestrator,
  type PhaseOrchestratorOptions,
} from './phase-orchestrator.js';

export {
  PhaseGraphBuilder,
  type PhaseGraphBuilderOptions,
} from './phase-graph-builder.js';

export {
  AutoPhasePlanner,
  extractJSONArray as extractAutoPhaseJSONArray,
  type AutoPhasePlannerOptions,
  type AutoPhasePlanResult,
} from './auto-phase-planner.js';

export type {
  PhaseGraph,
  PhaseNode,
  PhaseStatus,
  PhaseProgress,
  PhaseEventMap,
  PhaseEventName,
  PhaseExecutionContext,
  AutoPhaseOptions,
  PhaseFilter,
  PhaseSort,
  PhaseTemplate,
} from './types.js';

export { PhaseStore, type PhaseStoreOptions } from './phase-store.js';
export {
  CheckpointManager,
  type CheckpointManagerOptions,
  type Checkpoint,
} from './checkpoint.js';
