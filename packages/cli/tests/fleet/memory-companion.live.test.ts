import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, SessionWriter } from '@wrongstack/contracts/types';
import { FallbackProfileManager } from '@wrongstack/core/agent';
import { sessionNoteHub } from '@wrongstack/core/coordination';
import { DefaultErrorHandler, DefaultRetryPolicy } from '@wrongstack/core/execution';
import { DefaultLogger, DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import {
  DefaultSecretScrubber,
  DefaultSecretVault,
  decryptConfigSecrets,
} from '@wrongstack/core/security';
import { CONFIG_BEHAVIOR_DEFAULTS, DefaultConfigStore } from '@wrongstack/core/storage';
import { createSageTurnMiddleware, SqliteMemoryPort } from '@wrongstack/sage';
import { expect, it } from 'vitest';
import { type MultiAgentDeps, MultiAgentHost } from '../../src/multi-agent.js';

// Explicit opt-in: this calls the active profile's real model and consumes quota.
it.skipIf(process.env.WRONGSTACK_MEMORY_LIVE !== '1')(
  'delivers a real model review to the leader using temporary SQLite and source files',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wstack-memory-live-'));
    const home = join(homedir(), '.wrongstack');
    const bootstrap = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    const profile = decryptConfigSecrets(
      JSON.parse(
        await readFile(
          join(home, 'profiles', bootstrap.activeProfile ?? 'default', 'config.json'),
          'utf8',
        ),
      ),
      new DefaultSecretVault({ keyFile: join(home, '.key') }),
    );
    const config = {
      ...CONFIG_BEHAVIOR_DEFAULTS,
      ...profile,
      features: { ...CONFIG_BEHAVIOR_DEFAULTS.features, memory: true, memoryCurator: true },
      // Keep this probe on one explicit model; do not fan out via the user's matrix.
      modelMatrix: undefined,
      fleet: { exploreCompanion: { enabled: false }, shadow: { enabled: false } },
    } as Config;
    await mkdir(join(root, '.wrongstack', 'agents', 'memory-curator'), { recursive: true });
    await writeFile(
      join(root, '.wrongstack', 'agents', 'memory-curator', 'config.json'),
      JSON.stringify({
        provider: config.provider,
        model: config.model,
        modelPolicy: {
          strict: true,
          allowed: [{ provider: config.provider, model: config.model }],
          fallbacks: [],
        },
      }),
    );
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src/retry.ts'),
      'export const retryQuota = 3;\nexport function canRetry(attempt: number) { return attempt < retryQuota; }\n',
    );
    const store = new SqliteMemoryPort({ projectRoot: root });
    await store.initialize();
    const memory = await store.rememberSage({
      text: 'Transport retries are unlimited; there is no retry quota.',
      validity: {
        statement: 'Applies only to the default retry module; session overrides are not covered.',
        checks: [{ type: 'source_contains', path: 'src/retry.ts', text: 'retryQuota = 3' }],
      },
      anchors: [{ type: 'file', path: 'src/retry.ts' }],
    });
    const before = await store.getSage(memory.id);
    const events = new EventBus();
    const container = new Container();
    container.bind(TOKENS.Logger, () => new DefaultLogger({ level: 'error', stderr: false }));
    container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
    container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
    container.bind(TOKENS.MemoryStore, () => store);
    const sessionId = `memory-live-${Date.now()}`;
    const noop = async () => {};
    const session = {
      id: sessionId,
      pendingToolUses: [],
      append: noop,
      appendBatch: noop,
      flush: noop,
      close: noop,
      recordFileChange: () => {},
      writeCheckpoint: noop,
      writeFileSnapshot: noop,
      truncateToCheckpoint: async () => 0,
      clearSession: noop,
      writeInFlightMarker: noop,
      clearInFlightMarker: noop,
    } as unknown as SessionWriter;
    const deps = {
      container,
      events,
      session,
      projectRoot: root,
      cwd: root,
      configStore: new DefaultConfigStore(config),
      providerRegistry: new ProviderRegistry(),
      toolRegistry: new ToolRegistry(),
      secretScrubber: new DefaultSecretScrubber(),
      tokenCounter: new DefaultTokenCounter(),
      systemPromptBuilder: {
        build: async () => [
          {
            type: 'text',
            text: 'Verify the supplied claim against source evidence. Use submit_result to return your result.',
          },
        ],
      },
      fallbackProfileManager: new FallbackProfileManager(config),
    } as unknown as MultiAgentDeps;
    const host = new MultiAgentHost(deps, {
      fleetRoot: join(root, 'fleet'),
      sessionsRoot: join(root, 'sessions'),
      maxSpawns: 2,
      maxConcurrent: 1,
    });
    const notes: Array<{ subject?: string | undefined; body: string }> = [];
    const unregister = sessionNoteHub.register({
      sessionId,
      agentId: 'leader',
      events,
      deliver: (note) => notes.push(note),
    });
    try {
      const director = await host.ensureDirector();
      expect(director).toBeDefined();
      director!.on('task.completed', ({ result }) =>
        console.log('PROBE_TASK', deps.secretScrubber.scrub(JSON.stringify(result))),
      );
      const turn = createSageTurnMiddleware({
        memory: store,
        projectRoot: root,
        events,
        getSessionId: () => sessionId,
      });
      const request = await turn.handler(
        {
          model: config.model,
          messages: [
            {
              role: 'user',
              content:
                'Transport retries are unlimited; there is no retry quota. Check transport retries.',
            },
          ],
          system: [],
        } as never,
        async (next) => next,
      );
      expect(JSON.stringify(request.system)).toContain('sourceChecks=');
      await expect
        .poll(
          () =>
            notes.some(
              (n) => n.subject === '[memory:review]' || n.subject === '[memory:unverifiable]',
            ),
          { timeout: 100_000, interval: 250 },
        )
        .toBe(true);
      const review = notes.find((n) => n.subject === '[memory:review]');
      const after = await store.getSage(memory.id);
      // Recall legitimately increments injection counters; the knowledge itself stays unchanged.
      const unchanged =
        after?.revision === before?.revision &&
        after?.text === before?.text &&
        JSON.stringify(after?.validity) === JSON.stringify(before?.validity) &&
        after?.status === before?.status;
      const report = {
        root,
        provider: config.provider,
        model: config.model,
        notes,
        memoryUnchanged: unchanged,
      };
      await writeFile(join(root, 'probe-result.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      expect(review).toBeDefined();
      expect(review!.body).toMatch(/"verdict":"(contradicted|outdated)"/);
      expect(review!.body).toContain('retryQuota');
      expect(review!.body).toContain('"status":"satisfied"');
      expect(review!.body).toContain('"applicability":"unknown:');
      expect(unchanged).toBe(true);
    } finally {
      unregister();
      await host.stopAll();
      store.close();
    }
  },
  120_000,
);
