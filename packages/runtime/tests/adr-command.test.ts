import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { ArchitectureDecisionStore } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdrCommand } from '../src/portable-commands/adr.js';

describe('/adr user command', () => {
  let dir: string;
  let root: string;
  const proposal = {
    title: 'Provider boundary',
    context: 'Keep core independent.',
    decision: 'Use a provider port.',
    alternatives: ['Direct imports'],
    consequences: ['More interfaces'],
    constraints: ['No provider imports in core'],
    scope: ['packages/core'],
    revisitWhen: '',
  };
  it('opens immutable revision content separately from current user review', async () => {
    const command = buildAdrCommand({ projectRoot: root });
    const store = new ArchitectureDecisionStore(root);
    const first = store.propose(proposal, 'worker');
    const second = store.revise(
      first.id,
      first.revision,
      first.contentHash,
      {
        ...proposal,
        decision: 'Use a revised port.',
      },
      'worker-two',
    );
    store.review(
      {
        projectId: second.projectId,
        id: second.id,
        revision: second.revision,
        contentHash: second.contentHash,
        action: 'accept',
        reason: 'Reviewed revised content.',
      },
      'user',
    );
    const page = JSON.parse((await command.run(`history-json ${first.id}`))!.message!);
    expect(page).toMatchObject({
      projectId: store.projectId,
      decisionId: first.id,
      nextBeforeRevision: null,
    });
    expect(page.records.map((record: { revision: number }) => record.revision)).toEqual([3, 2, 1]);
    expect(page.records[0]).not.toHaveProperty('decision');
    expect(JSON.parse((await command.run(`revision-json ${first.id} 1`))!.message!)).toEqual(first);
    expect((await command.run(`revision ${first.id} 2`))?.message).toContain('Use a revised port.');
    await expect(
      command.run(`accept ${first.id} 1 ${first.contentHash} Historical content`),
    ).rejects.toThrow(/changed since review/);
    expect(store.get(first.id)?.status).toBe('accepted');
    await expect(command.run(`revision-json ${first.id} 999`)).rejects.toThrow(
      /revision not found/,
    );
    await expect(command.run(`history-json ${first.id} -1`)).rejects.toThrow(/cursor/);
  });
  it('checks accepted constraints through the host read policy and reports blocked reads truthfully', async () => {
    mkdirSync(path.join(root, 'packages/core'), { recursive: true });
    writeFileSync(path.join(root, 'packages/core/marker.txt'), 'required');
    const store = new ArchitectureDecisionStore(root);
    const pending = store.propose(
      {
        ...proposal,
        checks: [
          {
            id: 'marker',
            kind: 'contains_text',
            path: 'packages/core/marker.txt',
            text: 'required',
          },
        ],
      },
      'agent',
    );
    const read = {
      name: 'read',
      description: 'Read.',
      permission: 'auto',
      mutating: false,
      inputSchema: { type: 'object' },
      execute: async () => '',
    } as Tool;
    const explain = vi.fn().mockResolvedValue({ decision: { permission: 'auto' } });
    const command = buildAdrCommand({
      projectRoot: root,
      permissionPolicy: { explain },
      toolRegistry: { get: () => read },
    });
    const ctx = { projectRoot: root } as AgentContext;
    await expect(command.run(`check ${pending.id}`, ctx)).rejects.toThrow(/accepted ADR/);
    store.review(
      {
        projectId: pending.projectId,
        id: pending.id,
        revision: pending.revision,
        contentHash: pending.contentHash,
        action: 'accept',
        reason: 'Reviewed check.',
      },
      'user',
    );
    expect(JSON.parse((await command.run(`check-json ${pending.id}`, ctx))!.message!).status).toBe(
      'pass',
    );
    explain.mockResolvedValue({ decision: { permission: 'deny' } });
    expect((await command.run(`check ${pending.id}`, ctx))?.message).toContain(
      'compliance: blocked',
    );
  });
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'adr-command-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
    root = path.join(dir, 'project');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a bounded inbox summary whose version changes for revisions and reviews', async () => {
    const command = buildAdrCommand({ projectRoot: root });
    const summary = async () => JSON.parse((await command.run('summary-json'))!.message!);
    const empty = await summary();
    expect(empty).toMatchObject({ pending: 0, total: 0 });
    const store = new ArchitectureDecisionStore(root);
    const record = store.propose(proposal, 'worker');
    const pending = await summary();
    expect(pending).toMatchObject({ projectId: store.projectId, pending: 1, total: 1 });
    expect(pending.version).not.toBe(empty.version);
    expect(await summary()).toEqual(pending);
    expect(JSON.stringify(pending)).not.toContain(proposal.context);
    const revised = store.revise(
      record.id,
      record.revision,
      record.contentHash,
      { ...proposal, decision: 'Use the revised port.' },
      'worker',
    );
    const updated = await summary();
    expect(updated.pending).toBe(1);
    expect(updated.version).not.toBe(pending.version);
    store.review(
      {
        projectId: revised.projectId,
        id: revised.id,
        revision: revised.revision,
        contentHash: revised.contentHash,
        action: 'accept',
        reason: 'Reviewed.',
      },
      'user',
    );
    const accepted = await summary();
    expect(accepted).toMatchObject({ pending: 0, total: 1 });
    expect(accepted.version).not.toBe(updated.version);
  });

  it('runs proposal, exact user acceptance, history and Markdown export through the real store', async () => {
    const command = buildAdrCommand({ projectRoot: root });
    expect((await command.run(''))?.message).toContain('No architecture decisions');
    await command.run(`propose ${JSON.stringify(proposal)}`);
    const page = JSON.parse((await command.run('list-json'))!.message!);
    const row = page.records[0];
    expect(page.total).toBe(1);
    expect(row.status).toBe('proposed');
    await expect(command.run(`accept ${row.id}`)).rejects.toThrow(/Usage/);
    await command.run(
      `accept ${row.id} ${row.revision} ${row.contentHash} Reviewed the provider boundary`,
    );
    expect((await command.run(`show ${row.id}`))?.message).toContain('Status: accepted');
    expect((await command.run(`history ${row.id}`))?.message).toContain('user:interactive');
    expect((await command.run(`export ${row.id}`))?.message).toContain('## Alternatives');
  });

  it('rejects stale acceptance after another actor revises a pending proposal', async () => {
    const command = buildAdrCommand({ projectRoot: root });
    const store = new ArchitectureDecisionStore(root);
    const record = store.propose(proposal, 'agent');
    store.revise(
      record.id,
      record.revision,
      record.contentHash,
      { ...proposal, decision: 'Use a revised port.' },
      'worker',
    );
    await expect(
      command.run(`accept ${record.id} ${record.revision} ${record.contentHash} Reviewed`),
    ).rejects.toThrow(/changed since review/);
    expect(store.get(record.id)?.status).toBe('proposed');
    expect(store.history(record.id)).toHaveLength(2);
  });

  it('uses the host live project root when the command object survives a project switch', async () => {
    const host = { projectRoot: root };
    const command = buildAdrCommand(host);
    await command.run(`propose ${JSON.stringify(proposal)}`);
    host.projectRoot = path.join(dir, 'another-project');
    expect((await command.run('list'))?.message).toContain('No architecture decisions');
  });

  it('transfers accepted content as a fresh inactive proposal in another project', async () => {
    const source = buildAdrCommand({ projectRoot: root });
    const store = new ArchitectureDecisionStore(root);
    const pending = store.propose(
      {
        ...proposal,
        checks: [{ id: 'marker', kind: 'file_exists', path: 'packages/core/marker.ts' }],
      },
      'worker',
    );
    store.review(
      {
        projectId: pending.projectId,
        id: pending.id,
        revision: pending.revision,
        contentHash: pending.contentHash,
        action: 'accept',
        reason: 'Reviewed at source.',
      },
      'source-user',
    );
    const exported = (await source.run(`export-json ${pending.id}`))!.message!;
    const targetRoot = path.join(dir, 'target');
    const target = buildAdrCommand({ projectRoot: targetRoot });
    const targetStore = new ArchitectureDecisionStore(targetRoot);
    const preview = JSON.parse((await target.run(`preview-import ${exported}`))!.message!);
    expect(preview).toMatchObject({ title: proposal.title, checks: [{ id: 'marker' }] });
    expect(targetStore.list()).toEqual([]);
    await target.run(`import ${exported}`);
    const imported = targetStore.list()[0]!;
    expect(imported.status).toBe('proposed');
    expect(imported.projectId).toBe(targetStore.projectId);
    expect(imported.id).not.toBe(pending.id);
    expect(imported.resolvedBy).toBeUndefined();
    await target.run(`import ${exported}`);
    expect(targetStore.list()).toHaveLength(1);
    expect(targetStore.history(imported.id)).toHaveLength(1);
    await source.run(`import ${exported}`);
    expect(store.list()).toHaveLength(1);
    expect(store.history(pending.id)).toHaveLength(2);
    expect(store.get(pending.id)?.status).toBe('accepted');
  });

  it('rejects transferred approval fields, unsupported versions and oversized input before writing', async () => {
    const command = buildAdrCommand({ projectRoot: root });
    for (const input of [
      { format: 'wrongstack-adr', version: 2, proposal },
      { format: 'wrongstack-adr', version: 1, proposal, status: 'accepted' },
      { format: 'wrongstack-adr', version: 1, proposal: { ...proposal, resolvedBy: 'user' } },
      { format: 'wrongstack-adr', version: 1, proposal: { ...proposal, supersedes: 'ADR-source' } },
    ])
      await expect(command.run(`import ${JSON.stringify(input)}`)).rejects.toThrow(/ADR transfer/);
    await expect(
      command.run(
        `preview-import ${JSON.stringify({ format: 'wrongstack-adr', version: 1, proposal: { ...proposal, context: 'x'.repeat(65_000) } })}`,
      ),
    ).rejects.toThrow(/ADR transfer exceeds/);
    expect(new ArchitectureDecisionStore(root).list()).toEqual([]);
  });
});
