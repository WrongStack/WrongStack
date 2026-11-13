import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import { ArchitectureDecisionStore } from '@wrongstack/core/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { architectureDecisionsTool } from '../src/architecture-decisions.js';

let dir: string;
afterEach(() => {
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('allows an agent to propose, read and revise but never activate an ADR', async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'adr-tool-'));
  vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
  const ctx = {
    projectRoot: path.join(dir, 'project'),
    agentId: 'worker-7',
    signal: new AbortController().signal,
  } as AgentContext;
  const proposal = {
    title: 'Database ownership',
    context: 'Serialize writes.',
    decision: 'Use a single writer.',
    alternatives: [],
    consequences: [],
    constraints: [],
    scope: [],
    revisitWhen: '',
  };
  await architectureDecisionsTool.execute(
    { action: 'propose', proposal: { ...proposal, status: 'accepted' } as never },
    ctx,
    { signal: ctx.signal },
  );
  const store = new ArchitectureDecisionStore(ctx.projectRoot);
  const record = store.list()[0]!;
  expect(record).toMatchObject({ status: 'proposed', proposedBy: 'worker-7' });
  expect(
    await architectureDecisionsTool.execute({ action: 'get', id: record.id }, ctx, {
      signal: ctx.signal,
    }),
  ).toEqual(record);
  await expect(
    architectureDecisionsTool.execute({ action: 'accept', id: record.id } as never, ctx, {
      signal: ctx.signal,
    }),
  ).rejects.toThrow(/Use list/);
  expect(store.get(record.id)?.status).toBe('proposed');
  await architectureDecisionsTool.execute(
    {
      action: 'revise',
      id: record.id,
      revision: record.revision,
      contentHash: record.contentHash,
      proposal: { ...proposal, decision: 'Use a transactional writer.' },
    },
    ctx,
    { signal: ctx.signal },
  );
  expect(store.get(record.id)).toMatchObject({
    revision: 2,
    status: 'proposed',
    decision: 'Use a transactional writer.',
  });
});
