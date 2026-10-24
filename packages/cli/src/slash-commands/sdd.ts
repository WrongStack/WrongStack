import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  createKanbanSddSessionPersistence,
  renderProgress,
  SpecStore,
  type TaskTracker,
} from '@wrongstack/sdd';
import { getSessionState, sddState } from '../services/sdd/state.js';
import { getTaskTrackerExport as _getTaskTracker } from '../services/sdd/task-manager.js';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import { sddHelp } from './sdd/rendering.js';
import {
  formatSddDestroyResult,
  parseParallelSlots,
  parseSddSubtasks,
  SDD_KNOWN_SUBCOMMANDS,
} from './sdd-command-helpers.js';
import { runSddInspectCommand } from './sdd-inspect-commands.js';
import { runSddSessionCommand } from './sdd-session-commands.js';
import { executeSddTaskMutation } from './sdd-task-mutations.js';

export type { TaskProgress } from '@wrongstack/contracts/types';
export {
  findSpec,
  gatherProjectContext,
  getActiveBuilder,
  getActiveSDDContext,
  getActiveSDDPhase,
} from '../services/sdd/project-context.js';
export {
  autoDetectTaskCompletion,
  isExplanatoryText,
  trySaveImplementationPlan,
  trySaveSpecFromAIOutput,
} from '../services/sdd/spec-detection.js';
export { SDDState, sddState } from '../services/sdd/state.js';
export {
  advanceToNextTask,
  formatElapsed,
  getCurrentExecutingContext,
  getTaskGraphId,
  getTaskListText,
  getTaskProgress,
  getTaskTrackerExport,
  markTaskCompleted,
  renderTaskListWithProgress,
  trySaveTasksFromAIOutput,
} from '../services/sdd/task-manager.js';
export { renderProgress };
export function getTaskTracker(): TaskTracker | null {
  return _getTaskTracker();
}

/**
 * `/sdd` — AI-driven Specification-Driven Development workflow.
 */
