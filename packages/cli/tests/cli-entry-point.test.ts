import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installBrokenPipeHandlers } from '../src/cli-entry-point.js';

describe('CLI broken-pipe handling', () => {
  it('treats stdout EPIPE as a clean exit', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout, stderr], exit });

    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    cleanup();
  });

  it('treats stdout ECONNRESET as a clean exit', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout, stderr], exit });

    stdout.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    cleanup();
  });

  it('handles only the first EPIPE when both output streams close', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout, stderr], exit });
    const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    stdout.emit('error', brokenPipe);
    stderr.emit('error', brokenPipe);

    expect(exit).toHaveBeenCalledOnce();
    cleanup();
  });

  it('rethrows non-EPIPE output errors', () => {
    const stdout = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installBrokenPipeHandlers({ streams: [stdout], exit });
    const error = Object.assign(new Error('stream destroyed'), {
      code: 'ERR_STREAM_DESTROYED',
    });

    expect(() => stdout.emit('error', error)).toThrow(error);
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });

  it('removes its listeners during cleanup', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const cleanup = installBrokenPipeHandlers({
      streams: [stdout, stderr],
      exit: vi.fn(),
    });

    expect(stdout.listenerCount('error')).toBe(1);
    expect(stderr.listenerCount('error')).toBe(1);

    cleanup();

    expect(stdout.listenerCount('error')).toBe(0);
    expect(stderr.listenerCount('error')).toBe(0);
  });
});
