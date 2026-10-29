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
  appendJournal,
  emptyGoal,
  formatGoal,
  type GoalFile,
  goalFilePath,
  type JournalEntry,
  loadGoal,
  MAX_JOURNAL_ENTRIES,
  MAX_PROGRESS_HISTORY,
  type ProgressSnapshot,
  parseProgressFromText,
  recordProgress,
  replaceGoalMission,
  saveGoal,
  setProgress,
  summarizeUsage,
  updateGoal,
} from '@wrongstack/core/storage';
export {
  type Checkpoint,
  CheckpointManager,
  type CheckpointManagerOptions,
} from './checkpoint.js';
export {
  GoalAssessor,
  type GoalAssessorOptions,
  type GoalAssessResult,
} from './goal-assessor.js';
export {
  type GoalBudget,
  type GoalBudgetUsage,
  goalBudgetExceeded,
  parseGoalBudget,
} from './goal-budget.js';
export {
  extractJSONArray as extractGoalJSONArray,
  GoalPlanner,
  type GoalPlannerOptions,
  type GoalPlanResult,
} from './goal-planner.js';
export { GoalRunPersistence, prepareGoalGraphForResume } from './goal-run-lifecycle.js';
export {
  createGoalRunnerFromTaskGraph,
  GoalRunner,
  type GoalRunnerOptions,
} from './goal-runner.js';
export { type GoalSummary, summarizeGoal } from './goal-summary.js';
export { prepareGoalWorkspace, releaseGoalWorkspaceHold } from './goal-workspace.js';
export {
  buildGoalRefinementPrompt,
  parseGoalRefinement,
  type RefinedMission,
  refineGoalHeuristic,
  refineGoalWithProvider,
  resolveRefinerTarget,
} from './mission-refinement.js';
export {
  PhaseGraphBuilder,
  type PhaseGraphBuilderOptions,
} from './phase-graph-builder.js';
export {
  PhaseOrchestrator,
  type PhaseOrchestratorOptions,
} from './phase-orchestrator.js';
export { GoalRunLeaseBusyError, PhaseStore, type PhaseStoreOptions } from './phase-store.js';
export {
  type GoalProjectVerificationResult,
  type GoalProjectVerifierOptions,
  verifyGoalProject,
} from './project-verifier.js';
export type {
  GoalOptions,
  PhaseEventMap,
  PhaseEventName,
  PhaseExecutionContext,
  PhaseFilter,
  PhaseGraph,
  PhaseNode,
  PhaseProgress,
  PhaseSort,
  PhaseStatus,
  PhaseTemplate,
} from './types.js';
export { PHASE_EVENT_NAMES } from './types.js';
