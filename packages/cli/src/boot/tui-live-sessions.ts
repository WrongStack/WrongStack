/**
 * TUI live sessions callbacks — extracted from the runTui() options literal.
 *
 * Phase C step 4. getLiveSessions queries the SessionRegistry for live
 * sessions across all projects; onSwitchToSession records a pending
 * project switch for the spawn-after-exit path.
 *
 * Reads mutable state (wpaths, pendingProjectSwitch) through TuiRuntimeState.
 */
import * as path from 'node:path';
import type { TuiRuntimeState } from './tui-runtime-state.js';

interface LiveSessionsContext {
  state: TuiRuntimeState;
}

/**
 * List live sessions from the global SessionRegistry.
 * Filters out 'stale' entries. Called when the F10 sessions panel opens.
 */
export async function getLiveSessions(ctx: LiveSessionsContext) {
  const { getSessionRegistry } = await import('@wrongstack/core/storage');
  const globalRoot = path.dirname(ctx.state.wpaths.globalConfig);
  const registry = getSessionRegistry(globalRoot);
  const sessions = await registry.list();
  return sessions
    .filter((s) => s.status !== 'stale')
    .map((s) => ({
      sessionId: s.sessionId,
      projectName: s.projectName,
      projectSlug: s.projectSlug,
      projectRoot: s.projectRoot,
      workingDir: s.workingDir,
      gitBranch: s.gitBranch,
      status: s.status,
      pid: s.pid,
      startedAt: s.startedAt,
      agentCount: s.agentCount,
      agents: s.agents.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        currentTool: a.currentTool,
        iterations: a.iterations,
        toolCalls: a.toolCalls,
        lastActivityAt: a.lastActivityAt,
      })),
    }));
}

/**
 * Record a pending project switch for a live session.
 *
 * Deliberately NOT `--resume <sessionId>`: the F10 panel lists LIVE
 * sessions (their owner processes are alive — 'stale' is filtered out),
 * and resuming one would put two processes on the same session JSONL.
 * We open the target project fresh instead.
 */
export function onSwitchToSession(
  ctx: LiveSessionsContext,
  _sessionId: string,
  targetRoot: string,
  projectName: string,
): void {
  ctx.state.pendingProjectSwitch = { root: targetRoot, name: projectName };
}
