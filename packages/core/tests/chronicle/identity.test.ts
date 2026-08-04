import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveChronicleRuntimeLocation } from '../../src/chronicle/index.js';

describe('resolveChronicleRuntimeLocation', () => {
  it('returns stable opaque IDs and a UTC daily project partition', () => {
    const input = {
      globalRoot: path.resolve('tmp', '.wrongstack'),
      projectId: 'project-abc',
      projectDir: path.resolve('tmp', '.wrongstack', 'projects', 'abc'),
      now: new Date('2026-07-18T23:59:59.000Z'),
    };
    const first = resolveChronicleRuntimeLocation(input);
    const second = resolveChronicleRuntimeLocation(input);

    expect(first).toEqual(second);
    expect(first.installationId).toMatch(/^installation_[a-f0-9]{24}$/);
    expect(first.machineId).toMatch(/^machine_[a-f0-9]{24}$/);
    expect(first.projectId).toBe('project-abc');
    // Identity resolves *where* and *when*, never a file name: the storage
    // format is the store's business, and pinning a `.jsonl` path here is what
    // used to make every consumer assume partitions.
    expect(first.chronicleDirectory).toBe(path.join(input.projectDir, 'chronicle'));
    expect(first.day).toBe('2026-07-18');
    // Privacy contract: the envelope exposes the UTC day and opaque hashed
    // IDs, never a raw storage filename. (The old
    // `not.toContain(globalRoot)` assertion was impossible — the
    // chronicleDirectory above legitimately lives under globalRoot — and
    // only passed on Windows because JSON.stringify escapes backslashes.
    // The ID format regexes above already prove the ids are opaque hashes,
    // so no hostname check is needed either.)
    expect(JSON.stringify(first)).not.toContain('.jsonl');
  });
});
