import * as fsp from 'node:fs/promises';
import type { SlashCommand, SpecRequirement } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import {
  AISpecBuilder,
  analyzeCriticalPath,
  createKanbanSddSessionPersistence,
  getTemplate,
  listTemplates,
  renderProgress,
  renderSpecAnalysis,
  renderTaskGraph,
  SpecParser,
  SpecStore,
  type SpecVersion,
  TaskGraphStore,
  TaskTracker,
  templateToMarkdown,
} from '@wrongstack/sdd';
import { findSpec, gatherProjectContext } from '../services/sdd/project-context.js';
import { getSessionState, sddState } from '../services/sdd/state.js';
import {
  advanceToNextTask,
  formatElapsed,
  getTaskProgress,
  matchTaskNode,
} from '../services/sdd/task-manager.js';
import type { SlashCommandContext } from './command-context.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import {
  formatExistingSddSessionMessage,
  formatSddDestroyResult,
  parseParallelSlots,
  parseSddSubtasks,
  SDD_KNOWN_SUBCOMMANDS,
} from './sdd-command-helpers.js';
import {
  formatBlockedTasks,
  formatCriticalPathAnalysis,
  formatCurrentSpec,
  formatGraphListFallback,
  formatNextTaskView,
  formatSddStatusView,
  formatSpecList,
  formatTaskListView,
  sortTasksForSddDisplay,
} from './sdd-format.js';

export type { TaskProgress } from '@wrongstack/core/types';
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
export { SDDState, sddState } from '../services/sdd/state.js';;
export { advanceToNextTask, formatElapsed, getCurrentExecutingContext, getTaskGraphId, getTaskListText, getTaskProgress, getTaskTrackerExport, markTaskCompleted, renderTaskListWithProgress, trySaveTasksFromAIOutput } from '../services/sdd/task-manager.js';;
export { renderProgress };

import { getTaskTrackerExport as _getTaskTracker } from '../services/sdd/task-manager.js';
export function getTaskTracker(): TaskTracker | null {
  return _getTaskTracker();
}

