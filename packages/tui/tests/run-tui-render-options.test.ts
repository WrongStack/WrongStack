import { tuiStreamFlushMs } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tuiRenderMaxFps, tuiRenderOptions } from '../src/run-tui-mount.js';

const ENV_KEYS = ['WRONGSTACK_PERF_PROFILE', 'WSTACK_PERF_PROFILE', 'WRONGSTACK_TUI_INCREMENTAL'];

describe('TUI render pacing', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('caps frames high enough that a keystroke is not held for a tenth of a second', () => {
    // Ink throttles every repaint to 1000/maxFps ms, typed characters included.
    expect(1000 / tuiRenderMaxFps()).toBeLessThanOrEqual(34);
    process.env['WRONGSTACK_PERF_PROFILE'] = 'frugal';
    expect(tuiRenderMaxFps()).toBe(15);
  });

  it('paces stream paints no faster than the frame ceiling allows', () => {
    // A flush faster than a frame would only queue renders Ink then drops.
    expect(tuiStreamFlushMs()).toBeGreaterThanOrEqual(1000 / tuiRenderMaxFps());
    process.env['WRONGSTACK_PERF_PROFILE'] = 'frugal';
    expect(tuiStreamFlushMs()).toBeGreaterThanOrEqual(1000 / tuiRenderMaxFps());
  });

  it('hands Ink the streams it was given and writes incrementally by default', () => {
    const inkStdin = {} as NodeJS.ReadStream;
    const stdout = {} as NodeJS.WriteStream;
    const options = tuiRenderOptions({ inkStdin, stdout });
    expect(options.stdin).toBe(inkStdin);
    expect(options.stdout).toBe(stdout);
    expect(options.exitOnCtrlC).toBe(false);
    expect(options.maxFps).toBe(30);
    expect(options.incrementalRendering).toBe(true);
  });

  it('falls back to whole-frame writes when WRONGSTACK_TUI_INCREMENTAL=0', () => {
    process.env['WRONGSTACK_TUI_INCREMENTAL'] = '0';
    const options = tuiRenderOptions({
      inkStdin: {} as NodeJS.ReadStream,
      stdout: {} as NodeJS.WriteStream,
    });
    expect(options.incrementalRendering).toBe(false);
  });
});
