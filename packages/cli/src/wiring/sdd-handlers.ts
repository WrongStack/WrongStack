/**
 * SDD handler factory — extracted from cli-main.ts to reduce file size.
 *
 * Contains all SDD-related callback handlers that were inline in main():
 *   - onSddParallelRun (worktree detection, conflict resolver, run execution)
 *   - onSddParallelStop / onSddRetryAllFailed / onSddSplitTask
 *   - onSddCleanWorktrees / onSddRollback / onSddDestroy
 *
 * Each handler closes over the shared session state passed in via the
 * options object, so the extraction is purely mechanical — no behavior
 * changes.
 *
 * Returns a partial object that is spread into the SlashCommandContext
 * at the call site. The types are intentionally loose here to avoid
 * importing the full SlashCommandContext type (which would create a
 * circular dependency). The call site casts via `as never`.
 */
import { spawn } from 'node:child_process';
import { color } from '@wrongstack/core/utils';

type SddParallelRunGlobal = typeof globalThis & {
  __sddParallelRun?: import('@wrongstack/sdd').SddParallelRun | undefined;
};

// biome-ignore lint/suspicious/noExplicitAny: intentional loose typing for extraction boundary
export function createSddHandlers(deps: Record<string, any>): Record<string, (...args: never[]) => unknown> {
  const {
    wpaths,
    projectRoot,
    events,
    sessionRef,
    session,
    renderer,
    multiAgentHost,
    config,
    brain,
    agent,
    sddRunRegistry,
    getSddRuntimeState,
  } = deps;

  const onSddParallelRun = async (opts?: { parallelSlots?: number | undefined }): Promise<string> => {
    const { tracker, builder, graphId } = await getSddRuntimeState();
    if (!tracker || !builder) {
      return 'No active SDD session with tasks. Use /sdd new to start one.';
    }
    const builderSession = builder.getSession();
    if (builderSession.phase !== 'executing' && builderSession.phase !== 'task_review') {
      return `Cannot run parallel in phase "${builderSession.phase}". Use /sdd approve first.`;
    }
    const graphStore = new (await import('@wrongstack/sdd')).TaskGraphStore({
      baseDir: wpaths.projectTaskGraphs,
    });
    const graph = graphId ? await graphStore.load(graphId) : null;
    if (!graph) {
      return 'No task graph found for the current SDD session.';
    }
    const agentCore = await import('@wrongstack/core/agent');
    const worktreeCore = await import('@wrongstack/core/worktree');
    const sddApi = await import('@wrongstack/sdd');

    // Per-task git-worktree isolation.
    let worktrees: import('@wrongstack/core/worktree').WorktreeManager | undefined;
    if (process.env['WRONGSTACK_SDD_WORKTREES'] !== '0') {
      const inGit = await new Promise<boolean>((resolve) => {
        let resolved = false;
        const settle = (v: boolean): void => {
          if (resolved) return;
          resolved = true;
          resolve(v);
        };
        try {
          const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: projectRoot,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          // Bound the probe — a wedged git or stuck filesystem must not hang
          // the entire SDD parallel-run command. 5s is generous for
          // rev-parse (typically <50ms) while providing a hard escape hatch.
          const timer = setTimeout(() => {
            child.kill();
            settle(false);
          }, 5000);
          const chunks: string[] = [];
          child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString()));
          child.on('error', () => {
            clearTimeout(timer);
            settle(false);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            settle(code === 0 && chunks.join('').trim() === 'true');
          });
        } catch {
          settle(false);
        }
      });
      if (inGit) {
        await sddApi
          .cleanupStaleSddWorktrees({ projectRoot, boardsDir: wpaths.projectSddBoards })
          .catch(() => undefined);
        worktrees = new worktreeCore.WorktreeManager({
          projectRoot,
          events,
          sessionId: () => sessionRef.current?.id ?? session.id,
        });
      }
    }

    const boardStore = new sddApi.SddBoardStore({ baseDir: wpaths.projectSddBoards });

    const sddSupervisor = new sddApi.SddSupervisor({
      brain,
      reassignModels: agentCore.effectiveFallbackChain(config),
    });

    const sddSubagentFactory = multiAgentHost.makeSubagentFactory(config);

    // Composite completion gate: deterministic command check + LLM
    // acceptance-criteria judge (isolated read-only turn; degrades open on
    // judge errors so a flaky judge can never wedge the run).
    let verifySeq = 0;
    const verifyTask = sddApi.makeCompositeVerifier([
      sddApi.makeCommandVerifier(),
      sddApi.makeAcceptanceCriteriaVerifier({
        run: async (prompt: string): Promise<string> => {
          const r = await sddSubagentFactory({
            id: `sdd-acceptance-${verifySeq++}`,
            role: 'executor',
            name: 'Acceptance Reviewer',
            disabledTools: ['delegate', 'write', 'edit', 'patch', 'bash', 'exec'],
            allowedCapabilities: ['fs.read'],
          });
          try {
            const res = await r.agent.run([{ type: 'text', text: prompt }]);
            return res.finalText ?? '';
          } finally {
            await r.dispose?.();
          }
        },
      }),
    ]);

    const conflictMode = process.env['WRONGSTACK_SDD_CONFLICT_RESOLVER'];
    const conflictResolver =
      conflictMode === 'prefer-incoming'
        ? sddApi.makePreferSideConflictResolver('incoming')
        : conflictMode === 'prefer-base'
          ? sddApi.makePreferSideConflictResolver('base')
          : conflictMode === 'llm'
            ? sddApi.makeLlmConflictResolver({
                run: async (prompt: string): Promise<string> => {
                  const r = await sddSubagentFactory({
                    id: `sdd-conflict-${Date.now()}`,
                    role: 'executor',
                    name: 'Conflict Resolver',
                    disabledTools: ['delegate'],
                    allowedCapabilities: ['fs.read', 'net.outbound'],
                  });
                  try {
                    const res = await r.agent.run([{ type: 'text', text: prompt }]);
                    return res.finalText ?? '';
                  } finally {
                    await r.dispose?.();
                  }
                },
              })
            : undefined;

    const handle = sddApi.startSddRun({
      tracker,
      graph,
      agent,
      projectRoot,
      events,
      sessionId: () => sessionRef.current?.id ?? session.id,
      parallelSlots: opts?.parallelSlots,
      subagentFactory: sddSubagentFactory,
      worktrees,
      boardStore,
      registry: sddRunRegistry,
      verifyTask,
      conflictResolver,
      superviseFailure: sddSupervisor.superviseFailure,
      onProgress: (p: import('@wrongstack/sdd').SddProgress) => {
        renderer.write(
          `  ░ wave ${p.wave + 1} · ${p.completed}/${p.total} tasks · ${p.percent}% done\n`,
        );
      },
    });
    (globalThis as SddParallelRunGlobal).__sddParallelRun = handle.run;
    try {
      const result = await handle.completion;
      const lines = [
        `SDD parallel run complete:`,
        `  ${result.totalWaves} waves · ${result.totalCompleted} done · ${result.totalFailed} failed`,
        `  ${(result.totalDurationMs / 1000).toFixed(1)}s total`,
      ];
      if (result.deadlocked)
        lines.push(color.red('  ⚠ deadlock — tasks blocked by failed tasks.'));
      if (result.stopRequested) lines.push(color.yellow('  ⚡ stopped by user.'));
      return lines.join('\n');
    } finally {
      (globalThis as SddParallelRunGlobal).__sddParallelRun = undefined;
    }
  };

  return {
    onSddParallelRun,
    onSddParallelStop: () => {
      const run = (globalThis as SddParallelRunGlobal).__sddParallelRun;
      run?.stop();
    },
    onSddRetryAllFailed: () => sddRunRegistry.getActive()?.retryAllFailed() ?? 0,
    onSddSplitTask: (taskId: string, subtasks: Array<{ title: string; description: string }>): string[] | null => {
      const active = sddRunRegistry.getActive();
      if (!active) return null;
      const snap = active.snapshot();
      const match = snap.tasks.find((t: { id: string; shortId?: string }) => t.id === taskId || t.shortId === taskId);
      const ids = active.splitTask(match?.id ?? taskId, subtasks);
      return ids.length ? ids : null;
    },
    onSddCleanWorktrees: async (): Promise<number> => {
      const active = sddRunRegistry.getActive();
      if (active) return active.cleanupWorktrees();
      const sddApi = await import('@wrongstack/sdd');
      const { removed } = await sddApi.cleanupSddWorktrees(projectRoot);
      return removed;
    },
    onSddRollback: async () => {
      const active = sddRunRegistry.getActive();
      if (active) return active.rollback();
      const sddApi = await import('@wrongstack/sdd');
      return sddApi.rollbackSddRunFromDisk({ projectRoot, boardsDir: wpaths.projectSddBoards });
    },
    onSddDestroy: async (destroyOpts?: { revertMerged?: boolean | undefined }) => {
      sddRunRegistry.getActive()?.stop();
      const sddApi = await import('@wrongstack/sdd');
      return sddApi.destroySddProject({
        projectRoot,
        revertMerged: destroyOpts?.revertMerged === true,
        paths: {
          projectSpecs: wpaths.projectSpecs,
          projectTaskGraphs: wpaths.projectTaskGraphs,
          projectSddSession: wpaths.projectSddSession,
          projectSddBoards: wpaths.projectSddBoards,
        },
      });
    },
  };
}
