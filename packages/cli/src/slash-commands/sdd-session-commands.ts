import * as fsp from 'node:fs/promises';
import type { SlashCommand } from '@wrongstack/contracts/types';
import { expectDefined } from '@wrongstack/core/utils';
import { AISpecBuilder, TaskGraphStore, TaskTracker } from '@wrongstack/sdd';
import { gatherProjectContext } from '../services/sdd/project-context.js';
import { sddState } from '../services/sdd/state.js';
import { advanceToNextTask } from '../services/sdd/task-manager.js';
import { formatExistingSddSessionMessage } from './sdd-command-helpers.js';
export async function runSddSessionCommand(inputs: {
  cmd: string;
  restArgs: string[];
  sessionState: import('../services/sdd/state.js').SDDState;
  projectRoot: string;
  specStore: import('@wrongstack/sdd').SpecStore;
  sessionPersistenceOptions:
    | {
        sessionPersistence: import('@wrongstack/sdd').AISpecSessionPersistence;
        sessionPath?: never;
      }
    | { sessionPath: string; sessionPersistence?: never };
  opts: import('./command-context.js').SlashCommandContext;
  versioning: import('@wrongstack/sdd').SpecVersioning;
  sessionPersistence: import('@wrongstack/sdd').AISpecSessionPersistence | undefined;
}): ReturnType<SlashCommand['run']> {
  const {
    cmd,
    restArgs,
    sessionState,
    projectRoot,
    specStore,
    sessionPersistenceOptions,
    opts,
    versioning,
    sessionPersistence,
  } = inputs;
  if (!opts.paths) return { message: 'SDD not available — paths not configured.' };

  switch (cmd) {
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

      // Reset task state from previous session only after its queued graph writes settle.
      await sddState.flushTaskWrites();
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

    case 'cancel': {
      // TaskTracker mutations persist in the background. Drain the owning store
      // before onSddDestroy or the fallback path removes its task-graph directory.
      await sddState.flushTaskWrites();

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
  }
  throw new Error('Unhandled delegated case');
}