import { sddHelp } from './sdd/rendering.js';

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

        // ── AI-Driven Spec Session ─────────────────────────────────────────

        case 'new':
        case 'create': {
          const forceFlag = restArgs.includes('--force') || restArgs.includes('-f');
          const title =
            restArgs
              .filter((a) => !a.startsWith('-'))
              .join(' ')
              .trim() || 'Untitled Feature';

          // Check for existing session and offer to resume (unless --force)
          if (!sessionState.getBuilder() && !forceFlag) {
            try {
              const projectContext = await gatherProjectContext(projectRoot);
              const tempBuilder = new AISpecBuilder({
                store: specStore,
                projectContext,
                ...sessionPersistenceOptions,
              });
              const loaded = await tempBuilder.loadSession();
              if (loaded) {
                const existing = tempBuilder.getSession();
                if (existing.phase !== 'done') {
                  return {
                    message: formatExistingSddSessionMessage(existing),
                  };
                }
              }
            } catch (error) {
              return {
                message: `SDD session state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }

          // Reset task state from previous session
          sddState.clearTaskState();
          sddState.setTaskStore(new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs }));

          // Gather project context for smarter AI questions
          const projectContext = await gatherProjectContext(projectRoot);

          sddState.setBuilder(
            new AISpecBuilder({
              store: specStore,
              projectContext,
              minQuestions: 2,
              maxQuestions: 10,
              ...sessionPersistenceOptions,
            }),
          );
          // Reset session and phase timers for the new session
          sddState.setSessionStartTime(Date.now());
          sddState.setPhaseStartTime(Date.now());
          const builder = expectDefined(sddState.getBuilder());
          builder.startSession(title);

          const aiPrompt = builder.getAIPrompt();

          return {
            message: [
              `╔═══ SDD: AI Spec Builder ═══╗`,
              '',
              `Feature: "${title}"`,
              '',
              'The AI will now ask you contextual questions.',
              'Answer naturally — it will generate the spec when ready.',
              '',
              'Commands: /sdd approve · /sdd status · /sdd cancel',
            ].join('\n'),
            runText: `[SDD SESSION ACTIVE]\n${aiPrompt}\n\n---\nUser message:\nStart the specification interview for "${title}". Ask your first contextual question.`,
          };
        }

        // ── Phase Transitions ──────────────────────────────────────────────

        case 'approve':
        case 'ok':
        case 'confirm': {
          const builder = sddState.getBuilder();
          if (!builder) {
            return {
              message: 'No active SDD session. Use /sdd new to start one.',
            };
          }

          const phase = builder.getSession().phase;

          if (phase === 'questioning') {
            // AI hasn't generated spec yet — tell it to generate now
            const sddCtx = builder.getAIPrompt();
            return {
              message: 'No spec generated yet. Generating now...',
              runText: `[SDD SESSION ACTIVE]\n${sddCtx}\n\n---\nUser message:\nGenerate the complete specification now based on the conversation so far.`,
            };
          }

          if (phase === 'spec_review') {
            const spec = builder.getSession().spec;
            if (!spec) {
              return { message: 'No spec to approve.' };
            }

            // Save spec and move to implementation phase
            await builder.saveSpec();
            versioning.recordVersion(spec, 'Initial spec approved');
            builder.approve(); // spec_review → implementation
            sddState.setPhaseStartTime(Date.now()); // reset phase timer

            const implPrompt = builder.getAIPrompt();
            return {
              message: [
                `✅ Spec "${spec.title}" approved and saved!`,
                `ID: ${spec.id}`,
                `Requirements: ${spec.requirements.length}`,
                '',
                'The AI will now generate an implementation plan and tasks.',
              ].join('\n'),
              runText: `[SDD SESSION ACTIVE]\n${implPrompt}\n\n---\nUser message:\nGenerate the implementation plan and tasks for the approved spec.`,
            };
          }

          if (phase === 'task_review') {
            builder.approve(); // task_review → executing
            sddState.setPhaseStartTime(Date.now()); // reset phase timer

            // Auto-start the first ready task when entering executing phase
            advanceToNextTask();

            const execPrompt = builder.getAIPrompt();
            return {
              message: '✅ Tasks approved! The AI will now execute them one by one.',
              runText: `[SDD SESSION ACTIVE]\n${execPrompt}\n\n---\nUser message:\nStart executing the tasks one by one.`,
            };
          }

          if (phase === 'implementation') {
            const session = builder.getSession();
            const plan = session.implementation;
            if (!plan) {
              return {
                message:
                  'No implementation plan yet. The AI is still generating it. Try again shortly.',
              };
            }
            return {
              message: [
                `╭─── Implementation Plan ───────────────────────────────╮`,
                '',
                ...plan.split('\n').map((l) => `  ${l}`),
                '',
                `╰${'─'.repeat(55)}╯`,
              ].join('\n'),
            };
          }

          return {
            message: `Current phase is "${phase}". Use /sdd status to see details.`,
          };
        }

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

        case 'spec': {
          const specBuilder = sddState.getBuilder();
          if (!specBuilder) {
            return { message: 'No active SDD session. Use /sdd new to start one.' };
          }

          const specSession = specBuilder.getSession();
          if (!specSession.spec) {
            return {
              message:
                specSession.phase === 'questioning'
                  ? "No spec generated yet. Keep answering the AI's questions."
                  : 'No spec in this session.',
            };
          }

          return { message: formatCurrentSpec(specSession.spec) };
        }

        case 'tasks':
        case 'task': {
          const taskTracker = sddState.getTaskTracker();
          if (!taskTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const nodes = taskTracker.getAllNodes();
          if (nodes.length === 0) {
            return { message: 'No tasks in the current graph.' };
          }

          const progress = taskTracker.getProgress();
          const builder = sddState.getBuilder();
          const phase = builder?.getPhase() ?? 'unknown';
          // Sort: in_progress first, then pending, then others
          const sorted = sortTasksForSddDisplay(nodes);
          return {
            message: formatTaskListView(sorted, progress, phase, renderProgress, formatElapsed),
          };
        }

        case 'done':
        case 'complete': {
          const doneTracker = sddState.getTaskTracker();
          if (!doneTracker) {
            return { message: 'No tasks to complete.' };
          }

          if (!restJoined) {
            return { message: 'Usage: /sdd done <task title or number>' };
          }

          const nodes = doneTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          const match = matchTaskNode(nodes, restJoined);
          if (!match) {
            return { message: `No pending task matching "${restJoined}".` };
          }
          doneTracker.updateNodeStatus(match.id, 'completed');

          const remaining = doneTracker.getProgress();
          return {
            message: `✅ Task marked done! (${remaining.completed}/${remaining.total} — ${remaining.percentComplete}%)`,
          };
        }

        case 'skip': {
          const skipTracker = sddState.getTaskTracker();
          if (!skipTracker) return { message: 'No tasks to skip.' };
          if (!restJoined) return { message: 'Usage: /sdd skip <task title or number>' };

          const nodes = skipTracker.getAllNodes({ status: ['pending', 'in_progress', 'blocked'] });
          const match = matchTaskNode(nodes, restJoined);
          if (!match) return { message: `No task matching "${restJoined}".` };
          skipTracker.updateNodeStatus(match.id, 'pending');

          const progress = skipTracker.getProgress();
          return {
            message: `⏭ Task skipped — moved to pending. (${progress.completed}/${progress.total} — ${progress.percentComplete}%)`,
          };
        }

        case 'fail': {
          const failTracker = sddState.getTaskTracker();
          if (!failTracker) return { message: 'No tasks to fail.' };
          if (!restJoined) return { message: 'Usage: /sdd fail <task title or number>' };

          const nodes = failTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          const match = matchTaskNode(nodes, restJoined);
          if (!match) return { message: `No pending/in-progress task matching "${restJoined}".` };
          failTracker.updateNodeStatus(match.id, 'failed');

          const progress = failTracker.getProgress();
          return {
            message: `❌ Task marked as failed. (${progress.failed} failed · ${progress.completed}/${progress.total} done)`,
          };
        }

        case 'review': {
          const reviewTracker = sddState.getTaskTracker();
          if (!reviewTracker) return { message: 'No tasks to review.' };
          if (!restJoined) return { message: 'Usage: /sdd review <task title or number>' };

          // Number matches the same sorted order shown by /sdd tasks.
          const sorted = [...reviewTracker.getAllNodes()].sort((a, b) => {
            const order: Record<string, number> = {
              in_progress: 0,
              pending: 1,
              review: 2,
              blocked: 3,
              failed: 4,
              completed: 5,
            };
            return (order[a.status] ?? 6) - (order[b.status] ?? 6);
          });
          const match = matchTaskNode(sorted, restJoined);
          if (!match) return { message: `No task matching "${restJoined}".` };
          reviewTracker.updateNodeStatus(match.id, 'review');

          const progress = reviewTracker.getProgress();
          return {
            message: `👁 Task sent to review. (${progress.review} in review)`,
          };
        }

        case 'edit': {
          const editTracker = sddState.getTaskTracker();
          if (!editTracker) return { message: 'No tasks to edit.' };
          if (!restJoined) return { message: 'Usage: /sdd edit <N> <new title or description>' };

          // Parse: /sdd edit <N> <new content>
          const parts = restJoined.split(/\s+/);
          const num = Number(parts[0]);
          if (Number.isNaN(num))
            return { message: 'Usage: /sdd edit <N> <new title or description>' };

          const nodes = editTracker.getAllNodes();
          if (num < 1 || num > nodes.length) return { message: `Task #${num} not found.` };

          const node = nodes[num - 1];
          if (!node) return { message: `Task #${num} not found.` };

          const newContent = parts.slice(1).join(' ');
          if (!newContent) return { message: 'Provide new title or description content.' };

          // Update title if content looks like a title (short) or description if longer
          if (newContent.length < 60) {
            editTracker.updateNode(node.id, { title: newContent });
          } else {
            editTracker.updateNode(node.id, { description: newContent });
          }

          return {
            message: `✏️ Task #${num} updated: "${newContent.slice(0, 50)}${newContent.length > 50 ? '…' : ''}"`,
          };
        }

        case 'undo': {
          const undoTracker = sddState.getTaskTracker();
          if (!undoTracker) {
            return { message: 'No tasks to undo.' };
          }
          // Find the most recently completed task from transitions
          const completed = undoTracker.getAllNodes({ status: ['completed'] });
          if (completed.length === 0) {
            return { message: 'No completed tasks to undo.' };
          }
          // Pop the last completed node (most recently completed)
          const last = expectDefined(completed[completed.length - 1]);
          undoTracker.updateNodeStatus(last.id, 'pending');
          const progress = undoTracker.getProgress();
          return {
            message: `↩ Undo: "${last.title}" back to pending. (${progress.completed}/${progress.total} — ${progress.percentComplete}%)`,
          };
        }

        // ── Next Task Preview ─────────────────────────────────────────────

        case 'next': {
          const nextTracker = sddState.getTaskTracker();
          if (!nextTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const pending = nextTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          if (pending.length === 0) {
            const allDone = nextTracker.getProgress();
            if (allDone.completed === allDone.total) {
              return { message: '🎉 All tasks completed! Run /sdd status for the full summary.' };
            }
            return { message: 'No pending tasks.' };
          }

          // Find the next executable task (pending with all blockers completed)
          const next = pending.find((n) => nextTracker.canStart(n.id));
          if (!next) {
            // All pending tasks are blocked
            const blocked = pending.filter((n) => {
              const blockers = nextTracker.getBlockers(n.id);
              return blockers.some((id) => nextTracker.getNode(id)?.status !== 'completed');
            });
            if (blocked.length > 0) {
              return { message: formatBlockedTasks(blocked, nextTracker) };
            }
            return { message: 'No next task found.' };
          }

          const progress = nextTracker.getProgress();
          return {
            message: formatNextTaskView(next, progress, nextTracker, formatElapsed),
          };
        }

        // ── Session Management ─────────────────────────────────────────────

        case 'status': {
          const statusBuilder = sddState.getBuilder();
          if (!statusBuilder) {
            return { message: 'No active SDD session.' };
          }

          const session = statusBuilder.getSession();
          const progress = getTaskProgress();
          const sessionElapsed = sddState.getSessionElapsed();
          const phaseElapsed = sddState.getPhaseElapsed();

          return {
            message: formatSddStatusView(
              session,
              progress,
              sddState.getTaskTracker(),
              sessionElapsed,
              phaseElapsed,
              renderProgress,
              formatElapsed,
            ),
          };
        }

        // ── Task Graph Visualization ──────────────────────────────────────

        case 'graph': {
          const graphTracker = sddState.getTaskTracker();
          if (!graphTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const graphId = sddState.getTaskGraphId();
          if (!graphId) {
            // Show basic list view
            const nodes = graphTracker.getAllNodes();
            if (nodes.length === 0) {
              return { message: 'No tasks in the current graph.' };
            }
            const progress = graphTracker.getProgress();
            const sorted = sortTasksForSddDisplay(nodes);
            return { message: formatGraphListFallback(sorted, progress, renderProgress) };
          }

          // Try to load from store
          try {
            const graphStore = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });
            const stored = await graphStore.load(graphId);
            if (stored) {
              return { message: renderTaskGraph(stored, { compact: false }) };
            }
          } catch {
            // fall through to basic view
          }

          // Basic fallback
          const nodes = graphTracker.getAllNodes();
          if (nodes.length === 0) {
            return { message: 'No tasks in the current graph.' };
          }
          const progress = graphTracker.getProgress();
          const lines = [renderProgress(progress), ''];
          const sorted = [...nodes].sort((a, b) => {
            const order: Record<string, number> = {
              in_progress: 0,
              pending: 1,
              review: 2,
              blocked: 3,
              failed: 4,
              completed: 5,
            };
            return (order[a.status] ?? 6) - (order[b.status] ?? 6);
          });
          for (let i = 0; i < sorted.length; i++) {
            const n = expectDefined(sorted[i]);
            const status =
              n.status === 'completed'
                ? '✅'
                : n.status === 'in_progress'
                  ? '🔄'
                  : n.status === 'failed'
                    ? '❌'
                    : n.status === 'blocked'
                      ? '🚫'
                      : n.status === 'review'
                        ? '👁'
                        : '⏳';
            lines.push(`${i + 1}. ${status} [${n.priority}] ${n.title}`);
          }
          return { message: lines.join('\n') };
        }

        case 'cancel': {
          // Cancel now fully tears down: stop any live parallel run, clean its
          // worktrees, and delete every on-disk artifact (specs / task-graphs /
          // session / boards). Falls back to the old fs deletes when the host
          // didn't wire the destroy callback (e.g. a minimal test harness).
          let deletedFromDisk = false;
          if (opts.onSddDestroy) {
            const res = await opts.onSddDestroy();
            deletedFromDisk = res.deleted.length > 0 || res.worktreesRemoved > 0;
          } else {
            try {
              if (sessionPersistence) await sessionPersistence.delete();
              else await fsp.unlink(opts.paths.projectSddSession);
              deletedFromDisk = true;
            } catch {
              // No project workflow owner in minimal test harnesses.
            }
            try {
              await fsp.rm(opts.paths.projectSpecs, { recursive: true, force: true });
            } catch {
              // No specs dir
            }
            try {
              await fsp.rm(opts.paths.projectTaskGraphs, { recursive: true, force: true });
            } catch {
              // No task-graphs dir
            }
          }

          const cancelBuilder = sddState.getBuilder();
          if (cancelBuilder) {
            const title = cancelBuilder.getSession().title;
            // Mirror /sdd destroy's bounded-error handling: if the kanban
            // daemon is unreachable, the IPC delete throws, and the async
            // call would short-circuit before `setBuilder(null)` /
            // `clearTaskState()` run — leaving a stale "active" session in
            // memory that blocks every later `/sdd resume` / `new`.
            await cancelBuilder.deleteSession().catch(() => {});
            sddState.setBuilder(null);
            sddState.clearTaskState();
            return { message: `SDD session for "${title}" cancelled.` };
          }

          if (deletedFromDisk) {
            return { message: 'Stale SDD session file deleted. You can now use /sdd new.' };
          }

          return { message: 'No active SDD session.' };
        }

        case 'resume': {
          if (sddState.getBuilder()) {
            return { message: 'An SDD session is already active. Use /sdd cancel first.' };
          }

          const projectContext = await gatherProjectContext(projectRoot);

          sddState.setBuilder(
            new AISpecBuilder({
              store: specStore,
              projectContext,
              minQuestions: 2,
              maxQuestions: 10,
              ...sessionPersistenceOptions,
            }),
          );
          const resumeBuilder = expectDefined(sddState.getBuilder());
          // `sessionPersistence.load()` is an awaited IPC call against the
          // kanban daemon; when the daemon is down it rejects, and the
          // builder we just attached at line 801 would dangle — blocking
          // every later `/sdd resume`/`new` until the process restarts.
          // The legacy `sessionPath` branch inside `loadSession` swallows
          // disk errors via its own try/catch; the persistence branch does
          // not. Mirror /sdd destroy's bounded-error handling here.
          const loaded = await resumeBuilder.loadSession().catch(() => false);
          if (!loaded) {
            sddState.setBuilder(null);
            return {
              message: 'No saved SDD session found. Use /sdd new to start one.',
            };
          }

          const session = resumeBuilder.getSession();

          // Restore task graph if it exists
          let taskCount = 0;
          let completedCount = 0;
          const taskGraphId = resumeBuilder.getTaskGraphId();
          if (taskGraphId) {
            try {
              const store = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });
              const tracker = new TaskTracker({ store });
              const graph = await tracker.loadGraph(taskGraphId);
              if (graph) {
                sddState.setTaskStore(store);
                sddState.setTaskTracker(tracker);
                sddState.setTaskGraphId(taskGraphId);
                const progress = tracker.getProgress();
                taskCount = progress.total;
                completedCount = progress.completed;
              }
            } catch {
              // Task graph not found — continue without it
            }
          }

          const resumePrompt = resumeBuilder.getAIPrompt();
          return {
            message: [
              `╔═══ SDD Session Resumed ═══╗`,
              '',
              `Feature: "${session.title}"`,
              `Phase: ${session.phase}`,
              `Questions asked: ${session.questionCount}`,
              session.spec ? `Spec: ${session.spec.title}` : '',
              taskCount > 0 ? `Tasks: ${completedCount}/${taskCount} completed` : '',
              '',
              'The AI will continue from where you left off.',
            ]
              .filter(Boolean)
              .join('\n'),
            runText: `[SDD SESSION ACTIVE]\n${resumePrompt}\n\n---\nUser message:\nContinue from where we left off. Check the session status and proceed.`,
          };
        }

        // ── Spec Browsing ──────────────────────────────────────────────────

        case 'list':
        case 'ls': {
          const entries = await specStore.list();
          if (entries.length === 0) {
            return { message: 'No specs saved. Use /sdd new to create one.' };
          }

          return { message: formatSpecList(entries) };
        }

        case 'show':
        case 'view': {
          const spec = await findSpec(specStore, restJoined);
          if (!spec) return { message: `Spec "${restJoined}" not found.` };

          const parser = new SpecParser();
          const analysis = parser.analyze(spec);

          return {
            message: [
              `# ${spec.title}`,
              `Version: ${spec.version} | Status: ${spec.status}`,
              '',
              '## Overview',
              spec.overview,
              '',
              `## Requirements (${spec.requirements.length})`,
              ...spec.requirements.map((r: SpecRequirement) => {
                const tags = `[${r.type}][${r.priority}]`;
                const ac =
                  r.acceptanceCriteria.length > 0
                    ? `\n    AC: ${r.acceptanceCriteria.join(', ')}`
                    : '';
                return `- ${tags} ${r.description}${ac}`;
              }),
              '',
              renderSpecAnalysis(spec, {
                completeness: analysis.completeness,
                gaps: analysis.gaps,
                risks: analysis.risks.map((r) => r.risk),
                suggestions: analysis.suggestions,
              }),
            ].join('\n'),
          };
        }

        case 'templates': {
          const templates = listTemplates();
          const lines = templates.map(
            (t: { id: string; name: string; description: string }) =>
              `  ${t.id}: ${t.name} — ${t.description}`,
          );
          return {
            message: `Available Templates:\n${lines.join('\n')}`,
          };
        }

        case 'from': {
          const templateId = restJoined || 'feature';
          const template = getTemplate(templateId);
          if (!template) {
            return {
              message: `Template "${templateId}" not found.\nAvailable: ${listTemplates()
                .map((t: { id: string }) => t.id)
                .join(', ')}`,
            };
          }

          const skeleton = templateToMarkdown(template, 'New Specification');
          const spec = await specStore.createDraft('New Specification');
          await specStore.update(spec.id, { sections: [] });

          return {
            message: [
              `Created draft spec from template "${template.name}".`,
              `ID: ${spec.id}`,
              '',
              'Edit the spec through the AI conversation or /sdd show to review.',
              '',
              skeleton,
            ].join('\n'),
          };
        }

        case 'version':
        case 'history': {
          const spec = await findSpec(specStore, restJoined);
          if (!spec) return { message: `Spec "${restJoined}" not found.` };

          const history = versioning.getHistory(spec.id);
          if (history.length === 0) {
            return {
              message: `No version history for "${spec.title}".`,
            };
          }

          const lines = history.map(
            (v: SpecVersion, i: number) =>
              `${i + 1}. v${v.version} — ${new Date(v.timestamp).toISOString()}${v.changeDescription ? ` (${v.changeDescription})` : ''}`,
          );
          return {
            message: `Version History for "${spec.title}":\n${lines.join('\n')}`,
          };
        }

        case 'critical':
        case 'bottleneck': {
          const critTracker = sddState.getTaskTracker();
          if (!critTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const graphId = sddState.getTaskGraphId();
          if (!graphId) {
            return { message: 'No task graph found. Generate tasks first.' };
          }

          try {
            const graphStore = new TaskGraphStore({ baseDir: opts.paths.projectTaskGraphs });
            const graph = await graphStore.load(graphId);
            if (!graph) {
              return { message: 'Could not load task graph.' };
            }

            const analysis = analyzeCriticalPath(graph);
            return { message: formatCriticalPathAnalysis(graph, analysis) };
          } catch {
            return { message: 'Could not analyze critical path.' };
          }
        }

        default:
          return {
            message: `${unknownSubcommand(cmd, SDD_KNOWN_SUBCOMMANDS, 'sdd')}\n\n${sddHelp()}`,
          };
      }
    },
  };
}
