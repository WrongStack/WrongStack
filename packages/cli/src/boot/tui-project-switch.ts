/**
 * switchProjectInPlace — extracted from the TUI branch of execute().
 *
 * Phase B step 2. Re-roots the live TUI process to a new project: new
 * paths, session store, writer, rebuilt system prompt, old session
 * close and project.switched event emission.
 *
 * All mutable state mutations go through `state.*` (TuiRuntimeState).
 * The caller syncs locals back after the TUI branch ends.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Agent,
  type Context,
  DefaultSystemPromptBuilder,
  setQueuedMessagesSnapshot,
} from '@wrongstack/core/agent';
import { type EventBus, TOKENS } from '@wrongstack/core/kernel';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type { Config, MemoryPort, ModeStore, SkillLoader } from '@wrongstack/core/types';
import {
  activateProjectStateGuard,
  resolveWstackPaths,
  sessionScopedPath,
} from '@wrongstack/core/utils';
import type { TuiRuntimeState } from './tui-runtime-state.js';

export interface ProjectSwitchContext {
  state: TuiRuntimeState;
  context: Context;
  events: EventBus;
  agent: Agent;
  config: Config;
  tokenCounter: import('@wrongstack/core/types').TokenCounter;
  modeId: string | undefined;
  modeStore: ModeStore | undefined;
  memoryStore: MemoryPort | undefined;
  skillLoader: SkillLoader | undefined;
  /** attachTodosCheckpoint — from execute() scope. */
  attachTodosCheckpoint: (
    state: import('@wrongstack/core/agent').ConversationState,
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
 * detachActiveTodosCheckpoint).
 */
