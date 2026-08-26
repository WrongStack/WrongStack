import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  ChronicleMetricsStore,
  isChronicleMetricsAvailable,
} from '../../src/chronicle/index.js';
import { loadDatabaseSync } from '../../src/chronicle/metrics-schema.js';
import type { ChronicleEventInput } from '../../src/chronicle/types.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs.splice(0).map((dir) =>
      // Windows holds SQLite WAL sidecar handles briefly after close().
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ),
  ),
);

const scope = { installationId: 'i', machineId: 'm', projectId: 'p', sessionId: 'sess-1' };
const correlation = { traceId: 't', spanId: 'sp' };

function input(
  partial: Partial<ChronicleEventInput> & Pick<ChronicleEventInput, 'eventType'>,
): ChronicleEventInput {
  return { scope, correlation, occurredAt: '2026-07-24T10:00:00.000Z', ...partial };
}

/**
 * The `token_cost` table had to answer more than "what did it cost".
 *
 * It stored a single `cost` column and dropped the row entirely when cost was
 * not finite — which is the normal case for subscription-plan providers, where
 * the registry resolves no price. On a real 287 MB journal every one of 2,402
 * `token.accounted` rows priced at 0, so the table reported nothing at all
 * while the token counts it was derived from went unrecorded. Separately,
 * subagent spend arrives under the bridged `subagent.token_accounted` name
 * (a subagent's private EventBus never reaches Chronicle), which the ingest
 * did not recognize at all.
 */
describe.skipIf(!isChronicleMetricsAvailable())('token_cost attribution', { retry: 1 }, () => {
  it('records tokens, provider and model for a zero-cost subscription provider', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tok-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    await journal.append(
      input({
        eventType: 'token.accounted',
        runtime: { providerId: 'zai-coding-plan', modelId: 'glm-5.3' },
        attributes: {
          // Exactly the shape a subscription plan produces: real tokens, no price.
          usage: { input: 9_162, output: 404, cacheRead: 89_344, cacheWrite: 0 },
          cost: { input: 0, output: 0, total: 0 },
        },
      }),
    );

    const store = ChronicleMetricsStore.open(dir);
    await store.refresh();
    store.close();

    const db = new (loadDatabaseSync())(path.join(dir, 'metrics.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT * FROM token_cost').get() as Record<string, unknown>;
      // The row survives a zero cost, because the tokens are the point.
      expect(row).toMatchObject({
        cost: 0,
        input_tokens: 9_162,
        output_tokens: 404,
        cache_read_tokens: 89_344,
        cache_write_tokens: 0,
        provider: 'zai-coding-plan',
        model: 'glm-5.3',
      });
    } finally {
      db.close();
    }
  });

  it('gives a subagent its own row, keyed by agent, from the bridged event name', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tok-sub-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    await journal.append(
      input({
        eventType: 'token.accounted',
        runtime: { providerId: 'zai-coding-plan', modelId: 'glm-5.3' },
        attributes: { usage: { input: 100, output: 10 }, cost: { total: 0 } },
      }),
    );
    await journal.append(
      input({
        // The name a subagent's spend actually arrives under.
        eventType: 'subagent.token_accounted',
        scope: { ...scope, agentId: 'explore-companion-abc' },
        runtime: { providerId: 'openai-codex', modelId: 'gpt-5.6-sol' },
        attributes: { usage: { input: 5_000, output: 200 }, cost: { total: 0 } },
      }),
    );

    const store = ChronicleMetricsStore.open(dir);
    await store.refresh();
    store.close();

    const db = new (loadDatabaseSync())(path.join(dir, 'metrics.db'), { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT input_tokens, model FROM token_cost ORDER BY input_tokens')
        .all() as Array<{ input_tokens: number; model: string }>;
      // Two rows, not one: scope_key includes the agent, so the subagent's
      // spend no longer overwrites (or hides inside) the leader's.
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ input_tokens: 100, model: 'glm-5.3' });
      expect(rows[1]).toMatchObject({ input_tokens: 5_000, model: 'gpt-5.6-sol' });
      // scope_key is NUL-delimited. Key equality is a byte comparison and
      // works — which is why two rows exist at all — but SQLite's string
      // functions and the JS text decoder both stop at the first NUL, so the
      // agent segment cannot be asserted by matching the column text. Row
      // distinctness is the property that matters here.
      const { distinctScopes } = db
        .prepare('SELECT count(DISTINCT scope_key) distinctScopes FROM token_cost')
        .get() as { distinctScopes: number };
      expect(distinctScopes).toBe(2);
    } finally {
      db.close();
    }
  });

  it('still drops an event carrying neither a finite cost nor any tokens', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tok-empty-'));
    dirs.push(dir);
    const journal = new ChronicleJournal({ filePath: path.join(dir, '2026-07-24.events.jsonl') });
    await journal.append(
      input({ eventType: 'token.accounted', attributes: { usage: { input: 0, output: 0 } } }),
    );

    const store = ChronicleMetricsStore.open(dir);
    await store.refresh();
    store.close();

    const db = new (loadDatabaseSync())(path.join(dir, 'metrics.db'), { readOnly: true });
    try {
      const { c } = db.prepare('SELECT count(*) c FROM token_cost').get() as { c: number };
      expect(c).toBe(0);
    } finally {
      db.close();
    }
  });
});
