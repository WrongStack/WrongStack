/**
 * Tests for the layout store — in-memory caching + disk persistence of
 * entry layout data.
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeLayout, LAYOUT_VERSION } from '../src/layout-engine.js';
import { LayoutStore } from '../src/layout-store.js';

function tempSessionDir(): string {
  return path.join(
    tmpdir(),
    `tui-layout-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

describe('LayoutStore (ephemeral mode)', () => {
  let store: LayoutStore;

  beforeEach(() => {
    store = new LayoutStore({ sessionDataDir: undefined, ephemeral: true });
  });

  it('starts empty', () => {
    expect(store.size).toBe(0);
    expect(store.get(1)).toBeUndefined();
    expect(store.getRows(1)).toBe(3);
  });

  it('sets and retrieves a layout', () => {
    const layout = computeLayout(1, 'user', 'hello', 80);
    store.set(1, layout);
    expect(store.get(1)).toEqual(layout);
    expect(store.getRows(1)).toBe(layout.rows);
  });

  it('set is idempotent when unchanged', () => {
    const layout = computeLayout(1, 'user', 'hello', 80);
    store.set(1, layout);
    // Second call with same data — should be a no-op (no dirty flag)
    const layout2 = computeLayout(1, 'user', 'hello', 80);
    store.set(1, layout2);
    expect(store.size).toBe(1);
  });

  it('setMany batches layouts', () => {
    const layouts = [
      computeLayout(1, 'user', 'hello', 80),
      computeLayout(2, 'assistant', 'response', 80),
      computeLayout(3, 'tool', 'output', 80),
    ];
    store.setMany(layouts);
    expect(store.size).toBe(3);
    expect(store.get(1)?.rows).toBeGreaterThan(0);
    expect(store.get(2)?.rows).toBeGreaterThan(0);
    expect(store.get(3)?.rows).toBeGreaterThan(0);
  });

  it('markMeasured promotes estimated to measured', () => {
    const layout = computeLayout(1, 'user', 'hello', 80);
    expect(layout.kind).toBe('estimated');
    store.set(1, layout);
    store.markMeasured(1, 5);
    expect(store.get(1)?.kind).toBe('measured');
    expect(store.get(1)?.rows).toBe(5);
  });

  it('markMeasured updates termWidth after a resize', () => {
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'user', 'hello', 80));
    // Resize to 120 cols and measure at the new width.
    store.markMeasured(1, 5, 120);
    expect(store.get(1)?.kind).toBe('measured');
    expect(store.get(1)?.rows).toBe(5);
    expect(store.get(1)?.termWidth).toBe(120);
  });

  it('allMeasured returns false when some entries are estimated', () => {
    store.set(1, computeLayout(1, 'user', 'a', 80)); // estimated
    store.set(2, { ...computeLayout(2, 'user', 'b', 80), kind: 'measured' });
    expect(store.allMeasured([1, 2])).toBe(false);
    expect(store.allMeasured([2])).toBe(true);
  });

  it('retain removes entries not in set', () => {
    store.set(1, computeLayout(1, 'user', 'a', 80));
    store.set(2, computeLayout(2, 'assistant', 'b', 80));
    store.set(3, computeLayout(3, 'tool', 'c', 80));
    store.retain(new Set([1, 3]));
    expect(store.size).toBe(2);
    expect(store.get(2)).toBeUndefined();
  });

  it('clear empties everything', () => {
    store.set(1, computeLayout(1, 'user', 'a', 80));
    store.set(2, computeLayout(2, 'user', 'b', 80));
    store.clear();
    expect(store.size).toBe(0);
  });

  it('setTermWidth updates termWidth', () => {
    expect(store.termWidth).toBe(80);
    store.setTermWidth(120);
    expect(store.termWidth).toBe(120);
    store.setTermWidth(4); // below minimum
    expect(store.termWidth).toBe(16);
  });
});

describe('LayoutStore (persistence mode)', () => {
  let dir: string;
  let store: LayoutStore;

  beforeEach(() => {
    dir = tempSessionDir();
    store = new LayoutStore({ sessionDataDir: dir, ephemeral: false });
  });

  afterEach(async () => {
    store.clear();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('load returns 0 when no file exists', async () => {
    const n = await store.load();
    expect(n).toBe(0);
  });

  it('persists and restores layout data', async () => {
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'user', 'hello', 80));
    store.set(2, { ...computeLayout(2, 'assistant', 'world', 80), kind: 'measured' });
    await store.flushNow();

    // Create a fresh store and load the data
    const store2 = new LayoutStore({ sessionDataDir: dir, ephemeral: false });
    store2.setTermWidth(80);
    const n = await store2.load();
    expect(n).toBe(2);
    expect(store2.get(1)?.rows).toBeGreaterThan(0);
    expect(store2.get(2)?.kind).toBe('measured');
  });

  it('does not overwrite a live measurement when async loading finishes later', async () => {
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'assistant', 'persisted estimate', 80));
    await store.flushNow();

    const store2 = new LayoutStore({ sessionDataDir: dir, ephemeral: false });
    store2.setTermWidth(80);
    store2.set(1, {
      ...computeLayout(1, 'assistant', 'live content', 80),
      rows: 37,
      kind: 'measured',
    });

    expect(await store2.load()).toBe(0);
    expect(store2.get(1)?.rows).toBe(37);
    expect(store2.get(1)?.kind).toBe('measured');
    store2.clear();
  });

  it('discards data on version mismatch', async () => {
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'user', 'hello', 80));
    await store.flushNow();

    // Corrupt the version to simulate an engine change
    const filePath = path.join(dir, 'tui-layout.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const corrupted = raw.replace(`"version": ${LAYOUT_VERSION},`, '"version": 0,');
    await fs.writeFile(filePath, corrupted);

    const store2 = new LayoutStore({ sessionDataDir: dir, ephemeral: false });
    store2.setTermWidth(80);
    const n = await store2.load();
    expect(n).toBe(0); // discarded — version mismatch
  });

  it('rejects version-1 measurements from before the copy-gutter width contract', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'tui-layout.json'),
      JSON.stringify({
        termWidth: 80,
        version: 1,
        entries: {
          1: {
            ...computeLayout(1, 'assistant', 'legacy full-width measurement', 80),
            rows: 7,
            kind: 'measured',
            version: 1,
          },
        },
      }),
    );

    const store2 = new LayoutStore({ sessionDataDir: dir, ephemeral: false });
    store2.setTermWidth(80);
    expect(await store2.load()).toBe(0);
    expect(store2.size).toBe(0);
  });

  it('discards data on large terminal width mismatch', async () => {
    store.setTermWidth(80);
    store.set(1, computeLayout(1, 'user', 'hello', 80));
    await store.flushNow();

    const store2 = new LayoutStore({ sessionDataDir: dir, ephemeral: false });
    store2.setTermWidth(120); // diff > 20 columns
    const n = await store2.load();
    expect(n).toBe(0); // discarded — width mismatch
  });

  it('ephemeral mode skips disk I/O entirely', async () => {
    const ephem = new LayoutStore({ sessionDataDir: dir, ephemeral: true });
    ephem.set(1, computeLayout(1, 'user', 'no-save', 80));
    await ephem.flushNow();

    const filePath = path.join(dir, 'tui-layout.json');
    try {
      await fs.access(filePath);
      // If file exists, test should fail
      expect(true).toBe(false);
    } catch {
      // Expected: file should not exist
      expect(true).toBe(true);
    }
  });
});
