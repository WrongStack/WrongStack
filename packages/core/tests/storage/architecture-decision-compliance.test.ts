import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ArchitectureDecision,
  type ArchitectureDecisionCheck,
  decisionContentHash,
} from '../../src/storage/architecture-decision.js';
import { checkArchitectureDecisions } from '../../src/storage/architecture-decision-compliance.js';
import { ArchitectureDecisionStore } from '../../src/storage/architecture-decision-store.js';

describe('accepted ADR compliance checks', () => {
  let dir: string;
  let root: string;
  let store: ArchitectureDecisionStore;
  const content = {
    title: 'Runtime contract',
    context: 'Keep a consistent runtime.',
    decision: 'Use the agreed runtime.',
    alternatives: [],
    consequences: [],
    constraints: [],
    scope: [],
    revisitWhen: '',
  };
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'adr-compliance-'));
    root = path.join(dir, 'project');
    mkdirSync(root);
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
    store = new ArchitectureDecisionStore(root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  const accept = (record: ArchitectureDecision) =>
    store.review(
      {
        projectId: record.projectId,
        id: record.id,
        revision: record.revision,
        contentHash: record.contentHash,
        action: 'accept',
        reason: 'Reviewed the check definitions.',
      },
      'user',
    );
  const propose = (checks: ArchitectureDecisionCheck[]) =>
    store.propose({ ...content, checks }, 'agent');
  const allowed = async () => true;
  it('reports a blocked run when more than 32 accepted checks are configured', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'ok');
    for (let index = 0; index < 3; index++) {
      const record = store.propose(
        {
          ...content,
          title: `Decision ${index}`,
          checks: Array.from({ length: 16 }, (_, n) => ({
            id: `check_${n}`,
            kind: 'file_exists' as const,
            path: 'a.txt',
          })),
        },
        'agent',
      );
      accept(record);
    }
    const report = await checkArchitectureDecisions(root, allowed);
    expect(report.status).toBe('blocked');
    expect(report.results).toHaveLength(33);
    expect(report.results.at(-1)?.message).toContain('32 checks');
  });

  it('uses JSON array indices without treating implementation properties as JSON data', async () => {
    writeFileSync(path.join(root, 'array.json'), '[true]');
    accept(
      propose([
        { id: 'first', kind: 'json_equals', path: 'array.json', pointer: '/0', value: true },
        { id: 'not-data', kind: 'json_equals', path: 'array.json', pointer: '/length', value: 1 },
      ]),
    );
    expect(
      (await checkArchitectureDecisions(root, allowed)).results.map((result) => result.status),
    ).toEqual(['pass', 'fail']);
  });

  it('preserves hashes for existing records without checks and includes rule changes in approval', () => {
    expect(decisionContentHash(content)).toBe(decisionContentHash({ ...content, checks: [] }));
    const first = propose([
      {
        id: 'runtime',
        kind: 'json_equals',
        path: 'package.json',
        pointer: '/packageManager',
        value: 'bun@1',
      },
    ]);
    const next = store.revise(
      first.id,
      first.revision,
      first.contentHash,
      {
        ...content,
        checks: [
          {
            id: 'runtime',
            path: 'package.json',
            kind: 'json_equals',
            pointer: '/packageManager',
            value: 'bun@2',
          },
        ],
      },
      'agent',
    );
    expect(next.contentHash).not.toBe(first.contentHash);
    expect(() => accept(first)).toThrow(/changed since review/);
  });

  it('does not inspect or activate rules from pending or rejected records', async () => {
    propose([{ id: 'required', kind: 'file_exists', path: 'a.txt' }]);
    const authorize = vi.fn(allowed);
    expect((await checkArchitectureDecisions(root, authorize)).status).toBe('not_configured');
    expect(authorize).not.toHaveBeenCalled();
  });

  it('evaluates all four rule kinds and attaches inspected-byte hashes without exposing contents', async () => {
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ packageManager: 'bun@1', nested: { 'a/b': true } }),
    );
    writeFileSync(path.join(root, 'a.txt'), 'Required marker\nPRIVATE_FIXTURE_CONTENT');
    accept(
      propose([
        { id: 'exists', kind: 'file_exists', path: 'a.txt' },
        { id: 'contains', kind: 'contains_text', path: 'a.txt', text: 'Required marker' },
        { id: 'excludes', kind: 'excludes_text', path: 'a.txt', text: 'forbidden marker' },
        {
          id: 'json',
          kind: 'json_equals',
          path: 'package.json',
          pointer: '/nested/a~1b',
          value: true,
        },
      ]),
    );
    const report = await checkArchitectureDecisions(root, allowed);
    expect(report.status).toBe('pass');
    expect(report.results).toHaveLength(4);
    expect(report.results[1]?.fileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_FIXTURE_CONTENT');
    writeFileSync(path.join(root, 'a.txt'), 'forbidden marker');
    const changed = await checkArchitectureDecisions(root, allowed);
    expect(changed.status).toBe('fail');
    expect(changed.results[1]?.fileHash).not.toBe(report.results[1]?.fileHash);
  });

  it('blocks denied reads and never mistakes missing files, invalid JSON or limits for a pass', async () => {
    writeFileSync(path.join(root, 'invalid.json'), '{');
    writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    accept(
      propose([
        { id: 'missing', kind: 'file_exists', path: 'missing.txt' },
        { id: 'json', kind: 'json_equals', path: 'invalid.json', pointer: '', value: null },
        { id: 'large', kind: 'contains_text', path: 'large.txt', text: 'x' },
      ]),
    );
    const denied = await checkArchitectureDecisions(root, async () => false);
    expect(denied.results.every((result) => result.status === 'blocked' && !result.fileHash)).toBe(
      true,
    );
    const report = await checkArchitectureDecisions(root, allowed);
    expect(report.results.map((result) => result.status)).toEqual(['fail', 'blocked', 'blocked']);
  });

  it('rejects unapproved code execution, traversal, duplicate ids and paths outside the decision scope', () => {
    expect(() =>
      propose([{ id: 'run', kind: 'shell', path: 'a.txt', command: 'echo unsafe' } as never]),
    ).toThrow(/Unsupported/);
    expect(() => propose([{ id: 'run', kind: 'file_exists', path: '../outside' }])).toThrow(
      /relative/,
    );
    expect(() =>
      propose([{ id: 'run', kind: 'file_exists', path: 'a.txt', command: 'echo unsafe' } as never]),
    ).toThrow(/Unknown/);
    expect(() =>
      store.propose(
        {
          ...content,
          scope: ['src'],
          checks: [{ id: 'manifest', kind: 'file_exists', path: 'package.json' }],
        },
        'agent',
      ),
    ).toThrow(/scope/);
    expect(() =>
      propose([
        { id: 'same', kind: 'file_exists', path: 'a.txt' },
        { id: 'same', kind: 'file_exists', path: 'b.txt' },
      ]),
    ).toThrow(/unique/);
  });

  it('blocks directory links escaping the project even when the lexical path is allowed', async () => {
    const outside = path.join(dir, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'a.txt'), 'private');
    symlinkSync(
      outside,
      path.join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    accept(
      propose([{ id: 'escape', kind: 'contains_text', path: 'linked/a.txt', text: 'private' }]),
    );
    expect((await checkArchitectureDecisions(root, allowed)).status).toBe('blocked');
  });

  it('invalidates results when accepted decisions change during the check', async () => {
    writeFileSync(path.join(root, 'a.txt'), 'ok');
    const record = accept(propose([{ id: 'required', kind: 'file_exists', path: 'a.txt' }]));
    const report = await checkArchitectureDecisions(root, async () => {
      store.review(
        {
          projectId: record.projectId,
          id: record.id,
          revision: record.revision,
          contentHash: record.contentHash,
          action: 'deprecate',
          reason: 'No longer applies.',
        },
        'user',
      );
      return true;
    });
    expect(report.status).toBe('blocked');
    expect(report.results[0]?.message).toContain('changed during');
  });
});
