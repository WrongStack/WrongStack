import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSpareClaim, spareMaxAge, waitForSpareClaim } from '../engine/spare-claim';

/** The engine's own limit when the host names none. */
const DEFAULT_SPARE_MAX_AGE_MS = 20 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('spare engine claim', () => {
  it('reads a new, a resumed and a forked conversation, and nothing else', () => {
    expect(parseSpareClaim('{}')).toEqual({ fork: false });
    expect(parseSpareClaim('{"resume":null}')).toEqual({ fork: false });
    expect(parseSpareClaim('{"resume":" 2026-11-12/sess_1 "}')).toEqual({
      resume: '2026-11-12/sess_1',
      fork: false,
    });
    expect(parseSpareClaim('{"resume":"a","fork":true}')).toEqual({ resume: 'a', fork: true });
    expect(parseSpareClaim('{"stop":true}')).toEqual({ fork: false, stop: true });
    expect(parseSpareClaim('{"stop":"yes"}')).toEqual({ fork: false });
    for (const bad of ['', '{', '[]', 'null', '{"resume":""}', '{"resume":7}'])
      expect(parseSpareClaim(bad), bad).toBeNull();
  });

  it('waits for the claim file, then removes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare-claim-'));
    dirs.push(dir);
    const path = join(dir, 'x.claim.json');
    const claimed = waitForSpareClaim(path, { pollMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(path, '{"resume":"s1","fork":true}');
    await expect(claimed).resolves.toEqual({ resume: 's1', fork: true });
    expect(existsSync(path)).toBe(false);
  });

  it('keeps waiting past a half-written claim', async () => {
    const reads = ['{"resu', '{"resume":"s2"}'];
    const claim = await waitForSpareClaim('unused', {
      pollMs: 1,
      read: async () => reads.shift() ?? '',
    });
    expect(claim).toEqual({ resume: 's2', fork: false });
  });

  it('gives up after its maximum age so an unused spare stops', async () => {
    let clock = 0;
    const claim = await waitForSpareClaim('unused', {
      pollMs: 1,
      maxWaitMs: 50,
      now: () => (clock += 20),
      read: async () => Promise.reject(Error('no claim yet')),
    });
    expect(claim).toBeNull();
    expect(spareMaxAge('60000')).toBe(60000);
    for (const bad of [undefined, '', 'x', '0', '-5'])
      expect(spareMaxAge(bad), String(bad)).toBe(DEFAULT_SPARE_MAX_AGE_MS);
  });
});