export function buildSddCommand(opts: SlashCommandContext): SlashCommand {
  // All state accesses in this command go through sessionState so that
  // concurrent REPL/browser sessions are fully isolated.
  const sessionState = getSessionState(opts.context);

  return {
    name: 'sdd',
    category: 'Agent',
    description: 'AI-driven SDD: /sdd [new|approve|execute|cancel|status|list|show|templates]',
    async run(args) {
      if (!opts.paths) return { message: 'SDD not available — paths not configured.' };
      const specsDir = opts.paths.projectSpecs;
      const projectRoot = opts.projectRoot || opts.context?.projectRoot || process.cwd();
      const legacySession = opts.sddSessionTransport === 'legacy-file';
      const sessionPersistence = legacySession
        ? undefined
        : createKanbanSddSessionPersistence(projectRoot, opts.paths.projectSddSession);
      const sessionPersistenceOptions = sessionPersistence
        ? { sessionPersistence }
        : { sessionPath: opts.paths.projectSddSession };
      const specStore = new SpecStore({ baseDir: specsDir });
      const versioning = sddState.getVersioning();

      const { cmd, rest: restArgs } = parseSubcommand(args);
      const restJoined = restArgs.join(' ').trim();

      switch (cmd) {
        case '':
        case 'help':
          return { message: sddHelp() };
        case 'new':
        case 'create':
        case 'approve':
        case 'ok':
        case 'confirm':
        case 'cancel':
        case 'resume':
          return runSddSessionCommand({
            cmd,
            restArgs,
            sessionState,
            projectRoot,
            specStore,
            sessionPersistenceOptions,
            opts,
            versioning,
            sessionPersistence,
          });

        // ── Task Execution ─────────────────────────────────────────────────

        case 'run':
        case 'execute': {
          // If parallel is available, delegate to it; otherwise fall through
          if (opts.onSddParallelRun) {
            const message = await opts.onSddParallelRun(parseParallelSlots(restJoined) ?? {});
            return { message };
          }
          const runBuilder = sddState.getBuilder();
          if (!runBuilder) {
            return {
              message: 'No active SDD session. Use /sdd new to start one.',
            };
          }

          const session = runBuilder.getSession();
          if (session.phase !== 'executing' && session.phase !== 'task_review') {
            return {
              message: `Cannot execute in phase "${session.phase}". Use /sdd approve first.`,
            };
          }

          const execPrompt = runBuilder.getAIPrompt();
          return {
            message: '⚡ Starting task execution. The AI will execute tasks one by one.',
            runText: `[SDD SESSION ACTIVE]\n${execPrompt}\n\n---\nUser message:\nStart executing the tasks one by one.`,
          };
        }

        case 'parallel': {
          if (!opts.onSddParallelRun) {
            return { message: 'SDD parallel run is not available in this session.' };
          }
          const message = await opts.onSddParallelRun(parseParallelSlots(restJoined) ?? {});
          return { message };
        }

        case 'stop':
        case 'abort': {
          opts.onSddParallelStop?.();
          return {
            message:
              'SDD parallel run stopped. Use /sdd clean to remove worktrees, /sdd rollback to undo commits, or /sdd destroy to delete the project.',
          };
        }

        case 'clean':
        case 'cleanup':
        case 'worktrees': {
          if (!opts.onSddCleanWorktrees) {
            return { message: 'Worktree cleanup is not available in this session.' };
          }
          const removed = await opts.onSddCleanWorktrees();
          return {
            message:
              removed > 0
                ? `Cleaned ${removed} SDD worktree${removed === 1 ? '' : 's'} (and their wstack/ap branches).`
                : 'No SDD worktrees to clean.',
          };
        }

        case 'rollback':
        case 'revert': {
          if (!opts.onSddRollback) {
            return { message: 'Rollback is not available in this session.' };
          }
          const res = await opts.onSddRollback();
          if (res.ok) {
            return {
              message:
                res.reverted > 0
                  ? `Rolled back ${res.reverted} run commit${res.reverted === 1 ? '' : 's'} (revert commits added — history preserved).`
                  : 'Nothing to roll back.',
            };
          }
          return {
            message: `Rollback failed${res.reverted ? ` after ${res.reverted} revert(s)` : ''}: ${res.reason ?? 'unknown error'}`,
          };
        }

        case 'destroy':
        case 'nuke': {
          if (!opts.onSddDestroy) {
            return { message: 'Destroy is not available in this session.' };
          }
          // `/sdd destroy --revert` also reverts merged commits before wiping.
          const revertMerged = restArgs.some((a) => a === '--revert' || a === '--rollback');
          await sddState.flushTaskWrites();
          const res = await opts.onSddDestroy({ revertMerged });
          // Mirror /sdd cancel's in-memory cleanup so the session is fully gone.
          const builder = sddState.getBuilder();
          if (builder) {
            await builder.deleteSession().catch(() => {});
            sddState.setBuilder(null);
          }
          sddState.clearTaskState();
          return { message: formatSddDestroyResult(res, revertMerged) };
        }

        case 'retry-failed':
        case 'retry-all': {
          if (!opts.onSddRetryAllFailed) {
            return { message: 'No active SDD parallel run to retry.' };
          }
          const n = opts.onSddRetryAllFailed();
          return {
            message:
              n > 0
                ? `Requeued ${n} failed task${n === 1 ? '' : 's'} to pending.`
                : 'No failed tasks to retry.',
          };
        }

        case 'split': {
          if (!opts.onSddSplitTask) {
            return { message: 'No active SDD parallel run to split a task in.' };
          }
          // Syntax: /sdd split <task> <subtitle :: desc ; subtitle :: desc ; …>
          // taskId is the first token; the remainder is `;`-separated sub-tasks,
          // each `Title :: description` (description optional → defaults to title).
          const taskId = restArgs[0];
          if (!taskId) {
            return { message: 'Usage: /sdd split <task-id> <subtask ; subtask ; …>' };
          }
          const subtasks = parseSddSubtasks(restArgs.slice(1));
          if (subtasks.length < 2) {
            return { message: 'Provide at least two sub-tasks: /sdd split <task-id> <A ; B>' };
          }
          const ids = opts.onSddSplitTask(taskId, subtasks);
          if (ids === null) {
            return {
              message: `No active run, or task "${taskId}" is unknown / running (can't split).`,
            };
          }
          return {
            message: `Split ${taskId} into ${ids.length} sub-task${ids.length === 1 ? '' : 's'}: ${ids.join(', ')}`,
          };
        }

        case 'plan':
        case 'impl': {
          const planBuilder = sddState.getBuilder();
          if (!planBuilder) {
            return { message: 'No active SDD session. Use /sdd new to start one.' };
          }

          const planSession = planBuilder.getSession();
          if (!planSession.implementation) {
            return {
              message:
                planSession.phase === 'implementation'
                  ? 'No implementation plan yet. The AI will generate it after /sdd approve.'
                  : 'No implementation plan in this session.',
            };
          }

          return {
            message: ['═══ Implementation Plan ═══', '', planSession.implementation].join('\n'),
          };
        }
        case 'spec':
        case 'tasks':
        case 'task':
        case 'next':
        case 'status':
        case 'graph':
        case 'list':
        case 'ls':
        case 'show':
        case 'view':
        case 'templates':
        case 'from':
        case 'version':
        case 'history':
        case 'critical':
        case 'bottleneck':
          return runSddInspectCommand({ cmd, opts, specStore, restJoined, versioning });

        case 'done':
        case 'complete':
        case 'skip':
        case 'fail':
        case 'review':
        case 'edit':
        case 'undo':
          return executeSddTaskMutation(cmd, restJoined);

        default:
          return {
            message: `${unknownSubcommand(cmd, SDD_KNOWN_SUBCOMMANDS, 'sdd')}\n\n${sddHelp()}`,
          };
      }
    },
  };
}
