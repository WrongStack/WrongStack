import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildArchitectureDecisionChecksBlock } from '../../src/storage/architecture-decision-checks.js';
import { ArchitectureDecisionStore } from '../../src/storage/architecture-decision-store.js';

describe('automatic architecture check context', () => {
  let dir: string;
  let ctx: AgentContext;
  const read: Tool = {
    name: 'read',
    permission: 'auto',
    mutating: false,
    description: 'Read a file.',
    inputSchema: { type: 'object' },
    execute: async () => '',
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'adr-auto-check-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
    const root = path.join(dir, 'project');
    mkdirSync(root);
    writeFileSync(path.join(root, 'a.txt'), 'required');
    ctx = { projectRoot: root, meta: {} } as AgentContext;
    const store = new ArchitectureDecisionStore(root);
    const record = store.propose(
      {
        title: 'Required marker',
        context: 'Public contract.',
        decision: 'Keep the marker.',
        alternatives: [],
        consequences: [],
        constraints: [],
        scope: [],
        revisitWhen: '',
        checks: [{ id: 'marker', kind: 'contains_text', path: 'a.txt', text: 'required' }],
      },
      'agent',
    );
    store.review(
      {
        projectId: record.projectId,
        id: record.id,
        revision: record.revision,
        contentHash: record.contentHash,
        action: 'accept',
        reason: 'Reviewed the marker.',
      },
      'user',
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rechecks inspected bytes and uses the host side-effect-free permission explanation', async () => {
    const explain = vi.fn().mockResolvedValue({ decision: { permission: 'auto' } });
    const policy = { explain };
    const first = await buildArchitectureDecisionChecksBlock(ctx, () => policy, read);
    expect(first?.text).toContain('result: pass');
    expect((await buildArchitectureDecisionChecksBlock(ctx, () => policy, read))?.text).toBe(
      first?.text,
    );
    expect(explain).toHaveBeenCalledWith(read, { path: path.join(ctx.projectRoot, 'a.txt') }, ctx);
    writeFileSync(path.join(ctx.projectRoot, 'a.txt'), 'changed');
    expect((await buildArchitectureDecisionChecksBlock(ctx, () => policy, read))?.text).toContain(
      'result: fail',
    );
    expect(ctx.meta.architectureDecisionChecks).toMatchObject({ status: 'fail' });
    explain.mockResolvedValue({ decision: { permission: 'deny' } });
    expect((await buildArchitectureDecisionChecksBlock(ctx, () => policy, read))?.text).toContain(
      'result: blocked',
    );
  });

  it('blocks unavailable policies, confirmation-only reads and disabled read tools', async () => {
    const confirm = { explain: vi.fn().mockResolvedValue({ decision: { permission: 'confirm' } }) };
    for (const [policy, tool] of [
      [undefined, read],
      [confirm, read],
      [confirm, undefined],
    ] as const)
      expect((await buildArchitectureDecisionChecksBlock(ctx, () => policy, tool))?.text).toContain(
        'result: blocked',
      );
  });

  // 2026-11-14: the request builder resolved the permission policy on every request, so a
  // container without one failed each run before any ADR was even read.
  it('reads the permission policy only for accepted checks, and a missing one blocks', async () => {
    const unbound = vi.fn(() => {
      throw new Error('Container: token not bound');
    });
    const block = await buildArchitectureDecisionChecksBlock(ctx, unbound, read);
    expect(block?.text).toContain('blocked');
    expect(ctx.meta.architectureDecisionChecks).toMatchObject({ status: 'blocked' });

    const empty = { projectRoot: path.join(dir, 'other'), meta: {} } as AgentContext;
    mkdirSync(empty.projectRoot);
    const untouched = vi.fn();
    expect(await buildArchitectureDecisionChecksBlock(empty, untouched, read)).toBeUndefined();
    expect(untouched).not.toHaveBeenCalled();
  });
});
