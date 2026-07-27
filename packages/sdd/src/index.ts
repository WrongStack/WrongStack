// SDD domain: spec-driven development — parsing, task generation, tracking, flow,
// persistence, interactive building, visualization, and auto-execution.

export { SpecParser } from './spec-parser.js';
export {
  TaskGenerator,
  extractVerificationCommand,
  assessGeneratedTaskAtomicity,
  type TaskGeneratorOptions,
  type GeneratedTask,
} from './task-generator.js';
// TaskTracker and DefaultTaskStore moved to @wrongstack/core/tasking in
// PR-10; re-exported here so existing `@wrongstack/sdd` consumers keep
// working. New code should import directly from `@wrongstack/core/tasking`.
export {
  TaskTracker,
  DefaultTaskStore,
  type TaskStore,
  type TaskTrackerOptions,
  type TaskTransition,
  type TaskTrackerChange,
  type TaskTrackerListener,
} from '@wrongstack/core/tasking';
export {
  TaskFlow,
  SpecDrivenDev,
  type TaskFlowPhase,
  type TaskFlowOptions,
  type TaskFlowExecutionContext,
  type TaskFlowEventMap,
  type TaskFlowEventName,
  type SpecDrivenDevOptions,
} from './task-flow.js';

// Persistence
export { SpecStore, type SpecStoreOptions, type SpecIndexEntry } from './spec-store.js';
export { TaskGraphStore, type TaskGraphStoreOptions, type TaskGraphIndexEntry } from './task-graph-store.js';

// Live board model + persistence
export {
  buildBoardTasks,
  buildBoardSnapshot,
  shortIdMap,
  type SddBoardSnapshot,
  type SddBoardTask,
  type SddBoardColumn,
  type SddBoardStatus,
  type SddTaskDisplayStatus,
  type SddDeadlockChain,
  type SddBoardFeedEntry,
} from './board-types.js';
export {
  SddBoardStore,
  type SddBoardStoreOptions,
  type SddBoardIndexEntry,
  type SddBoardEvent,
} from './sdd-board-store.js';
export { SddBoardProjector, type SddBoardProjectorOptions } from './sdd-board-projector.js';
export { SddRunRegistry, type SddRunControl } from './sdd-run-registry.js';
export {
  SddInterviewDriver,
  isExplanatoryText,
  type SddInterviewDriverOptions,
  type SddInterviewSnapshot,
  type SddIngestResult,
} from './sdd-interview-driver.js';
export {
  startSddRun,
  type StartSddRunOptions,
  type SddRunHandle,
} from './start-sdd-run.js';
export {
  cleanupSddWorktrees,
  cleanupStaleWorktrees,
  cleanupStaleSddWorktrees,
  rollbackSddRunFromDisk,
  destroySddProject,
  applySddLifecycle,
  type RollbackFromDiskOptions,
  type DestroySddProjectOptions,
  type DestroySddProjectResult,
  type CleanupStaleSddOptions,
  type CleanupStaleSddResult,
  type SddLifecycleOp,
  type SddLifecycleOptions,
  type SddLifecycleResult,
} from './sdd-lifecycle.js';

// AI-Driven Interactive Builder
export {
  AISpecBuilder,
  type AISpecBuilderOptions,
  type AISpecPhase,
  type AISpecSession,
  type CollectedAnswer,
} from './spec-builder.js';

// Project footprint for interview prompts (CLI + WebUI wizard share this)
export { gatherProjectContext } from './project-context.js';

// Templates
export {
  SPEC_TEMPLATES,
  getTemplate,
  listTemplates,
  templateToMarkdown,
} from './spec-templates.js';

// Visualization
export {
  renderTaskGraph,
  renderProgress,
  renderTaskList,
  renderSpecAnalysis,
} from './task-visualizer.js';

// Critical Path
export { analyzeCriticalPath, type CriticalPathAnalysis, type BottleneckTask } from './critical-path.js';

// Spec Versioning
export { SpecVersioning, type SpecVersion, type SpecDiff } from './spec-versioning.js';

// Auto-Executor
export {
  AutoExecutor,
  createAutoExecutor,
  type AutoExecutorOptions,
  type TaskExecutionContext,
  type TaskExecutionResult,
  type ExecutionSummary,
} from './auto-executor.js';

// Parallel fan-out run (SDD TaskGraph → ParallelEternalEngine bridge)
export {
  SddTaskDecomposer,
  type SddTaskDecomposerOptions,
  type TaskBatch,
} from './sdd-task-decomposer.js';
export {
  SddParallelRun,
  type SddParallelRunOptions,
  type SddProgress,
  type WaveResult,
  type RunResult,
  type SddSubtaskSpec,
  type SddSupervisorVerdict,
} from './sdd-parallel-run.js';
export { SddSupervisor, type SddSupervisorOptions } from './sdd-supervisor.js';
export {
  makeAcceptanceCriteriaVerifier,
  makeCommandVerifier,
  makeCompositeVerifier,
  type AcceptanceCriteriaVerifierOptions,
  type CommandVerifierOptions,
  type SddVerifyTask,
} from './verify-task.js';
export {
  makeLlmSubtaskGenerator,
  makePlanningDecomposer,
  type PlanningDecomposer,
  type PlanningDecomposerOptions,
  type SubtaskGeneratorOptions,
} from './decompose-task.js';
export { splitGraphNode, type SplitGraphNodeOptions } from './graph-split.js';
export {
  assessTaskNodeAtomicity,
  decomposeNonAtomicTasks,
  type DecompositionProposal,
  type PlanDecomposeOptions,
  type PlanDecomposeResult,
} from './plan-decompose.js';
export {
  makePreferSideConflictResolver,
  makeLlmConflictResolver,
  resolveConflictText,
  hasConflictMarkers,
  type ConflictSide,
  type LlmConflictResolverOptions,
} from './conflict-resolver.js';
