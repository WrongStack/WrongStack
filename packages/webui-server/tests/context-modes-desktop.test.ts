import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { modeDraft, modePayload } from '../../../apps/desktop-v2/src/context-modes-model.js';
import { createCustomModeStore } from '../src/server/custom-context-modes.js';

it('stores, updates and reloads a mode exactly as the desktop form sends it', async () => {
  const base = resolve(tmpdir()),
    dir = await mkdtemp(join(base, 'context-modes-desktop-'));
  try {
    const store = createCustomModeStore(dir);
    await store.load();
    const payload = modePayload({
      ...modeDraft(),
      id: 'review-heavy',
      name: 'Review heavy',
      warn: '55',
      soft: '70',
      hard: '85',
      preserveK: '6',
    });
    // The same fields the `context.mode.create` handler passes on.
    expect(
      store.create({ ...payload, custom: true, aggressiveOn: 'soft', targetLoad: 0.65 }),
    ).toEqual({ ok: true });
    const { id, ...patch } = modePayload({ ...modeDraft(), id: 'review-heavy', name: 'Renamed' });
    expect(store.update(id, patch)).toEqual({ ok: true });
    await store.save();
    const reloaded = createCustomModeStore(dir);
    await reloaded.load();
    expect(reloaded.list().find((mode) => mode.id === 'review-heavy')).toMatchObject({
      name: 'Renamed',
      thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
      preserveK: 10,
    });
  } finally {
    expect(dir.startsWith(base + sep)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});