export async function switchProjectInPlace(
  ctx: ProjectSwitchContext,
  targetRoot: string,
  displayName: string,
): Promise<string | null> {
  const {
    state,
    context,
    events,
    agent,
    config,
    tokenCounter,
    modeId,
    modeStore,
    memoryStore,
    skillLoader,
    attachTodosCheckpoint,
  } = ctx;

  const resolved = path.resolve(targetRoot);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) return `Cannot switch: not a directory: ${resolved}`;

  const oldWriter = context.session;
  const oldSessionStore = state.activeSessionStore;
  const oldUsage = tokenCounter.total();
  const oldProjectRoot = state.projectRoot;
  const nextWpaths = resolveWstackPaths({
    projectRoot: resolved,
    globalRoot: state.wpaths.globalRoot,
  });
  await fs.mkdir(nextWpaths.projectSessions, { recursive: true });
  const nextSessionStore = new DefaultSessionStore({
    dir: nextWpaths.projectSessions,
    projectRoot: resolved,
  });
  const nextWriter = await nextSessionStore.create({
    id: '',
    title: '',
    model: context.model,
    provider: (context.provider as { id?: string }).id ?? config.provider,
  });
  const previousCwd = process.cwd();
  try {
    process.chdir(resolved);
    process.chdir(previousCwd);
  } catch (err) {
    await nextWriter.close().catch(() => undefined);
    await nextSessionStore.delete(nextWriter.id).catch(() => undefined);
    await nextSessionStore.dispose?.();
    return `Cannot switch: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!state.activateSessionIdentity) {
    await nextWriter.close().catch(() => undefined);
    await nextSessionStore.delete(nextWriter.id).catch(() => undefined);
    await nextSessionStore.dispose?.();
    return 'Cannot switch: session ownership registry is unavailable.';
  }
  let targetClaim: import('@wrongstack/core/storage').SessionResumeClaim | undefined;
  let targetActivated = false;
  try {
    const { getSessionRegistry } = await import('@wrongstack/core/storage');
    const registry = getSessionRegistry(state.wpaths.globalRoot);
    targetClaim = await registry.reserveResume({
      sessionId: nextWriter.id,
      projectSlug: nextWpaths.projectSlug,
      projectRoot: resolved,
    });
    const target = {
      projectSlug: nextWpaths.projectSlug,
      projectRoot: resolved,
      projectName: displayName || path.basename(resolved),
      workingDir: resolved,
    };
    await targetClaim.activate({
      sessionId: nextWriter.id,
      ...target,
      clientType: 'tui',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    targetActivated = true;
    await state.activateSessionIdentity(nextWriter.id, target);
    await activateProjectStateGuard(resolved);
  } catch (err) {
    if (!targetActivated) await targetClaim?.cancel().catch(() => undefined);
    else if (oldWriter) {
      await state
        .activateSessionIdentity(oldWriter.id, {
          projectSlug: state.wpaths.projectSlug,
          projectRoot: oldProjectRoot,
          projectName: path.basename(oldProjectRoot),
          workingDir: context.workingDir,
        })
        .catch(() => undefined);
    }
    await nextWriter.close().catch(() => undefined);
    await nextSessionStore.delete(nextWriter.id).catch(() => undefined);
    await nextSessionStore.dispose?.();
    return `Cannot switch: ${err instanceof Error ? err.message : String(err)}`;
  }

  await Promise.resolve(state.detachActiveTodosCheckpoint?.()).catch(() => undefined);
  process.chdir(resolved);
  state.projectRoot = resolved;
  state.wpaths = nextWpaths;
  state.activeSessionStore = nextSessionStore;

  context.cwd = resolved;
  context.projectRoot = resolved;
  context.workingDir = resolved;
  context.session = nextWriter;
  context.state.replaceMessages([]);
  context.state.replaceTodos([]);
  context.clearFileTracking();
  context.clearMemoryEvidence?.();
  context.tokenCounter.reset();
  context.meta['packageTrackerOpts'] = { storageDir: nextWpaths.projectDir, projectRoot: resolved };
  context.state.setMeta(
    'plan.path',
    sessionScopedPath(nextWpaths.projectSessions, nextWriter.id, '.plan.json'),
  );
  context.state.setMeta(
    'task.path',
    sessionScopedPath(nextWpaths.projectSessions, nextWriter.id, '.tasks.json'),
  );
  try {
    state.detachActiveTodosCheckpoint = attachTodosCheckpoint(
      context.state,
      sessionScopedPath(nextWpaths.projectSessions, nextWriter.id, '.todos.json'),
      nextWriter.id,
      events,
      context.traceId,
    );
  } catch {
    state.detachActiveTodosCheckpoint = undefined;
  }
  setQueuedMessagesSnapshot(context, []);

  try {
    const switchMode =
      modeId && modeId !== 'default' && modeStore ? await modeStore.getMode(modeId) : undefined;
    const switchBuilder = new DefaultSystemPromptBuilder({
      memoryStore: memoryStore ?? undefined,
      // Single injection channel: SAGE turn middleware, not a static section.
      injectMemory: false,
      skillLoader,
      modeStore,
      modeId: modeId ?? 'default',
      modePrompt: switchMode?.prompt ?? '',
      tokenSavingMode: config.features?.tokenSavingMode,
      modelCapabilities: {
        maxContextTokens: context.provider?.capabilities?.maxContext,
        supportsTools: !!context.provider?.capabilities?.tools,
        supportsVision: !!context.provider?.capabilities?.vision,
        supportsReasoning: !!context.provider?.capabilities?.reasoning,
      },
      instructionPaths: {
        globalDir: nextWpaths.globalInstructions,
        projectDir: nextWpaths.inProjectInstructions,
        systemVariant: config.systemPrompt?.variant,
      },
    });
    context.systemPrompt = await switchBuilder.build({
      cwd: resolved,
      projectRoot: resolved,
      tools:
        typeof agent.tools?.listForProvider === 'function'
          ? agent.tools.listForProvider()
          : typeof agent.tools?.list === 'function'
            ? agent.tools.list()
            : [],
      catalogTools: typeof agent.tools?.list === 'function' ? agent.tools.list() : [],
      provider: (context.provider as { id?: string }).id,
      model: context.model,
    });
    if (agent.container?.has?.(TOKENS.SystemPromptBuilder)) {
      agent.container.override(TOKENS.SystemPromptBuilder, () => switchBuilder, {
        owner: 'tui-project-switch',
      });
    }
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
  await oldSessionStore?.dispose?.().catch(() => undefined);
  const emitUntyped = events.emit as never as (event: string, payload: unknown) => void;
  emitUntyped('project.switched', { from: oldProjectRoot, to: resolved, name: displayName });
  return null;
}
