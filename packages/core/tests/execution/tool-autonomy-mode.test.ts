import type { Tool } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import type { ToolExecutorOptions } from '../../src/execution/tool-executor-options.js';
import { runToolWithTimeout } from '../../src/execution/tool-executor-runner.js';
import { AutoApprovePermissionPolicy } from '../../src/security/auto-approve-policy.js';
import {
  __resetProcessLockdownForTests,
  lockYoloOff,
} from '../../src/security/process-lockdown.js';

afterEach(__resetProcessLockdownForTests);
const limits = {
  iterationTimeoutMs: 1000,
  maxToolTimeoutMs: 1000,
  progressEmitIntervalMs: 1,
  progressTailChars: 1000,
  progressHeadChars: 1000,
};
const context = { meta: {} } as Context;
const tool: Tool = {
  name: 'mode_probe',
  description: 'probe',
  inputSchema: {},
  permission: 'auto',
  mutating: false,
  async execute(_input, _ctx, opts) {
    return opts.autonomy;
  },
};

describe('effective tool autonomy', () => {
  it.each([
    [{ yolo: false, yoloPlus: true }, 'prompt'],
    [{ yolo: true, yoloPlus: false }, 'yolo'],
    [{ yolo: true, yoloPlus: true }, 'yolo-plus'],
  ] as const)('uses the scoped policy mode %j', async (mode, expected) => {
    const options = {
      permissionPolicy: { yoloModeFor: () => mode, getYolo: () => !mode.yolo },
    } as unknown as ToolExecutorOptions;
    expect(
      await runToolWithTimeout(
        tool,
        { autonomy: 'yolo-plus' },
        new AbortController().signal,
        context,
        options,
        limits,
      ),
    ).toBe(expected);
  });
  it('propagates the same mode through streaming execution', async () => {
    const streamed = {
      ...tool,
      async *executeStream(
        _input: unknown,
        _ctx: Context,
        opts: { signal: AbortSignal; autonomy?: 'prompt' | 'yolo' | 'yolo-plus' | undefined },
      ) {
        yield { type: 'final' as const, output: opts.autonomy };
      },
    };
    const options = {
      permissionPolicy: { yoloModeFor: () => ({ yolo: true, yoloPlus: true }) },
    } as unknown as ToolExecutorOptions;
    expect(
      await runToolWithTimeout(
        streamed,
        {},
        new AbortController().signal,
        context,
        options,
        limits,
      ),
    ).toBe('yolo-plus');
  });
  it('keeps restricted sessions in prompt mode even for a custom policy', async () => {
    lockYoloOff();
    const options = {
      permissionPolicy: { getYolo: () => true, getYoloPlus: () => true },
    } as unknown as ToolExecutorOptions;
    expect(
      await runToolWithTimeout(tool, {}, new AbortController().signal, context, options, limits),
    ).toBe('prompt');
  });
  it('does not turn ordinary subagent auto approval into YOLO', () => {
    expect(new AutoApprovePermissionPolicy().yoloModeFor()).toEqual({
      yolo: false,
      yoloPlus: false,
    });
    expect(
      new AutoApprovePermissionPolicy(undefined, { yoloPlus: () => true }).yoloModeFor(),
    ).toEqual({ yolo: true, yoloPlus: true });
  });
});
