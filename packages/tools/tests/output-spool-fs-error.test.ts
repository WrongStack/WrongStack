import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fault-inject the fs layer to exercise the spool's best-effort error handling:
// mkdirSync throwing (open() catch) and the write-stream emitting 'error'.
const state: { mkdirThrows: boolean; streamErrors: boolean } = {
  mkdirThrows: false,
  streamErrors: false,
};

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => {
      if (state.mkdirThrows) throw new Error('EACCES mkdir');
      return (actual.mkdirSync as (...a: unknown[]) => unknown)(...args);
    },
    createWriteStream: (...args: unknown[]) => {
      if (state.streamErrors) {
        const s = new EventEmitter() as EventEmitter & {
          write: () => boolean;
          end: () => void;
          writableLength: number;
        };
        s.write = () => true;
        s.end = () => {};
        s.writableLength = 0;
        // Emit asynchronously, after the spool attaches its 'error' listener.
        process.nextTick(() => s.emit('error', new Error('ENOSPC')));
        return s as never as ReturnType<typeof actual.createWriteStream>;
      }
      return (actual.createWriteStream as (...a: unknown[]) => unknown)(...args) as ReturnType<
        typeof actual.createWriteStream
      >;
    },
  };
});

import { _resetOutputSpoolForTests, createOutputSpool } from '../src/_output-spool.js';

afterEach(() => {
  state.mkdirThrows = false;
  state.streamErrors = false;
  _resetOutputSpoolForTests();
  vi.restoreAllMocks();
});

describe('createOutputSpool — best-effort fs failures', () => {
  it('disables the spool (returns null) when the directory cannot be created', () => {
    state.mkdirThrows = true;
    const spool = createOutputSpool({ tool: 'fail', thresholdBytes: 10 });
    spool.write('x'.repeat(50)); // crosses threshold → open() throws → failed
    spool.write('more'); // failed path → no-op
    expect(spool.finalize()).toBeNull();
  });

  it('survives a write-stream error event without throwing', async () => {
    state.streamErrors = true;
    const spool = createOutputSpool({ tool: 'streamerr', thresholdBytes: 10 });
    spool.write('y'.repeat(50)); // opens stream, which then emits 'error'
    await new Promise((r) => setTimeout(r, 10)); // let the error tick fire
    // The error handler nulls the stream/path; finalize must not throw.
    expect(() => spool.finalize()).not.toThrow();
  });
});
