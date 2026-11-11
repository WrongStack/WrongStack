import { describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript native harness has no declaration file.
import { ownedProcessIds } from './native-performance.mjs';

describe('native performance process attribution', () => {
  it('excludes a former parent PID and its unrelated descendants', () => {
    const processes = [
      { ProcessId: 4, ParentProcessId: 2, CreatedAtMs: 90 },
      { ProcessId: 5, ParentProcessId: 4, CreatedAtMs: 120 },
      { ProcessId: 2, ParentProcessId: 1, CreatedAtMs: 1000 },
      { ProcessId: 7, ParentProcessId: 2, CreatedAtMs: 1100 },
    ];
    expect([...ownedProcessIds(processes, [2])]).toEqual([2, 7]);
  });

  it('finds current descendants regardless of snapshot order and keeps fixture-owned orphans', () => {
    const processes = [
      { ProcessId: 8, ParentProcessId: 7, CreatedAtMs: 1120 },
      { ProcessId: 7, ParentProcessId: 2, CreatedAtMs: 1100 },
      { ProcessId: 2, ParentProcessId: 1, CreatedAtMs: 1000 },
      { ProcessId: 10, ParentProcessId: 0, CreatedAtMs: 1000, Owned: true },
    ];
    expect([...ownedProcessIds(processes, [2])].sort((a, b) => a - b)).toEqual([2, 7, 8, 10]);
  });

  it('requires creation-time evidence before attributing an unknown child', () => {
    const processes = [
      { ProcessId: 2, ParentProcessId: 1, CreatedAtMs: 1000 },
      { ProcessId: 7, ParentProcessId: 2, CreatedAtMs: null },
    ];
    expect([...ownedProcessIds(processes, [2])]).toEqual([2]);
  });
});
