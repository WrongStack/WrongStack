import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatMemoryHints } from '../src/retrieval/format.js';
import type { SageServiceLike } from '../src/service-contract.js';
import { SqliteSageStore } from '../src/sqlite-store.js';
import { createSageTools } from '../src/tools/memory-tools.js';

let root: string;
let store: SqliteSageStore;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-feedback-'));
  store = new SqliteSageStore({ projectRoot: root });
  await store.initialize();
});
afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});
const ctx = { session: { id: 'own' } } as unknown as Parameters<Tool['execute']>[1];
function tool(name: string) {
  const service = {
    getSage: (id: string) => store.getSage(id),
    updateSage: store.updateSage.bind(store),
    createCandidate: store.createCandidate.bind(store),
    rememberSage: store.rememberSage.bind(store),
  } as unknown as SageServiceLike;
  return createSageTools(service).find((item) => item.name === name)!;
}
const seed = () =>
  store.rememberSage({
    text: 'Retry admission must preserve the transport budget.',
    anchors: [{ type: 'file', path: 'transport.ts' }],
    persistence: 'permanent',
  });

describe('evidence-based model feedback', () => {
  it.each(['archive', 'delete'] as const)(
    'does not %s a corrected memory from an old feedback proposal',
    async (decision) => {
      const original = await store.rememberSage({
        text: 'Retry admission shares the transport quota.',
      });
      await tool('memory_update').execute(
        {
          id: original.id,
          feedback: {
            verdict: 'incorrect',
            observedRevision: original.revision,
            evidence: 'Current transport test separates quotas.',
          },
        },
        ctx,
        { signal: new AbortController().signal },
      );
      const candidate = (await store.listCandidates())[0]!;
      const corrected = await store.updateSage(original.id, {
        expectedRevision: original.revision,
        text: 'Retry admission uses a separate quota verified by the transport test.',
      });
      const resolution = await store.resolveCandidate(candidate.id, decision);
      expect(resolution).toMatchObject({
        applied: false,
        error: expect.stringContaining('revision changed'),
      });
      expect(await store.getSage(original.id)).toEqual(corrected);
      expect((await store.listCandidates())[0]?.status).toBe('pending');
    },
  );

  it('refuses a false success from a backend that silently ignores feedback', async () => {
    const original = await seed();
    let proposed = false;
    const oldBackend = {
      getSage: async () => original,
      updateSage: async () => original,
      createCandidate: async () => {
        proposed = true;
      },
    } as unknown as SageServiceLike;
    const update = createSageTools(oldBackend).find((item) => item.name === 'memory_update')!;
    await expect(
      update.execute(
        {
          id: original.id,
          feedback: {
            verdict: 'outdated',
            observedRevision: original.revision,
            evidence: 'Current test differs.',
          },
        },
        ctx,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('did not persist memory feedback');
    expect(proposed).toBe(false);
  });

  it('persists a judgment without changing content, freshness, confidence, revision or relations', async () => {
    const original = await seed();
    const updated = await store.updateSage(original.id, {
      feedback: {
        verdict: 'useful',
        observedRevision: original.revision,
        evidence: 'transport.test.ts passed after preserving the admission budget.',
        sessionId: 'own',
      },
    });
    const { feedback, ...unchanged } = updated;
    expect(unchanged).toEqual(original);
    expect(feedback?.[0]?.verdict).toBe('useful');
    store.close();
    store = new SqliteSageStore({ projectRoot: root });
    expect((await store.getSage(original.id))?.feedback).toEqual(feedback);
  });

  it('deduplicates retries and bounds feedback history', async () => {
    const original = await seed();
    const feedback = {
      verdict: 'uncertain' as const,
      observedRevision: original.revision,
      evidence: 'No current test evidence.',
      sessionId: 'own',
    };
    await store.updateSage(original.id, { feedback });
    await store.updateSage(original.id, { feedback });
    expect((await store.getSage(original.id))?.feedback).toHaveLength(1);
    for (let i = 0; i < 12; i++)
      await store.updateSage(original.id, {
        feedback: { ...feedback, evidence: `Observation ${i}` },
      });
    expect((await store.getSage(original.id))?.feedback).toHaveLength(8);
  });

  it('rejects stale judgments and stale corrections after a concurrent update', async () => {
    const original = await seed();
    await store.updateSage(original.id, {
      text: 'Admission now uses a separate transport budget.',
    });
    await expect(
      store.updateSage(original.id, {
        feedback: {
          verdict: 'incorrect',
          observedRevision: original.revision,
          evidence: 'Old evidence.',
        },
      }),
    ).rejects.toThrow('revision changed');
    await expect(
      store.updateSage(original.id, {
        expectedRevision: original.revision,
        text: 'Overwriting a concurrent correction.',
      }),
    ).rejects.toThrow('revision changed');
  });

  it('rejects empty evidence and combined feedback/content mutations', async () => {
    const original = await seed();
    await expect(
      store.updateSage(original.id, {
        feedback: { verdict: 'useful', observedRevision: original.revision, evidence: ' ' },
      }),
    ).rejects.toThrow('evidence');
    await expect(
      store.updateSage(original.id, {
        text: 'Changed claim',
        feedback: { verdict: 'useful', observedRevision: original.revision, evidence: 'Evidence.' },
      }),
    ).rejects.toThrow('separately');
    expect(await store.getSage(original.id)).toEqual(original);
  });

  it('queues an outdated judgment for review without retiring even a permanent memory', async () => {
    const original = await seed();
    const input = {
      id: original.id,
      feedback: {
        verdict: 'outdated',
        observedRevision: original.revision,
        evidence: 'transport.ts uses a separate budget now.',
      },
    };
    await tool('memory_update').execute(input, ctx, { signal: new AbortController().signal });
    await tool('memory_update').execute(input, ctx, { signal: new AbortController().signal });
    const current = (await store.getSage(original.id))!;
    expect(current.status).toBe('active');
    expect(current.persistence).toBe('permanent');
    expect(current.feedback).toHaveLength(1);
    expect(current.feedback?.[0]?.sessionId).toBe('own');
    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      targetMemoryId: original.id,
      suggestedAction: 'investigate',
      reviewReason: 'model_feedback:outdated',
    });
    expect(formatMemoryHints([current], { maxChars: 2000 })).toContain('modelReview=outdated');
  });

  it('does not turn task-specific irrelevance into a deletion proposal', async () => {
    const original = await seed();
    await tool('memory_update').execute(
      {
        id: original.id,
        feedback: {
          verdict: 'irrelevant',
          observedRevision: original.revision,
          evidence: 'This task only changes styling.',
        },
      },
      ctx,
      { signal: new AbortController().signal },
    );
    expect(await store.listCandidates()).toEqual([]);
    expect((await store.getSage(original.id))?.confidence).toBe(original.confidence);
  });

  it('enforces session isolation for feedback too', async () => {
    const original = await store.rememberSage({
      text: 'Private session transport observations.',
      scope: 'session',
      ownerSessionId: 'other',
    });
    await expect(
      tool('memory_update').execute(
        {
          id: original.id,
          feedback: {
            verdict: 'incorrect',
            observedRevision: original.revision,
            evidence: 'Untrusted cross-session judgment.',
          },
        },
        ctx,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow('another session');
    expect((await store.getSage(original.id))?.feedback).toBeUndefined();
  });

  it('captures agent provenance and supports evidence-bearing corrections', async () => {
    const result = (await tool('remember').execute(
      { text: 'Transport admission enforces a bounded retry budget.' },
      ctx,
      { signal: new AbortController().signal },
    )) as { id: string; revision: number };
    expect((await store.getSage(result.id))?.sources).toEqual([
      { type: 'session', sessionId: 'own' },
    ]);
    await tool('memory_update').execute(
      {
        id: result.id,
        expectedRevision: result.revision,
        text: 'Transport admission uses an independently bounded retry budget.',
        sources: [{ type: 'test', path: 'transport.test.ts' }],
      },
      ctx,
      { signal: new AbortController().signal },
    );
    expect((await store.getSage(result.id))?.sources).toEqual([
      { type: 'test', path: 'transport.test.ts', sessionId: 'own' },
    ]);
  });

  it('shows revision and verification state, and does not present an old judgment as current', async () => {
    const original = await seed();
    await store.updateSage(original.id, {
      feedback: {
        verdict: 'incorrect',
        observedRevision: original.revision,
        evidence: 'Observed different behavior.',
      },
    });
    const corrected = await store.updateSage(original.id, {
      expectedRevision: original.revision,
      text: 'Admission now has a dedicated retry quota.',
    });
    const rendered = formatMemoryHints([corrected]);
    expect(rendered).toContain(`revision=${corrected.revision}`);
    expect(rendered).toContain('anchorVerified=unknown');
    expect(rendered).not.toContain('modelReview=incorrect');
    expect(corrected.feedback).toHaveLength(1);
  });
});
