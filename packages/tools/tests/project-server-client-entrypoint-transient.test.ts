import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectServerUrl } from '../src/codebase-index/project-server-client-state.js';

/**
 * Regression (2026-09-16, transient-stat sibling of the mailbox/SAGE/
 * chronicle `resolveProjectServerUrl` fixes): the codebase-index resolver
 * probed the dist entrypoint with `fs.existsSync`, which folds EVERY stat
 * error — EMFILE/EPERM/EBUSY spikes under full-suite parallel load — into
 * "missing build". One transient miss then threw "built codebase-index
 * project server is unavailable" from `spawnDetachedServer` inside
 * `connectWithElection`'s re-arm site, where the throw was uncaught and
 * unwound the entire SERVER_START_TIMEOUT_MS window.
 *
 * The fault is injected deterministically at the fs seam: a stat failure
 * whose code is NOT ENOENT (the file exists but the stat itself fails) must
 * be treated as "assume present" — the recoverable direction, since a dead
 * spawn is guarded and cadence-retryable while a false negative was fatal —
 * while genuine ENOENT must keep reporting missing-build, and the env
 * kill-switches must keep forcing the inline mode.
 */
const probeState = vi.hoisted(() => ({ mode: 'real' as 'real' | 'eperm' | 'enoent' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isEntrypointProbe = (value: unknown): boolean =>
    path.basename(String(value)) === 'project-server.js';
  const statError = (code: string): NodeJS.ErrnoException => {
    const error = new Error(`transient stat failure (${code})`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };
  const existsSync = ((pathValue: Parameters<typeof actual.existsSync>[0]) => {
    if (probeState.mode !== 'real' && isEntrypointProbe(pathValue)) return false;
    return actual.existsSync(pathValue);
  }) as typeof actual.existsSync;
  const statSync = ((pathValue: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
    if (probeState.mode === 'eperm' && isEntrypointProbe(pathValue)) throw statError('EPERM');
    if (probeState.mode === 'enoent' && isEntrypointProbe(pathValue)) throw statError('ENOENT');
    return (actual.statSync as (...args: unknown[]) => unknown)(pathValue, ...rest);
  }) as typeof actual.statSync;
  return { ...actual, existsSync, statSync };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const stateSrc = path.resolve(here, '../../codebase/src/project-server-client-state.ts');
// resolveProjectServerUrl() probes candidates relative to the state module's
// own URL; its FIRST candidate is this exact path.
const firstCandidate = path.resolve(path.dirname(stateSrc), './project-server.js');

beforeEach(() => {
  probeState.mode = 'real';
  delete process.env['WRONGSTACK_INDEX_INLINE'];
  delete process.env['WRONGSTACK_INDEX_SERVER'];
});

afterEach(() => {
  probeState.mode = 'real';
  delete process.env['WRONGSTACK_INDEX_INLINE'];
  delete process.env['WRONGSTACK_INDEX_SERVER'];
});

describe('codebase-index project server entrypoint resolution', () => {
  it('treats a non-ENOENT stat failure as assume-present instead of missing-build', () => {
    probeState.mode = 'eperm';
    const resolved = resolveProjectServerUrl();
    expect(resolved).not.toBeNull();
    expect(fileURLToPath(resolved!)).toBe(firstCandidate);
  });

  it('keeps reporting missing-build for genuine ENOENT', () => {
    probeState.mode = 'enoent';
    expect(resolveProjectServerUrl()).toBeNull();
  });

  it('keeps the inline env kill-switches working through the hardened probe', () => {
    process.env['WRONGSTACK_INDEX_INLINE'] = '1';
    expect(resolveProjectServerUrl()).toBeNull();
    delete process.env['WRONGSTACK_INDEX_INLINE'];
    process.env['WRONGSTACK_INDEX_SERVER'] = '0';
    expect(resolveProjectServerUrl()).toBeNull();
  });
});
