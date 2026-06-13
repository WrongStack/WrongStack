import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PR 2 of Issue #29: pre-boot side effects (NODE_ENV defaulting,
 * update-notice quick-check, debug-stream seed) are now in
 * `preflight.ts`. This test pins the order and the side effects
 * so a future refactor can't accidentally regress the perf
 * invariant that originally drove the NODE_ENV defaulting
 * (3 GB heap leak from react-reconciler.development.js when
 * NODE_ENV is unset; root-caused from a live 4.1M-measure heap
 * snapshot, 2026-06-12).
 */

// `printUpdateNotice` does a 2-second quick-check, which is too
// long for unit tests. We mock the module before importing
// `preflight` so the import-time side effects in `runPreflight`
// don't fire a real network call. `vi.mock` is hoisted to the
// top of the file by Vitest, so this is the only mock.
vi.mock('../src/cli-update-notice.js', () => ({
  printUpdateNotice: vi.fn(async (info: unknown) => info),
}));
// `setDebugStreamEnabled` lives behind a dynamic import in
// `applyDebugStreamSeed` so we don't need to mock the providers
// package \u2014 the dynamic import path will just resolve against
// the real one in tests. The call is `if (config.debugStream)
// setDebugStreamEnabled(true)`; we just assert the boolean
// returned by runPreflight.

import { applyNodeEnvDefault, runPreflight } from '../src/preflight.js';
import type { Config } from '@wrongstack/core';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'test-provider',
    model: 'test-model',
    debugStream: false,
    yolo: false,
    // The other Config fields are not read by preflight; cast
    // through unknown so the test stays focused on the
    // preflight contract.
    ...overrides,
  } as unknown as Config;
}

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_DEFAULTED_FLAG = process.env['WRONGSTACK_NODE_ENV_DEFAULTED'];

describe('preflight (PR 2 of #29)', () => {
  beforeEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['WRONGSTACK_NODE_ENV_DEFAULTED'];
  });
  afterEach(() => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
    if (ORIGINAL_DEFAULTED_FLAG === undefined) delete process.env['WRONGSTACK_NODE_ENV_DEFAULTED'];
    else process.env['WRONGSTACK_NODE_ENV_DEFAULTED'] = ORIGINAL_DEFAULTED_FLAG;
  });

  it('defaulting NODE_ENV sets both NODE_ENV and the marker flag', () => {
    applyNodeEnvDefault();
    expect(process.env['NODE_ENV']).toBe('production');
    expect(process.env['WRONGSTACK_NODE_ENV_DEFAULTED']).toBe('1');
  });

  it('defaulting is a no-op when NODE_ENV is already set (vitest uses test)', () => {
    process.env['NODE_ENV'] = 'test';
    applyNodeEnvDefault();
    expect(process.env['NODE_ENV']).toBe('test');
    expect(process.env['WRONGSTACK_NODE_ENV_DEFAULTED']).toBeUndefined();
  });

  it('runPreflight returns the update info unchanged (mocked printer)', async () => {
    const initial = { outdated: false } as unknown as Parameters<typeof runPreflight>[1];
    const result = await runPreflight(makeConfig(), initial);
    expect(result.updateInfo).toBe(initial);
  });

  it('runPreflight sets debugStreamEnabled=false when config.debugStream is false', async () => {
    const result = await runPreflight(makeConfig({ debugStream: false }), undefined);
    expect(result.debugStreamEnabled).toBe(false);
  });

  it('runPreflight applies NODE_ENV defaulting even when updateInfo is undefined', async () => {
    expect(process.env['NODE_ENV']).toBeUndefined();
    await runPreflight(makeConfig(), undefined);
    // `runPreflight` calls `applyNodeEnvDefault` first, so even
    // if the rest of the preflight is mocked, the NODE_ENV
    // invariant is preserved. This is the fix that prevents the
    // 3 GB heap leak from react-reconciler.development.js.
    expect(process.env['NODE_ENV']).toBe('production');
  });
});
