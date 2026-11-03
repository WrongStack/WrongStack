/**
 * Regression (bug-hunt round 24/25): an accepted `update()` must never be
 * discarded by an earlier write landing last.
 *
 * `create`/`update`/`remove` fire `void save()` and return synchronously, so
 * several writes for one file are in flight at once. `save()` used to snapshot
 * the mode map BEFORE awaiting the atomic write; rename order is not
 * guaranteed, so a stale snapshot could land last and the file kept the OLD
 * mode while every call had returned `{ ok: true }`. Measured on the unfixed
 * code: 20 of 120 create→update→save cycles left the pre-update name on disk.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCustomModeStore } from '../src/server/custom-context-modes.js';

const CYCLES = 24;

it('keeps an accepted update on disk when several saves are in flight', async () => {
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    const dir = await mkdtemp(join(tmpdir(), 'context-modes-save-order-'));
    try {
      const store = createCustomModeStore(dir);
      await store.load();
      expect(
        store.create({
          id: 'probe',
          name: 'Before rename',
          description: '',
          thresholds: { warn: 0.5, soft: 0.7, hard: 0.85 },
          aggressiveOn: 'soft',
          preserveK: 6,
          eliseThreshold: 2000,
          targetLoad: 0.65,
          custom: true,
        }),
      ).toEqual({ ok: true });
      // Unawaited saves from create() and update() run alongside this one.
      expect(store.update('probe', { name: 'After rename' })).toEqual({ ok: true });
      await store.save();

      const raw = await readFile(join(dir, 'custom-context-modes.json'), 'utf8');
      const modes = (JSON.parse(raw) as { modes: Array<{ name: string }> }).modes;
      expect(modes.map((mode) => mode.name)).toEqual(['After rename']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('still persists a mode created and saved without a following update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-modes-create-'));
  try {
    const store = createCustomModeStore(dir);
    await store.load();
    expect(
      store.create({
        id: 'solo',
        name: 'Solo',
        description: '',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        aggressiveOn: 'soft',
        preserveK: 10,
        eliseThreshold: 2000,
        targetLoad: 0.65,
        custom: true,
      }),
    ).toEqual({ ok: true });
    await store.save();

    const reloaded = createCustomModeStore(dir);
    await reloaded.load();
    // list() also returns the built-in presets; this control is about the
    // custom entry that a single save had to persist.
    expect(
      reloaded
        .list()
        .filter((mode) => mode.custom)
        .map((mode) => mode.id),
    ).toEqual(['solo']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
