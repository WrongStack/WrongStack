import { beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic regardless of the host machine's browser allowlist env —
// managerFor parses WRONGSTACK_BROWSER_PRIVATE_ORIGINS on every manager
// creation, so a host value this suite didn't set was reaching the tests.
beforeEach(() => {
  vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
});

import {
  browserEvaluateTool,
  browserListTool,
  browserOpenTool,
  browserSnapshotTool,
  browserTools,
  browserTypeTool,
  browserUploadTool,
} from '../src/browser/tools.js';

describe('first-party browser tool contract', () => {
  it('registers unique browser-prefixed tools with normal capability metadata', () => {
    const names = browserTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'browser_open',
        'browser_status',
        'browser_navigate',
        'browser_snapshot',
        'browser_screenshot',
        'browser_click',
        'browser_type',
        'browser_select',
        'browser_press',
        'browser_hover',
        'browser_drag',
        'browser_wait',
        'browser_upload',
        'browser_evaluate',
        'browser_close',
      ]),
    );
    expect(
      browserTools
        .filter((tool) => tool.name !== 'browser_status')
        .every((tool) => tool.capabilities?.includes('net.outbound')),
    ).toBe(true);
  });

  it('keeps observation automatic while navigation, evaluation, and upload require confirmation', () => {
    expect(browserSnapshotTool.permission).toBe('auto');
    expect(browserOpenTool.permission).toBe('confirm');
    expect(browserEvaluateTool.permission).toBe('confirm');
    expect(browserEvaluateTool.riskTier).toBe('destructive');
    expect(browserUploadTool.permission).toBe('confirm');
    expect(browserUploadTool.capabilities).toContain('fs.read');
    expect(browserTypeTool.validate?.({ sessionId: 's', selector: '#p' })).toEqual([
      'exactly one of text or secretEnv is required',
    ]);
    expect(
      browserTypeTool.validate?.({
        sessionId: 's',
        selector: '#p',
        secretEnv: 'TEST_PASSWORD',
      }),
    ).toEqual([]);
  });

  it('registers browser owner cleanup once per Agent.run signal', async () => {
    const hooks: Array<() => void | Promise<void>> = [];
    const firstRun = new AbortController();
    const ctx = {
      projectRoot: 'browser-cleanup-project',
      signal: firstRun.signal,
      agentId: 'leader',
      registerAbortHook: vi.fn((hook: () => void | Promise<void>) => {
        hooks.push(hook);
        return () => undefined;
      }),
    };

    await browserListTool.execute({}, ctx as never, { signal: firstRun.signal });
    await browserListTool.execute({}, ctx as never, { signal: firstRun.signal });
    expect(ctx.registerAbortHook).toHaveBeenCalledTimes(1);

    await hooks[0]?.();
    const secondRun = new AbortController();
    ctx.signal = secondRun.signal;
    await browserListTool.execute({}, ctx as never, { signal: secondRun.signal });

    expect(ctx.registerAbortHook).toHaveBeenCalledTimes(2);
  });

  it('executes browserListTool cleanly when opts parameter is omitted', async () => {
    const ctx = {
      projectRoot: 'browser-cleanup-project',
      agentId: 'leader',
    };
    const result = await browserListTool.execute({}, ctx as never);
    expect(typeof result).toBe('string');
  });
});
