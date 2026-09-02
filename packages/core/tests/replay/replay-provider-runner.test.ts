import { describe, expect, it, vi } from 'vitest';
import { ReplayProviderRunner } from '../../src/replay/replay-provider-runner.js';
import type { ProviderRunner, RunProviderOptions } from '../../src/types/provider-runner.js';
import type { Response } from '../../src/types/provider.js';

const REQUEST = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  maxTokens: 1,
} as never;
const RESPONSE = (text: string): Response =>
  ({
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 0, output: 0 },
    model: 'm',
  }) as never;

function makeRunner(opts: {
  mode: 'record' | 'replay' | 'auto';
  cached?: Response | null;
  logger?: unknown;
}) {
  const innerResponse = RESPONSE('from-inner');
  const inner: ProviderRunner = { run: vi.fn(async () => innerResponse) } as never;
  const log = {
    lookup: vi.fn(async () =>
      opts.cached === undefined
        ? null
        : opts.cached
          ? { ts: '2026-01-01', response: opts.cached }
          : null,
    ),
    record: vi.fn(async () => 'sha256:x'),
  };
  const runner = new ReplayProviderRunner(inner, {
    log: log as never,
    sessionId: 's1',
    mode: opts.mode,
    logger: opts.logger as never,
  });
  return { runner, inner, log, innerResponse };
}

const runOpts = (): RunProviderOptions => ({ request: REQUEST }) as never;

describe('ReplayProviderRunner', () => {
  it('replay mode serves a cached response (with debug log)', async () => {
    const debug = vi.fn();
    const { runner, inner } = makeRunner({
      mode: 'replay',
      cached: RESPONSE('cached'),
      logger: { debug },
    });
    const res = await runner.run(runOpts());
    expect(res.content[0]).toMatchObject({ text: 'cached' });
    expect(inner.run).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  it('replay mode warns and throws on a cache miss', async () => {
    const warn = vi.fn();
    const { runner } = makeRunner({ mode: 'replay', cached: null, logger: { warn } });
    await expect(runner.run(runOpts())).rejects.toThrow(/no recorded response/);
    expect(warn).toHaveBeenCalled();
  });

  it('replay mode miss throws even without a logger', async () => {
    const { runner } = makeRunner({ mode: 'replay', cached: null });
    await expect(runner.run(runOpts())).rejects.toThrow(/no recorded response/);
  });

  it('auto mode serves a cache hit', async () => {
    const debug = vi.fn();
    const { runner, inner } = makeRunner({
      mode: 'auto',
      cached: RESPONSE('auto-cached'),
      logger: { debug },
    });
    const res = await runner.run(runOpts());
    expect(res.content[0]).toMatchObject({ text: 'auto-cached' });
    expect(inner.run).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  it('auto mode delegates and records on a cache miss', async () => {
    const { runner, inner, log } = makeRunner({ mode: 'auto', cached: null });
    const res = await runner.run(runOpts());
    expect(res.content[0]).toMatchObject({ text: 'from-inner' });
    expect(inner.run).toHaveBeenCalled();
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
  });

  it('record mode always delegates and records (ignoring any cache)', async () => {
    const { runner, inner, log } = makeRunner({ mode: 'record', cached: RESPONSE('ignored') });
    const res = await runner.run(runOpts());
    expect(res.content[0]).toMatchObject({ text: 'from-inner' });
    expect(inner.run).toHaveBeenCalled();
    expect(log.record).toHaveBeenCalled();
  });
});
