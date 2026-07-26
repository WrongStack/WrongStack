import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ChimeraCascadeNeededPayload,
  ChimeraReviewNeededPayload,
} from '@wrongstack/core/plugin';
import type { StopReason, SubagentConfig } from '@wrongstack/core/types';
import { buildChimeraCascadeTaskDescription } from './chimera-review-task.js';
import type { ExecuteDeps } from './execute-deps.js';

type Director = NonNullable<ExecuteDeps['fleet']['director']>;
type Events = ExecuteDeps['core']['events'];
type Session = ExecuteDeps['session']['session'];

type PendingChimeraWork = Promise<void> | undefined;

export type InstallChimeraCascadeHandlerOptions = {
  events: Events;
  director: Director | null | undefined;
  session: Session;
  getPendingWork: () => PendingChimeraWork;
  setPendingWork: (work: PendingChimeraWork) => void;
};

export function installChimeraCascadeHandler({
  events,
  director,
  session,
  getPendingWork,
  setPendingWork,
}: InstallChimeraCascadeHandlerOptions): void {
  events.onPattern('chimera.cascade_needed', (_event, payload) => {
    const p = payload as ChimeraCascadeNeededPayload;
    const dir = director;
    if (!dir) return; // Director not available — cascade skipped.
    if (p.agents.length === 0) return;

    const previousWork = getPendingWork();

    // Track in pending work so the execution finally block awaits cascade
    // completion before session.close(). Chain onto any prior in-flight
    // work so cascades run after their parent review, not concurrently.
    const pendingWork = (async () => {
      // Await any prior pending work (the parent review) before spawning.
      try {
        await previousWork;
      } catch {
        // Parent failed — proceed with cascade anyway; the review text
        // is carried in the payload, independent of subagent success.
      }

      for (const agentKind of p.agents) {
        try {
          const taskDesc = buildChimeraCascadeTaskDescription(agentKind, p);
          const role = agentKind === 'security-scanner' ? 'security-scanner' : 'bug-hunter';
          const cfg: SubagentConfig = {
            name: `chimera-cascade-${agentKind}`,
            role,
            maxIterations: 40,
            maxToolCalls: 200,
            timeoutMs: 600_000,
          };
          const subagentId = await dir.spawn(cfg);
          const taskId = randomUUID();
          await dir.assign({ id: taskId, description: taskDesc, subagentId });
          const results = await dir.awaitTasks([taskId]);
          const result = results[0];

          if (result?.status === 'success') {
            const resultText =
              typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            await session.append({
              type: 'llm_response',
              ts: new Date().toISOString(),
              content: [
                {
                  type: 'text',
                  text: `🦂 Chimera cascade (${agentKind}) — ${resultText}`,
                },
              ],
              stopReason: 'end_turn' as StopReason,
              usage: { input: 0, output: 0 },
            });
          } else {
            await session.append({
              type: 'error',
              ts: new Date().toISOString(),
              message: `🦂 Chimera cascade (${agentKind}) ${result?.status ?? 'unknown'}: ${result?.error?.message ?? 'no result'}`,
              phase: 'agent',
            });
          }
        } catch (err) {
          await session.append({
            type: 'error',
            ts: new Date().toISOString(),
            message: `🦂 Chimera cascade (${agentKind}) failed: ${err instanceof Error ? err.message : String(err)}`,
            phase: 'agent',
          });
        }
      }

      await maybeReReviewCascade({ events, session, bundle: p.bundle });
    })();

    setPendingWork(pendingWork);
  });
}

async function maybeReReviewCascade({
  events,
  session,
  bundle,
}: {
  events: Events;
  session: Session;
  bundle: ChimeraCascadeNeededPayload['bundle'];
}): Promise<void> {
  // After the cascade fix agents finish, re-read the (now possibly modified)
  // files and re-emit chimera.review_needed to trigger a fresh review. The
  // loop is bounded by maxCascadeDepth.
  const maxDepth = bundle.maxCascadeDepth ?? 0;
  const currentDepth = bundle.cascadeDepth ?? 0;
  if (maxDepth > 0 && currentDepth < maxDepth) {
    try {
      const reReadFiles: ChimeraReviewNeededPayload['files'] = [];
      for (const f of bundle.files) {
        try {
          const absPath = path.join(bundle.cwd, f.path);
          const content = await fsp.readFile(absPath, 'utf8');
          reReadFiles.push({ path: f.path, status: 'modified', content });
        } catch {
          // File deleted or unreadable — skip it.
        }
      }

      if (reReadFiles.length > 0) {
        const reReviewBundle: ChimeraReviewNeededPayload = {
          ...bundle,
          files: reReadFiles,
          cascadeDepth: currentDepth + 1,
        };

        await session.append({
          type: 'llm_response',
          ts: new Date().toISOString(),
          content: [
            {
              type: 'text',
              text: `🦂 Chimera cascade re-review (depth ${currentDepth + 1}/${maxDepth}) — re-reviewing ${reReadFiles.length} file(s) after fixes`,
            },
          ],
          stopReason: 'end_turn' as StopReason,
          usage: { input: 0, output: 0 },
        });

        events.emitCustom('chimera.review_needed', reReviewBundle);
      }
    } catch (err) {
      await session.append({
        type: 'error',
        ts: new Date().toISOString(),
        message: `🦂 Chimera cascade re-review failed: ${err instanceof Error ? err.message : String(err)}`,
        phase: 'agent',
      });
    }
  } else if (maxDepth > 0 && currentDepth >= maxDepth) {
    await session.append({
      type: 'llm_response',
      ts: new Date().toISOString(),
      content: [
        {
          type: 'text',
          text: `🦂 Chimera cascade stopped at depth limit (${currentDepth}/${maxDepth}) — manual review recommended if issues persist`,
        },
      ],
      stopReason: 'end_turn' as StopReason,
      usage: { input: 0, output: 0 },
    });
  }
}
