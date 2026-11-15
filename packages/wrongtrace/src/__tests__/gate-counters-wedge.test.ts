import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countersFilePath, persistWrongTraceGateCounters } from '../gate-counters.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('persistWrongTraceGateCounters chain resilience', () => {
  it('recovers after an invalid-root error and persists subsequent snapshots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gate-wedge-'));
    tempRoots.push(root);
    const snap = {
      deny: 1,
      allowFragile: 0,
      lockAcquired: 1,
      lockConflictRace: 0,
      lockReleased: 1,
      total: 3,
    };

    await persistWrongTraceGateCounters(root, snap);
    await persistWrongTraceGateCounters(undefined as unknown as string, snap);
    await persistWrongTraceGateCounters(root, { ...snap, deny: 99 });

    const raw = fs.readFileSync(countersFilePath(root), 'utf8');
    expect(raw).toContain('"deny": 99');
  });
});
