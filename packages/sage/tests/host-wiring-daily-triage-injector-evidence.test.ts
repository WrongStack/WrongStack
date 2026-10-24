/**
 * Regression: the SAGE daily dry-run triage pass must consume the injector's
 * rejection evidence. The injector emits `memory.injector_run` (same process,
 * same bus) with per-memory rejection detail whose gate vocabulary matches
 * InjectorEvidence.rejectedByGate; Phase 2 folds it into the value score
 * (BELOW_SCORE usage clamp after 5 rejections) and surfaces the
 * `REJ: pressure=… | gate=…` line in the Phase-3 prompt.
 *
 * Reproduction: real store + real setupSage registration (the injector
 * middleware captured from the toolCall pipeline by name) + real EventBus.
 * The victim is anchored to the path being read and carries importance 0.45
 * (below the injector's 0.5 floor → a deterministic belowScore rejection on
 * every run) while staying gray-zone for triage (total 56 → 54 with the
 * clamp). The control is anchored elsewhere and never retrieved.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import { setupSage } from '../src/host-wiring.js';
import { SqliteMemoryPort } from '../src/memory-port.js';

describe('daily dry-run triage injector evidence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces rejection pressure for a memory the injector keeps rejecting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sage-daily-injector-evidence-'));
    const port = new SqliteMemoryPort({ projectRoot: dir });
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'victim.ts'), 'export const v = 1;\n', 'utf8');

      const remember = (text: string, n: number, importance: number) =>
        port.rememberSage({
          text,
          kind: 'fact',
          scope: 'project',
          importance,
          confidence: 0.5,
          freshness: 1,
          persistence: 'long_lived',
          tags: ['sage', 'injection'],
          anchors: [{ type: 'file', path: n === 0 ? 'src/victim.ts' : 'src/other.ts' }],
          sources: [{ type: 'user' }],
        });

      const victim = await remember(
        'VICTMRK3 Historically the release checklist keeps a manual smoke pass over the payment ' +
          'flow because the sandbox provider drops webhooks during maintenance windows, which ' +
          'surfaced twice last quarter as false-negative overnight regression failures.',
        0,
        0.45,
      );
      // The control is identified by its CTRLMRK7 text marker in the prompts.
      await remember(
        'CTRLMRK7 The preview deployment pipeline ships marketing artifacts from the website ' +
          'workspace each night, and the ops channel receives the manifest digest after the ' +
          'registry upload finishes its checksum verification pass.',
        1,
        0.55,
      );

      vi.useFakeTimers();
      const events = new EventBus();
      let victimBelowScore = 0;
      events.onPattern('memory.injector_run', (_event, payload) => {
        const run = payload as { rejectedDetail?: Array<{ id?: string; gate?: string }> };
        for (const detail of run.rejectedDetail ?? []) {
          if (detail?.id === victim.id && detail.gate === 'belowScore') victimBelowScore++;
        }
      });

      const prompts: string[] = [];
      let toolCallMiddleware:
        | { handler: (payload: unknown, next: (p: unknown) => unknown) => Promise<unknown> }
        | undefined;
      const memoryStore = {
        hygiene: async () => ({}),
        getCapability: (cap: { id: string }) => port.getCapability(cap),
      } as never;
      const teardown = setupSage({
        config: {
          features: { memory: true },
          Sage: {
            enabled: true,
            triage: { dailyDryRun: true },
            hygiene: { autoAfterSession: false },
          },
        } as never,
        pipelines: {
          // setupSage registers injector → outcome-capture → path-remap;
          // capture THE INJECTOR by its middleware name.
          toolCall: {
            use: (mw: { name?: string }) => {
              if (mw?.name === 'sage.tool-result-injection') {
                toolCallMiddleware = mw as never;
              }
            },
          },
          request: { use: vi.fn() },
        } as never,
        memoryStore,
        logger: { debug: (_msg: string) => {} } as never,
        events: events as never,
        projectRoot: dir,
        getLlmCall: () => async (system: string, user: string) => {
          prompts.push(`${system}\n${user}`);
          return '3';
        },
      });
      expect(toolCallMiddleware).toBeDefined();

      for (let i = 0; i < 6; i++) {
        await toolCallMiddleware!.handler(
          {
            toolUse: {
              type: 'tool_use',
              id: `t${i}`,
              name: 'read',
              input: { path: 'src/victim.ts' },
            },
            result: { content: 'export const v = 1;', is_error: false },
            ctx: { cwd: dir, projectRoot: dir },
          },
          async (p) => p,
        );
      }
      // The drive really produced the rejection events.
      expect(victimBelowScore).toBeGreaterThanOrEqual(5);

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await teardown();

      const victimPrompt = prompts.find((p) => p.includes('VICTMRK3'));
      const controlPrompt = prompts.find((p) => p.includes('CTRLMRK7'));
      expect(victimPrompt).toBeDefined();
      expect(controlPrompt).toBeDefined();
      // Evidence reached the value score and the Phase-3 prompt.
      expect(victimPrompt).toContain('REJ: pressure=');
      expect(victimPrompt).toContain('gate=belowScore');
      expect(victimPrompt).toContain('SCORE: 54/100'); // usage 10 − 2 clamp
      // The never-rejected control carries no evidence and no clamp.
      expect(controlPrompt).not.toContain('REJ: pressure=');
      expect(controlPrompt).toContain('SCORE: 56/100');
    } finally {
      try {
        await port.dispose();
      } catch {
        /* best-effort close */
      }
      vi.useRealTimers();
      await removeProjectFixtureDirectory(dir, { maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  });
});
