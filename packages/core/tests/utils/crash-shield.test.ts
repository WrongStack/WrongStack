import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installCrashShield } from '../../src/utils/crash-shield.js';

describe('installCrashShield', () => {
  it('ignores broken output consumer exceptions', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({
      target: target as never,
      write,
      exit,
    });

    target.emit(
      'uncaughtException',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    );

    expect(write).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });

  it('reports other uncaught exceptions', () => {
    const target = new EventEmitter();
    const write = vi.fn();
    const exit = vi.fn();
    const cleanup = installCrashShield({
      target: target as never,
      write,
      exit,
    });
    const error = Object.assign(new Error('boom'), { code: 'ERR_TEST' });

    target.emit('uncaughtException', error);

    expect(write).toHaveBeenCalledOnce();
    expect(String(write.mock.calls[0]?.[0])).toContain('boom');
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });
});
