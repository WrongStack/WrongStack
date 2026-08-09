/**
 * TUI project picker callbacks — extracted from the runTui() options literal.
 *
 * Phase C step 3. getProjectPickerItems loads project items from the
 * global manifest; onProjectSelect re-roots the live TUI process to the
 * selected project via switchProjectInPlace, with warnings for active
 * background work.
 *
 * Reads mutable state (projectRoot, wpaths) from TuiRuntimeState.
 */
import * as path from 'node:path';
import type { Director } from '@wrongstack/core/coordination';
import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from '../renderer.js';
import type { ProjectSwitchContext } from './tui-project-switch.js';
import type { TuiRuntimeState } from './tui-runtime-state.js';

export interface ProjectPickerContext {
  state: TuiRuntimeState;
  renderer: TerminalRenderer;
  director: Director | null | undefined;
  getEternalEngine: (() => { currentState: string } | null) | undefined;
  getParallelEngine: (() => { currentState: string } | null) | undefined;
  switchCtx: ProjectSwitchContext;
  switchProjectInPlace: (targetRoot: string, displayName: string) => Promise<string | null>;
}

/**
 * Load project picker items from the global manifest.
 * Called each time the project picker panel opens (F1).
 */
export async function getProjectPickerItems(ctx: ProjectPickerContext) {
  const { buildPickerItems } = await import('../project-picker.js');
  return buildPickerItems({
    globalConfigPath: ctx.state.wpaths.globalConfig,
    currentProjectRoot: ctx.state.projectRoot,
  });
}

/**
 * Called when the user selects a project in the picker.
 * Re-roots the live TUI process in place: new Context root, fresh
 * per-project session writer, rebuilt system prompt, and no spawned
 * replacement process.
 */
export async function onProjectSelect(
  ctx: ProjectPickerContext,
  slug: string,
  kind: 'project' | 'action',
): Promise<void> {
  const { state, renderer, director, getEternalEngine, getParallelEngine, switchProjectInPlace } =
    ctx;

  try {
    if (kind === 'action') {
      if (slug === 'new-session') {
        const name = path.basename(state.projectRoot) || state.projectRoot;
        const err = await switchProjectInPlace(state.projectRoot, name);
        if (err) renderer.write(color.red(`Project switch failed: ${err}\n`));
      }
      // prev-sessions is handled inside the TUI (/resume picker).
      return;
    }

    const { loadManifest, saveManifest } = await import('../services/project-manifest.js');
    const manifest = await loadManifest(state.wpaths.globalConfig);
    const project = manifest.projects.find((p) => p.slug === slug);
    if (!project) return;

    const targetRoot = path.resolve(project.root);
    if (path.resolve(state.projectRoot) === targetRoot) return;

    const fleetStatus = director?.status();
    const fleetRunning = fleetStatus?.subagents.filter((a) => a.status === 'running').length ?? 0;
    const eternalActive = getEternalEngine?.()?.currentState === 'running';
    const parallelActive = getParallelEngine?.()?.currentState === 'running';
    const hasActiveAgents = fleetRunning > 0 || eternalActive || parallelActive;

    if (hasActiveAgents) {
      const parts: string[] = [
        color.yellow(
          '⚠  Switching project in place; active background work is still tied to the previous project:',
        ),
      ];
      if (fleetRunning > 0)
        parts.push(color.dim(`  • ${fleetRunning} subagent(s) currently running`));
      if (eternalActive) parts.push(color.dim('  • Eternal engine is active'));
      if (parallelActive) parts.push(color.dim('  • Parallel engine is active'));
      parts.push('');
      parts.push(color.dim(`  New project: ${project.name}`));
      renderer.write(`\n${parts.join('\n')}\n`);
    }

    project.lastSeen = new Date().toISOString();
    await saveManifest(manifest, state.wpaths.globalConfig);

    const err = await switchProjectInPlace(targetRoot, project.name);
    if (err) renderer.write(color.red(`Project switch failed: ${err}\n`));
  } catch (err) {
    renderer.write(
      color.red(`Project switch failed: ${err instanceof Error ? err.message : String(err)}\n`),
    );
  }
}
