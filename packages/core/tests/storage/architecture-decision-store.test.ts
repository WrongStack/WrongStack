import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ArchitectureDecision,
  type ArchitectureDecisionContent,
  formatArchitectureDecision,
} from '../../src/storage/architecture-decision.js';
import { buildArchitectureDecisionBlock } from '../../src/storage/architecture-decision-context.js';
import { ArchitectureDecisionStore } from '../../src/storage/architecture-decision-store.js';

const content: ArchitectureDecisionContent = {
  title: 'Keep provider adapters outside core',
  context: 'Core must remain provider independent.',
  decision: 'Adapters live in the providers package.',
  alternatives: ['Put adapters in core'],
  consequences: ['Provider contracts need explicit boundaries.'],
  constraints: ['Core must not import providers.'],
  scope: ['packages/core'],
  revisitWhen: 'The provider contract changes.',
};

describe('project architecture decisions', () => {
  let dir: string;
  let store: ArchitectureDecisionStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'wstack-adr-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
    store = new ArchitectureDecisionStore(path.join(dir, 'project'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  const review = (
    record: ArchitectureDecision,
    action: 'accept' | 'reject' | 'deprecate' = 'accept',
  ) => ({
    projectId: record.projectId,
    id: record.id,
    revision: record.revision,
    contentHash: record.contentHash,
    action,
    reason: 'Reviewed the alternatives and consequences.',
  });

  it('persists proposals across instances without activating them', () => {
    expect(store.list()).toEqual([]);
    const record = store.propose(content, 'worker-1');
    expect(record.status).toBe('proposed');
    expect(new ArchitectureDecisionStore(store.projectRoot).get(record.id)).toEqual(record);
    const meta: Record<string, unknown> = {};
    expect(buildArchitectureDecisionBlock(store.projectRoot, meta)?.text).not.toContain(
      content.decision,
    );
    expect(meta.architectureDecisionSnapshot).toEqual([]);
  });

  it('pages immutable history without shifting older cursors when a new revision is appended', () => {
    const first = store.propose(content, 'worker');
    let current = first;
    for (let revision = 2; revision <= 53; revision++)
      current = store.revise(
        current.id,
        current.revision,
        current.contentHash,
        { ...content, decision: `Decision ${revision}` },
        'worker',
      );
    const page = store.historyPage(first.id);
    expect(page.records).toHaveLength(50);
    expect(page.records[0]?.revision).toBe(53);
    expect(page.nextBeforeRevision).toBe(4);
    store.revise(
      current.id,
      current.revision,
      current.contentHash,
      { ...content, decision: 'Decision 54' },
      'worker',
    );
    expect(
      store
        .historyPage(first.id, page.nextBeforeRevision!)
        .records.map((record) => record.revision),
    ).toEqual([3, 2, 1]);
    expect(store.historyPage(first.id, 4).nextBeforeRevision).toBeNull();
    expect(store.historyPage(first.id).records[0]?.revision).toBe(54);
    expect(store.getRevision(first.id, 1)).toEqual(first);
    expect(store.getRevision('ADR-other', 1)).toBeUndefined();
    expect(() => store.getRevision(first.id, 0)).toThrow(/revision/);
    expect(() => store.historyPage(first.id, -1)).toThrow(/cursor/);
    expect(
      new ArchitectureDecisionStore(path.join(dir, 'other')).getRevision(first.id, 1),
    ).toBeUndefined();
  });

  it('accepts only the exact reviewed record revision and content hash', () => {
    const record = store.propose(content, 'worker-1');
    expect(() =>
      store.review({ ...review(record), contentHash: '0'.repeat(64) }, 'user-1'),
    ).toThrow(/changed since review/);
    expect(() => store.review({ ...review(record), revision: 2 }, 'user-1')).toThrow(
      /changed since review/,
    );
    expect(store.get(record.id)?.status).toBe('proposed');
    const accepted = store.review(review(record), 'user-1');
    expect(accepted).toMatchObject({ status: 'accepted', revision: 2, resolvedBy: 'user-1' });
    expect(store.history(record.id)).toEqual([record, accepted]);
    expect(() => store.review(review(record), 'user-2')).toThrow(/changed since review/);
  });

  it('refuses a review response bound to another project', () => {
    const record = store.propose(content, 'worker');
    expect(() => store.review({ ...review(record), projectId: 'another-project' }, 'user')).toThrow(
      /different project/,
    );
    expect(store.get(record.id)?.status).toBe('proposed');
  });

  it('deduplicates identical proposals across instances, including rejected proposals', () => {
    const record = store.propose(content, 'worker-1');
    expect(new ArchitectureDecisionStore(store.projectRoot).propose(content, 'worker-2').id).toBe(
      record.id,
    );
    store.review(review(record, 'reject'), 'user-1');
    expect(store.propose(content, 'worker-3').status).toBe('rejected');
    expect(store.list()).toHaveLength(1);
  });

  it('isolates projects and uses the pinned root rather than the working directory', () => {
    const record = store.propose(content, 'worker-1');
    expect(
      new ArchitectureDecisionStore(path.join(dir, 'other-project')).get(record.id),
    ).toBeUndefined();
    expect(store.file).toContain(path.join('decisions', 'decisions.sqlite'));
  });

  it('supersedes atomically while preserving accepted decision content and history', () => {
    const old = store.review(review(store.propose(content, 'worker-1')), 'user-1');
    const replacement = store.propose(
      {
        ...content,
        title: 'Replace provider boundary',
        decision: 'Use a separate provider port.',
        supersedes: old.id,
      },
      'worker-2',
    );
    expect(store.get(old.id)?.status).toBe('accepted');
    const accepted = store.review(review(replacement), 'user-1');
    expect(
      store.propose(
        {
          ...content,
          title: 'Replace provider boundary',
          decision: 'Use a separate provider port.',
          supersedes: old.id,
        },
        'worker-retry',
      ).id,
    ).toBe(accepted.id);
    expect(store.get(old.id)).toMatchObject({
      status: 'superseded',
      supersededBy: accepted.id,
      decision: old.decision,
    });
    expect(store.history(old.id)[1]).toEqual(old);
    expect(
      store
        .list()
        .filter((r) => r.status === 'accepted')
        .map((r) => r.id),
    ).toEqual([accepted.id]);
  });

  it('rejects a stale predecessor without partially activating the replacement', () => {
    const old = store.review(review(store.propose(content, 'worker-1')), 'user-1');
    const replacement = store.propose(
      { ...content, title: 'Replacement', supersedes: old.id },
      'worker-2',
    );
    store.review(review(old, 'deprecate'), 'user-1');
    expect(() => store.review(review(replacement), 'user-1')).toThrow(/Predecessor ADR changed/);
    expect(store.get(replacement.id)?.status).toBe('proposed');
    expect(store.history(replacement.id)).toHaveLength(1);
  });

  it('refreshes the live snapshot after acceptance and deprecation without touching the transcript', () => {
    const pending = store.propose(content, 'worker-1');
    const meta = {};
    const accepted = store.review(review(pending), 'user-1');
    const block = buildArchitectureDecisionBlock(store.projectRoot, meta);
    expect(block?.text).toContain(content.constraints[0]);
    expect(block?.text).toContain(accepted.contentHash);
    store.review(review(accepted, 'deprecate'), 'user-1');
    expect(buildArchitectureDecisionBlock(store.projectRoot, meta)?.text).not.toContain(
      content.decision,
    );
    expect(meta).toEqual({ architectureDecisionSnapshot: [] });
  });

  it.each(['../outside', '/absolute', 'C:\\outside', 'packages/../other', 'packages/**'])(
    'rejects unsafe or ambiguous scope %s',
    (scope) => {
      expect(() => store.propose({ ...content, scope: [scope] }, 'worker')).toThrow(/scope/);
      expect(store.list()).toEqual([]);
    },
  );

  it('exports the rationale and lifecycle without treating implementation as verified', () => {
    const record = store.propose(content, 'worker');
    const markdown = formatArchitectureDecision(record);
    expect(markdown).toContain('Status: proposed');
    expect(markdown).toContain(content.context);
    expect(markdown).toContain(content.alternatives[0]);
    expect(markdown).toContain(content.revisitWhen);
  });

  it('refuses a newer database schema while preserving its records and version', () => {
    const record = store.propose(content, 'worker');
    const Database = loadRuntimeDatabaseSync();
    const db = new Database(store.file);
    db.exec('PRAGMA user_version = 2');
    db.close();
    expect(() => store.list()).toThrow(/newer schema/);
    expect(() => store.propose({ ...content, title: 'Another decision' }, 'worker')).toThrow(
      /newer schema/,
    );
    const preserved = new Database(store.file, { readOnly: true });
    try {
      expect(preserved.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(preserved.prepare('SELECT id FROM architecture_decisions').all()).toEqual([
        { id: record.id },
      ]);
    } finally {
      preserved.close();
    }
  });
});
