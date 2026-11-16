import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntakeConflictError, IntakeNotFoundError } from '../src/errors.js';
import { newIntakeId } from '../src/store.js';
import type { RequirementIntakeRecord } from '../src/types.js';
import { makeHarness } from './helpers.js';

function buildRecord(
  projectId = 'proj_alpha',
  overrides: Partial<RequirementIntakeRecord> = {},
): RequirementIntakeRecord {
  const now = Date.now();
  return {
    id: newIntakeId(),
    projectId,
    title: 'Add email-based password reset',
    originalRequest: 'Please add email-based password reset',
    normalizedSummary: 'Add email-based password reset',
    requestType: 'feature',
    status: 'draft',
    priority: 'unspecified',
    requestedBy: 'user-alice',
    targetUsers: [],
    constraints: [],
    providedContext: [],
    attachments: [],
    relatedResources: [],
    answers: [],
    questions: [],
    llmSuggestions: [],
    metadata: {},
    fieldSources: {},
    version: 1,
    history: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('RequirementIntakeStore', () => {
  it('does not resolve record ids outside the intake directory', async () => {
    const harness = makeHarness();
    const outsideName = `${path.basename(harness.dir)}-outside`;
    const outsidePath = path.join(path.dirname(harness.dir), `${outsideName}.json`);
    const outsideRecord = buildRecord('proj_other', { id: `reqi_${outsideName}` });
    await fsp.writeFile(outsidePath, JSON.stringify(outsideRecord), 'utf8');
    try {
      expect(await harness.store.load(`../${outsideName}`)).toBeNull();
      expect(await harness.store.exists(`../${outsideName}`)).toBe(false);
    } finally {
      await fsp.rm(outsidePath, { force: true });
    }
  });

  it('persists and reloads a record', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record);
    const loaded = await harness.store.load(record.id);
    expect(loaded?.originalRequest).toBe('Please add email-based password reset');
    expect(loaded?.title).toBe('Add email-based password reset');
  });

  it('returns null for a missing record', async () => {
    const harness = makeHarness();
    expect(await harness.store.load('reqi_missing')).toBeNull();
    expect(await harness.store.exists('reqi_missing')).toBe(false);
  });

  it('surfaces a malformed durable record instead of reporting it missing', async () => {
    const harness = makeHarness();
    const ctx = { id: 'user-alice', type: 'user' as const, projectId: 'proj_alpha' };
    const { record } = await harness.service.createIntake(
      { projectId: ctx.projectId, requestedBy: ctx.id, originalRequest: 'Add password reset' },
      ctx,
    );
    expect((await harness.service.getIntake(record.id, ctx))?.id).toBe(record.id);
    expect(await harness.service.getIntake('reqi_missing', ctx)).toBeNull();
    expect(await harness.service.getIntake('../outside', ctx)).toBeNull();

    await fsp.writeFile(path.join(harness.dir, `${record.id}.json`), '{ truncated', 'utf8');
    await expect(harness.service.getIntake(record.id, ctx)).rejects.toThrow(SyntaxError);
  });

  it('lists records for a project, newest first', async () => {
    const harness = makeHarness();
    const first = buildRecord();
    await harness.store.create(first);
    const second = buildRecord();
    await harness.store.create(second);
    const records = await harness.store.list('proj_alpha');
    expect(records).toHaveLength(2);
    expect(records[0]?.id).toBe(second.id);
  });

  it('recovers durable records from a corrupt index and retains them after the next create', async () => {
    const harness = makeHarness();
    const first = buildRecord();
    const second = buildRecord();
    await harness.store.create(first);
    await harness.store.create(second);
    expect(new Set((await harness.store.listIndex()).map((entry) => entry.id))).toEqual(
      new Set([first.id, second.id]),
    );

    await fsp.writeFile(path.join(harness.dir, '_index.json'), '{ truncated', 'utf8');
    expect(new Set((await harness.store.listIndex()).map((entry) => entry.id))).toEqual(
      new Set([first.id, second.id]),
    );

    const third = buildRecord();
    await harness.store.create(third);
    expect(new Set((await harness.store.listIndex()).map((entry) => entry.id))).toEqual(
      new Set([first.id, second.id, third.id]),
    );
  });

  it('recovers durable records when the index is missing', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record);
    await fsp.rm(path.join(harness.dir, '_index.json'));
    expect((await harness.store.listIndex()).map((entry) => entry.id)).toEqual([record.id]);
  });

  it('fails instead of silently hiding a malformed record during index recovery', async () => {
    const harness = makeHarness();
    await harness.store.create(buildRecord());
    await fsp.writeFile(path.join(harness.dir, '_index.json'), '{ truncated', 'utf8');
    await fsp.writeFile(path.join(harness.dir, 'reqi_bad.json'), '{ truncated', 'utf8');
    await expect(harness.store.listIndex()).rejects.toThrow(SyntaxError);
  });

  it('filters listing by status', async () => {
    const harness = makeHarness();
    const draft = buildRecord();
    await harness.store.create(draft);
    const submitted = buildRecord('proj_alpha', { status: 'submitted' });
    await harness.store.create(submitted);
    const submittedOnly = await harness.store.list('proj_alpha', { statuses: ['submitted'] });
    expect(submittedOnly).toHaveLength(1);
    expect(submittedOnly[0]?.id).toBe(submitted.id);
  });

  it('keeps projects isolated in listings', async () => {
    const harness = makeHarness();
    await harness.store.create(buildRecord('proj_alpha'));
    await harness.store.create(buildRecord('proj_beta'));
    expect(await harness.store.list('proj_alpha')).toHaveLength(1);
    expect(await harness.store.list('proj_beta')).toHaveLength(1);
  });

  it('bumps the version and timestamp on update', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record);
    const updated = await harness.store.update(record.id, { action: 'updated' }, (next) => {
      next.title = 'Better title';
    });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Better title');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(record.updatedAt);
  });

  it('appends change history entries', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record);
    await harness.store.update(
      record.id,
      {
        action: 'updated',
        actorId: 'user-alice',
        actorType: 'user',
        fields: ['title'],
        from: 'draft',
        to: 'collecting_information',
      },
      (next) => {
        next.status = 'collecting_information';
      },
    );
    const loaded = await harness.store.load(record.id);
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.history[0]?.action).toBe('updated');
    expect(loaded?.history[0]?.actor).toBe('user-alice');
    expect(loaded?.history[0]?.to).toBe('collecting_information');
  });

  it('rejects stale expectedVersion (optimistic concurrency)', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record);

    const [first, second] = await Promise.allSettled([
      harness.store.update(record.id, { expectedVersion: 1, action: 'updated' }, (next) => {
        next.title = 'First writer';
      }),
      harness.store.update(record.id, { expectedVersion: 1, action: 'updated' }, (next) => {
        next.title = 'Second writer';
      }),
    ]);

    const fulfilled = [first, second].filter((result) => result.status === 'fulfilled');
    const rejected = [first, second].filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(IntakeConflictError);
  });

  it('does not silently overwrite concurrent writes', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record);
    await harness.store.update(record.id, { expectedVersion: 1, action: 'updated' }, (next) => {
      next.title = 'Winner';
    });
    await expect(
      harness.store.update(record.id, { expectedVersion: 1, action: 'updated' }, (next) => {
        next.title = 'Loser';
      }),
    ).rejects.toBeInstanceOf(IntakeConflictError);
    const loaded = await harness.store.load(record.id);
    expect(loaded?.title).toBe('Winner');
    expect(loaded?.version).toBe(2);
  });

  it('throws IntakeNotFoundError when updating a missing record', async () => {
    const harness = makeHarness();
    await expect(harness.store.update('reqi_nope', {}, () => {})).rejects.toBeInstanceOf(
      IntakeNotFoundError,
    );
  });

  it('is idempotent for the same idempotency key', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    const first = await harness.store.create(record, 'create-key-1');
    expect(first.created).toBe(true);
    expect(first.idempotent).toBe(false);

    const second = await harness.store.create(buildRecord(), 'create-key-1');
    expect(second.created).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.record.id).toBe(record.id);
    expect(await harness.store.list('proj_alpha')).toHaveLength(1);
  });

  it('finds records by idempotency key', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record, 'findable-key');
    const found = await harness.store.findByIdempotencyKey('findable-key');
    expect(found?.id).toBe(record.id);
    expect(await harness.store.findByIdempotencyKey('other-key')).toBeNull();
  });

  it('stores the idempotency key on the record', async () => {
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record, 'key-on-record');
    const loaded = await harness.store.load(record.id);
    expect(loaded?.idempotencyKey).toBe('key-on-record');
  });

  it('generates prefixed record ids', () => {
    const id = newIntakeId();
    expect(id).toMatch(/^reqi_[A-Z0-9]+$/i);
    expect(newIntakeId()).not.toBe(id);
  });

  it('strips UTF-8 BOM when loading and indexing intake records (F455)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const harness = makeHarness();
    const record = buildRecord();
    await harness.store.create(record, 'bom-key');
    const file = join(harness.dir, `${record.id}.json`);
    const raw = JSON.stringify(record);
    await writeFile(file, `\uFEFF${raw}`, 'utf8');
    await expect(harness.store.load(record.id)).resolves.toMatchObject({ id: record.id });
    await expect(harness.store.list()).resolves.toHaveLength(1);
  });
});
