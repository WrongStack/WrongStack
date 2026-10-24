import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { expect, it } from 'vitest';
import { createSageTurnMiddleware } from '../src/middleware/turn-memory.js';
import { checkInjectionValidity } from '../src/retrieval/validity-checks.js';
import type { Sage } from '../src/types.js';

it('checks current sources before turn injection, emits the reviewed revision, and rechecks edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sage-inject-validity-'));
  const memory: Sage = {
    id: 'm',
    revision: 2,
    text: 'Lifecycle tests use retry quota three.',
    kind: 'fact',
    scope: 'project',
    status: 'active',
    importance: 1,
    confidence: 1,
    freshness: 1,
    tags: ['lifecycle'],
    anchors: [],
    sources: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    validity: {
      statement: 'Only for the default lifecycle policy.',
      checks: [{ type: 'source_contains', path: 'retry.ts', text: 'quota = 3' }],
    },
  };
  try {
    await writeFile(join(root, 'retry.ts'), 'export const quota = 3;');
    const events = new EventBus();
    const traces: unknown[] = [];
    events.on('memory.injector_run', (event) => traces.push(event));
    const middleware = createSageTurnMiddleware({
      memory: { searchSage: async () => [memory] },
      events,
      projectRoot: root,
      getSessionId: () => 'leader',
    });
    const request = {
      model: 'test',
      messages: [{ role: 'user', content: 'Change lifecycle tests retry quota' }],
      system: [],
    };
    const result = await middleware.handler(request as never, async (next) => next);
    expect(result.system?.[0]?.text).toContain('satisfied');
    expect(traces[0]).toMatchObject({
      sessionId: 'leader',
      trigger: 'turn_context',
      injected: [
        {
          id: 'm',
          revision: 2,
          validityReview: { observedRevision: 2, checks: [{ status: 'satisfied' }] },
        },
      ],
    });
    await writeFile(join(root, 'retry.ts'), 'export const quota = 5;');
    expect((await checkInjectionValidity([memory], root)).get('m')?.checks[0]?.status).toBe(
      'not_satisfied',
    );
    expect((await checkInjectionValidity([memory])).get('m')?.checks[0]?.status).toBe('unknown');
    expect(memory.revision).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
