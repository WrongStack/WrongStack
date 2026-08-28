import { describe, expect, it } from 'vitest';

/**
 * The browser bundle must not ask for `eval`.
 *
 * The page is served under `script-src 'self' 'wasm-unsafe-eval'`, and that
 * stays strict on purpose. Zod's compiled-validator fast path probes for
 * `new Function` the first time an object schema is built; under this CSP the
 * probe always fails, zod catches it and falls back to interpreting — correct
 * behaviour, but the browser reports a blocked eval on every load, coming
 * from the app's own vendor chunk.
 *
 * `models-dev-schema` is the single zod schema that reaches the browser, and
 * it sets `jitless` before constructing anything, so the probe never runs.
 * This test asserts the effect in the environment that has it: jsdom defines
 * `document`, which is the condition the module checks.
 */

describe('zod does not probe for eval in the browser', () => {
  it('is configured jitless before the first schema is built', async () => {
    expect(typeof document, 'this test only means anything in a DOM env').toBe('object');

    await import('@wrongstack/core/models');

    // The flag zod itself reads (`zod/v4/core/core.js` publishes it on
    // globalThis so every copy of the library shares one config object).
    const zodConfig = (globalThis as { __zod_globalConfig?: { jitless?: boolean } })
      .__zod_globalConfig;
    expect(zodConfig?.jitless).toBe(true);
  });

  it('still validates — the interpreted path is the working path', async () => {
    // Skipping the fast path must not skip the validation. If `jitless` ever
    // came at the cost of parsing, this is where it would show.
    const { modelsDevModelSchema } = await import('@wrongstack/core/models');
    const parsed = modelsDevModelSchema.safeParse({ id: 'm', name: 'M' });
    expect(parsed.success).toBe(true);
    expect(modelsDevModelSchema.safeParse({ id: 42 }).success).toBe(false);
  });
});
