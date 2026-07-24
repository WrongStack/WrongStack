import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ exclusive: false, rename: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const options = args[2];
      if (
        failures.exclusive &&
        typeof options === 'object' &&
        options !== null &&
        'flag' in options &&
        options.flag === 'wx'
      ) {
        throw new Error('exclusive create failed');
      }
      return actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (failures.rename) throw new Error('heartbeat rename failed');
      return actual.renameSync(...args);
    },
  };
});

import { PollLock } from '../../src/poll-lock.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-lock-write-failure-'));
  failures.exclusive = false;
  failures.rename = false;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PollLock write failures', () => {
  it('returns false when exclusive creation loses a race', () => {
    failures.exclusive = true;
    expect(new PollLock(path.join(root, 'poll.lock')).tryAcquire()).toBe(false);
  });

  it('logs and tolerates a heartbeat write failure', () => {
    const log = { debug: vi.fn() } as never as Logger;
    const lock = new PollLock(path.join(root, 'poll.lock'), { log });
    expect(lock.tryAcquire()).toBe(true);
    failures.rename = true;
    (lock as never as { heartbeatTick(): void }).heartbeatTick();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('heartbeat write failed'));
    lock.release();
  });
});
