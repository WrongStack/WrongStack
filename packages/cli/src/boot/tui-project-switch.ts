/**
 * switchProjectInPlace — extracted from the TUI branch of execute().
 *
 * Phase B step 2. Re-roots the live TUI process to a new project: new
 * paths, session store, writer, rebuilt system prompt, old session
 * close, recovery lock re-point, project.switched event emission.
 *
 * All mutable state mutations go through `state.*` (TuiRuntimeState).
 * The caller syncs locals back after the TUI branch ends.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Agent,
  type Config,
  type Context,
  type EventBus,
  DefaultSessionStore,
  DefaultSystemPromptBuilder,
  type MemoryStore,
  type ModeStore,
  RecoveryLock,
  resolveWstackPaths,
  sessionScopedPath,
  setQueuedMessagesSnapshot,
} from '@wrongstack/core';
import type { TuiRuntimeState } from './tui-runtime-state.js';
import type { SkillLoader } from '@wrongstack/core';

export interface ProjectSwitchContext {
  state: TuiRuntimeState;
  context: Context;
  events: EventBus;
  agent: Agent;
  config: Config;
  tokenCounter: import('@wrongstack/core').TokenCounter;
  modeId: string | undefined;
  modeStore: ModeStore | undefined;
  memoryStore: MemoryStore | undefined;
  skillLoader: SkillLoader | undefined;
  /** attachTodosCheckpoint — from execute() scope. */
  attachTodosCheckpoint: (
    state: import('@wrongstack/core').ConversationState,
    todosPath: string,
    sessionId: string,
    events: EventBus,
    traceId: string | undefined,
  ) => () => void;
}

/**
 * Re-root the live TUI process to a new project directory.
 *
 * Returns `null` on success, or an error message string on failure.
 * Mutates `state.*` (projectRoot, wpaths, activeSessionStore,
 * activeRecoveryLock, detachActiveTodosCheckpoint).
 */
export async function switchProjectInPlace(
  ctx: ProjectSwitchContext,
  targetRoot: string,
  displayName: string,
): Promise<string | null> {
  const { state, context, events, agent, config, tokenCounter, modeId, modeStore, memoryStore, skillLoader, attachTodosCheckpoint } = ctx;

  const resolved = path.resolve(targetRoot);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) return `Cannot switch: not a directory: ${resolved}`;

  const oldWriter = context.session;
  const oldUsage = tokenCounter.total();
  const oldRecoveryLock = state.activeRecoveryLock;
  const oldProjectRoot = state.projectRoot;
  const nextWpaths = resolveWstackPaths({ projectRoot: resolved, globalRoot: state.wpaths.globalRoot });
  await fs.mkdir(nextWpaths.projectSessions, { recursive: true });
  const nextSessionStore = new DefaultSessionStore({ dir: nextWpaths.projectSessions });
  const nextWriter = await nextSessionStore.create({
    id: '',
    title: '',
    model: context.model,
    provider: (context.provider as { id?: string }).id ?? config.provider,
  });

  state.detachActiveTodosCheckpoint?.();
  process.chdir(resolved);
  state.projectRoot = resolved;
  state.wpaths = nextWpaths;
  state.activeSessionStore = nextSessionStore;
  state.activeRecoveryLock = new RecoveryLock({ dir: nextWpaths.projectSessions, sessionStore: nextSessionStore });

  context.cwd = resolved;
  context.projectRoot = resolved;
  context.workingDir = resolved;
  context.session = nextWriter;
  context.state.replaceMessages([]);
  context.state.replaceTodos([]);
  context.clearFileTracking();
  context.tokenCounter.reset();
  context.meta['packageTrackerOpts'] = { storageDir: nextWpaths.projectDir, projectRoot: resolved };
  context.state.setMeta('plan.path', sessionScopedPath(nextWpaths.projectSessions, nextWriter.id, '.plan.json'));
  context.state.setMeta('task.path', sessionScopedPath(nextWpaths.projectSessions, nextWriter.id, '.tasks.json'));
  state.detachActiveTodosCheckpoint = attachTodosCheckpoint(
    context.state,
    sessionScopedPath(nextWpaths.projectSessions, nextWriter.id, '.todos.json'),
    nextWriter.id,
    events,
    context.traceId,
  );
  setQueuedMessagesSnapshot(context, []);

  try {
    const switchMode =
      modeId && modeId !== 'default' && modeStore
        ? await modeStore.getMode(modeId)
        : undefined;
    const switchBuilder = new DefaultSystemPromptBuilder({
      memoryStore: memoryStore ?? undefined,
      skillLoader,
      modeStore,
      modeId: modeId ?? 'default',
      modePrompt: switchMode?.prompt ?? '',
      instructionPaths: {
        globalDir: nextWpaths.globalInstructions,
        projectDir: nextWpaths.inProjectInstructions,
      },
    });
    context.systemPrompt = await switchBuilder.build({
      cwd: resolved,
      projectRoot: resolved,
      tools: agent.tools.list(),
      provider: (context.provider as { id?: string }).id,
      model: context.model,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'execution.project_switch_prompt_rebuild_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  void (async () => {
    try {
      await oldWriter.append({ type: 'session_end', ts: new Date().toISOString(), usage: oldUsage });
      await oldWriter.close();
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'execution.project_switch_old_session_close_failed',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    await oldRecoveryLock.clear().catch(() => undefined);
  })();

  try {
    await state.activeRecoveryLock.write(nextWriter.id);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'execution.project_switch_recovery_lock_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  const emitUntyped = events.emit as never as (event: string, payload: unknown) => void;
  emitUntyped('project.switched', { from: oldProjectRoot, to: resolved, name: displayName });
  return null;
}
