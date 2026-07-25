// Goal - autonomous phase-based workflow system
//
// Goal splits large projects into phases and subtasks,
// runs them with dependency awareness, and advances phase by phase autonomously.
//
// Usage:
//   const runner = new GoalRunner({
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
  GoalRunner,
  createGoalRunnerFromTaskGraph,
  type GoalRunnerOptions,
} from './goal-runner.js';

export {
  PhaseOrchestrator,
  type PhaseOrchestratorOptions,
} from './phase-orchestrator.js';

export {
  PhaseGraphBuilder,
  type PhaseGraphBuilderOptions,
} from './phase-graph-builder.js';

export {
  GoalPlanner,
  extractJSONArray as extractGoalJSONArray,
  type GoalPlannerOptions,
  type GoalPlanResult,
} from './goal-planner.js';

export {
  GoalAssessor,
  type GoalAssessResult,
  type GoalAssessorOptions,
} from './goal-assessor.js';

export type {
  PhaseGraph,
  PhaseNode,
  PhaseStatus,
  PhaseProgress,
  PhaseEventMap,
  PhaseEventName,
  PhaseExecutionContext,
  GoalOptions,
  PhaseFilter,
  PhaseSort,
  PhaseTemplate,
} from './types.js';
export { PHASE_EVENT_NAMES } from './types.js';

export { PhaseStore, type PhaseStoreOptions } from './phase-store.js';
export {
  appendJournal,
  emptyGoal,
  formatGoal,
  goalFilePath,
  loadGoal,
  MAX_JOURNAL_ENTRIES,
  MAX_PROGRESS_HISTORY,
  parseProgressFromText,
  recordProgress,
  saveGoal,
  setProgress,
  summarizeUsage,
  type GoalFile,
  type JournalEntry,
  type ProgressSnapshot,
} from '../storage/goal-store.js';
export {
  CheckpointManager,
  type CheckpointManagerOptions,
  type Checkpoint,
} from './checkpoint.js';
