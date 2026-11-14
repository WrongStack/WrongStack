/**
 * Coverage for `RequirementIntakeStore` idempotency recovery and pruning:
 * a corrupt or invalid-shape `_idempotency.json` is rebuilt from the durable
 * record files, records without usable keys are skipped, mismatched record
 * ids are rejected, and recovered entries respect the retention cap.
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RequirementIntakeStore } from '../src/store.js';
import type { RequirementIntakeRecord } from '../src/types.js';

const dirs: string[] = [];

afterEach(async () => {
  const owned = dirs.splice(0);
  await Promise.all(
    owned.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

async function makeDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `intake-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  dirs.push(dir);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function recordLiteral(
  id: string,
  overrides: Partial<RequirementIntakeRecord> = {},
): RequirementIntakeRecord {
  return {
    id,
    projectId: 'proj_alpha',
    title: `Record ${id}`,
    originalRequest: 'Add SSO.',
    normalizedSummary: 'Add SSO.',
    requestType: 'other',
    status: 'draft',
    priority: 'unspecified',
    requestedBy: 'user-alice',
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as RequirementIntakeRecord;
}

async function writeIdempotencyFile(dir: string, raw: string): Promise<void> {
  await fsp.writeFile(path.join(dir, '_idempotency.json'), raw, 'utf8');
}

describe('store idempotency recovery', () => {
  it('rebuilds entries from record files after JSON corruption', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await store.create(recordLiteral('reqi_r1'), 'k1');
    await store.create(recordLiteral('reqi_r2'), 'k2');
    await writeIdempotencyFile(dir, '{corrupt json');

    const first = await store.findByIdempotencyKey('k1');
    expect(first?.id).toBe('reqi_r1');
    const second = await store.findByIdempotencyKey('k2');
    expect(second?.id).toBe('reqi_r2');
    await expect(store.findByIdempotencyKey('missing')).resolves.toBeNull();
  });

  it.each([
    ['wrong version', JSON.stringify({ version: 2, entries: {} })],
    ['entries array', JSON.stringify({ version: 1, entries: [] })],
    ['entries null', JSON.stringify({ version: 1, entries: null })],
    ['entries missing', JSON.stringify({ version: 1 })],
    ['document null', 'null'],
  ])('recovers from an invalid-shape file: %s', async (_label, raw) => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await store.create(recordLiteral('reqi_shape'), 'k1');
    await writeIdempotencyFile(dir, raw);

    const recovered = await store.findByIdempotencyKey('k1');
    expect(recovered?.id).toBe('reqi_shape');
  });

  it('skips unusable record files during recovery', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await fsp.writeFile(
      path.join(dir, 'reqi_good.json'),
      JSON.stringify({ id: 'reqi_good', idempotencyKey: 'kg', createdAt: 1 }),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, 'reqi_nokey.json'),
      JSON.stringify({ id: 'reqi_nokey', createdAt: 2 }),
      'utf8',
    );
    // A filename whose derived id fails the id-charset check is skipped.
    await fsp.writeFile(
      path.join(dir, 'bad name.json'),
      JSON.stringify({ id: 'bad name', idempotencyKey: 'kb', createdAt: 3 }),
      'utf8',
    );
    await writeIdempotencyFile(dir, 'not-json');

    await expect(store.findByIdempotencyKey('kg')).resolves.toMatchObject({ id: 'reqi_good' });
    await expect(store.findByIdempotencyKey('kb')).resolves.toBeNull();
    await expect(store.findByIdempotencyKey('absent')).resolves.toBeNull();
  });

  it('rejects record id mismatches surfaced through the index recovery scan', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await store.create(recordLiteral('reqi_ok'), 'k1');
    await fsp.writeFile(
      path.join(dir, 'reqi_bad.json'),
      JSON.stringify({ id: 'something-else' }),
      'utf8',
    );
    // A filename whose derived id fails the charset check is skipped (index path).
    await fsp.writeFile(
      path.join(dir, 'bad name.json'),
      JSON.stringify({ id: 'bad name', idempotencyKey: 'kb', createdAt: 3 }),
      'utf8',
    );
    await fsp.writeFile(path.join(dir, '_index.json'), 'not-json', 'utf8');

    await expect(store.listIndex()).rejects.toThrow(/Invalid requirement intake record/);
  });

  it('rejects record id mismatches surfaced through the idempotency recovery scan', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await fsp.writeFile(
      path.join(dir, 'reqi_bad.json'),
      JSON.stringify({ id: 'something-else' }),
      'utf8',
    );
    await writeIdempotencyFile(dir, 'not-json');

    await expect(store.findByIdempotencyKey('k1')).rejects.toThrow(
      /Invalid requirement intake record/,
    );
  });

  it('falls back to the default retention cap for non-positive and unsafe caps', async () => {
    const zeroCapDir = await makeDir();
    const zeroCapStore = new RequirementIntakeStore({
      baseDir: zeroCapDir,
      maxIdempotencyEntries: 0,
    });
    await zeroCapStore.create(recordLiteral('reqi_c1'), 'kc1');
    await zeroCapStore.create(recordLiteral('reqi_c2'), 'kc2');
    await expect(zeroCapStore.findByIdempotencyKey('kc1')).resolves.toMatchObject({
      id: 'reqi_c1',
    });
    await expect(zeroCapStore.findByIdempotencyKey('kc2')).resolves.toMatchObject({
      id: 'reqi_c2',
    });

    const unsafeCapDir = await makeDir();
    const unsafeCapStore = new RequirementIntakeStore({
      baseDir: unsafeCapDir,
      maxIdempotencyEntries: Number.MAX_SAFE_INTEGER + 1,
    });
    await unsafeCapStore.create(recordLiteral('reqi_c3'), 'kc3');
    await expect(unsafeCapStore.findByIdempotencyKey('kc3')).resolves.toMatchObject({
      id: 'reqi_c3',
    });
  });

  it('prunes recovered entries down to the retention cap, newest kept', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir, maxIdempotencyEntries: 1 });
    await fsp.writeFile(
      path.join(dir, 'reqi_a.json'),
      JSON.stringify({ id: 'reqi_a', idempotencyKey: 'ka', createdAt: 1 }),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, 'reqi_b.json'),
      JSON.stringify({ id: 'reqi_b', idempotencyKey: 'kb', createdAt: 2 }),
      'utf8',
    );
    await writeIdempotencyFile(dir, 'not-json');

    await expect(store.findByIdempotencyKey('ka')).resolves.toBeNull();
    await expect(store.findByIdempotencyKey('kb')).resolves.toMatchObject({ id: 'reqi_b' });
  });

  it('keeps a single entry when two records share one key', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await fsp.writeFile(
      path.join(dir, 'reqi_d1.json'),
      JSON.stringify({ id: 'reqi_d1', idempotencyKey: 'kd', createdAt: 1 }),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, 'reqi_d2.json'),
      JSON.stringify({ id: 'reqi_d2', idempotencyKey: 'kd', createdAt: 2 }),
      'utf8',
    );
    await writeIdempotencyFile(dir, 'not-json');

    const found = await store.findByIdempotencyKey('kd');
    expect(found?.id === 'reqi_d1' || found?.id === 'reqi_d2').toBe(true);
  });

  it('treats a whitespace-only idempotency key as no key', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    const result = await store.create(recordLiteral('reqi_plain'), '   ');

    expect(result.created).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.record.idempotencyKey).toBeUndefined();
  });

  it('trims idempotency keys in findByIdempotencyKey to match create and recovery (F651)', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    await store.create(recordLiteral('reqi_trim'), '  idem-trim  ');

    await expect(store.findByIdempotencyKey('  idem-trim  ')).resolves.toMatchObject({
      id: 'reqi_trim',
    });
    await expect(store.findByIdempotencyKey('   ')).resolves.toBeNull();
  });

  it('binds reused idempotency keys to the newest record during recovery so pruneIdempotency does not evict active keys (F772)', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir, maxIdempotencyEntries: 2 });
    await fsp.writeFile(
      path.join(dir, 'reqi_001.json'),
      JSON.stringify({ id: 'reqi_001', idempotencyKey: 'shared-key', createdAt: 100 }),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, 'reqi_002.json'),
      JSON.stringify({ id: 'reqi_002', idempotencyKey: 'other-key', createdAt: 200 }),
      'utf8',
    );
    await fsp.writeFile(
      path.join(dir, 'reqi_003.json'),
      JSON.stringify({ id: 'reqi_003', idempotencyKey: 'shared-key', createdAt: 300 }),
      'utf8',
    );
    await writeIdempotencyFile(dir, 'not-json');

    await expect(store.findByIdempotencyKey('shared-key')).resolves.toMatchObject({
      id: 'reqi_003',
    });
    await expect(store.findByIdempotencyKey('other-key')).resolves.toMatchObject({
      id: 'reqi_002',
    });
  });

  it('skips corrupt record files during readIndex directory recovery', async () => {
    const dir = await makeDir();
    const store = new RequirementIntakeStore({ baseDir: dir });
    const now = new Date().toISOString();
    const created = await store.create({
      id: 'reqi_valid',
      version: 1,
      title: 'Valid',
      summary: 'Valid summary',
      requester: 'tester',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    } as never);

    await fsp.rm(path.join(dir, '_index.json'), { force: true });
    await fsp.writeFile(path.join(dir, 'corrupt.json'), '{truncated', 'utf8');

    const recovered = await store.list();
    expect(recovered.map((r) => r.id)).toEqual([created.record.id]);
  });
});
