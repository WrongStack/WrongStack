import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { IntakeValidationError } from '../src/errors.js';
import { ALICE, makeHarness } from './helpers.js';

it.each(['_index', '_idempotency', '_INDEX', '_IDEMPOTENCY'])(
  'rejects record id %s without altering either metadata file',
  async (id) => {
    const { store, service, dir } = makeHarness();
    const { record } = await service.createIntake(
      {
        projectId: ALICE.projectId,
        requestedBy: ALICE.id,
        originalRequest: 'Add password reset',
        idempotencyKey: 'control',
      },
      ALICE,
    );
    expect((await store.load(record.id))?.id).toBe(record.id);
    const index = await readFile(join(dir, '_index.json'), 'utf8');
    const idempotency = await readFile(join(dir, '_idempotency.json'), 'utf8');
    await expect(store.create({ ...record, id }, 'reserved-attempt')).rejects.toBeInstanceOf(
      IntakeValidationError,
    );
    await expect(store.create({ ...record, id })).rejects.toBeInstanceOf(IntakeValidationError);
    expect(await store.load(id)).toBeNull();
    expect(await store.exists(id)).toBe(false);
    await expect(store.update(id, {}, () => {})).rejects.toBeInstanceOf(IntakeValidationError);
    expect(await readFile(join(dir, '_index.json'), 'utf8')).toBe(index);
    expect(await readFile(join(dir, '_idempotency.json'), 'utf8')).toBe(idempotency);
    expect((await store.list()).map((item) => item.id)).toEqual([record.id]);
    expect((await store.findByIdempotencyKey('control'))?.id).toBe(record.id);
  },
);

it('skips a case-alias index filename while recovering durable records', async () => {
  const { store, service, dir } = makeHarness();
  const { record } = await service.createIntake(
    {
      projectId: ALICE.projectId,
      requestedBy: ALICE.id,
      originalRequest: 'Recover the durable intake index',
    },
    ALICE,
  );
  await rm(join(dir, '_index.json'), { force: true });
  await writeFile(join(dir, '_INDEX.json'), '{ truncated', 'utf8');

  expect((await store.listIndex()).map((entry) => entry.id)).toEqual([record.id]);
});

it('skips a case-alias idempotency filename while recovering durable keys', async () => {
  const { store, service, dir } = makeHarness();
  const { record } = await service.createIntake(
    {
      projectId: ALICE.projectId,
      requestedBy: ALICE.id,
      originalRequest: 'Recover the durable idempotency map',
      idempotencyKey: 'case-alias-recovery',
    },
    ALICE,
  );
  await rm(join(dir, '_idempotency.json'), { force: true });
  await writeFile(join(dir, '_IDEMPOTENCY.json'), '{ truncated', 'utf8');

  expect((await store.findByIdempotencyKey('case-alias-recovery'))?.id).toBe(record.id);
});

it('recovers durable idempotency keys when the map file is missing', async () => {
  const { store, service, dir } = makeHarness();
  const { record } = await service.createIntake(
    {
      projectId: ALICE.projectId,
      requestedBy: ALICE.id,
      originalRequest: 'Recover a lost idempotency map',
      idempotencyKey: 'lost-map-recovery',
    },
    ALICE,
  );
  await rm(join(dir, '_idempotency.json'), { force: true });

  expect((await store.findByIdempotencyKey('lost-map-recovery'))?.id).toBe(record.id);
});

it('continues to allow record ids sharing only a prefix with metadata names', async () => {
  const { store, service } = makeHarness();
  const { record } = await service.createIntake(
    {
      projectId: ALICE.projectId,
      requestedBy: ALICE.id,
      originalRequest: 'Add password reset',
    },
    ALICE,
  );
  for (const id of ['_index_record', '_idempotency_record']) {
    await store.create({ ...record, id });
    expect((await store.load(id))?.id).toBe(id);
  }
});
