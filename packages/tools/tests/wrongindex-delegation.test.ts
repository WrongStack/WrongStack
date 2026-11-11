import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: {} as Record<string, unknown>, held: true }));
vi.mock('node:fs', () => ({
  readFileSync: () => JSON.stringify(state.owner),
  openSync: () => {
    if (state.held) throw Object.assign(new Error('held'), { code: 'EBUSY' });
    return 1;
  },
  closeSync: () => {},
  realpathSync: Object.assign((p: string) => p, { native: (p: string) => p }),
}));

import {
  isOwnedByWrongIndex,
  isWrongIndexWriteBlocked,
  withWrongIndexWriteDelegation,
} from '../src/codebase-index/wrongindex/owner-lock.js';

const owner = () => ({ pid: process.ppid, epoch: 7, instanceId: 'service-one' });
afterEach(() => {
  state.held = true;
  state.owner = {};
});

describe.skipIf(process.platform !== 'win32')('supervised write delegation', () => {
  it('retains ownership and limits permission to one directory and async scope', async () => {
    state.owner = owner();
    expect(isWrongIndexWriteBlocked('C:/index')).toBe(true);
    await withWrongIndexWriteDelegation('C:/index', owner(), async () => {
      expect(isOwnedByWrongIndex('C:/index')).toBe(true);
      expect(isWrongIndexWriteBlocked('C:/index')).toBe(false);
      expect(isWrongIndexWriteBlocked('C:/other')).toBe(true);
      await Promise.resolve();
      expect(isWrongIndexWriteBlocked('C:/index')).toBe(false);
    });
    expect(isWrongIndexWriteBlocked('C:/index')).toBe(true);
  });

  it.each(['pid', 'epoch', 'instanceId'] as const)(
    'rejects a mismatched %s before the action',
    async (key) => {
      state.owner = owner();
      const mismatch = { ...owner(), [key]: key === 'instanceId' ? 'other' : 99999999 };
      const action = vi.fn();
      await expect(withWrongIndexWriteDelegation('C:/index', mismatch, action)).rejects.toThrow(
        'owned',
      );
      expect(action).not.toHaveBeenCalled();
    },
  );

  it('rejects descriptive ownership without a live lock', async () => {
    state.owner = owner();
    state.held = false;
    await expect(
      withWrongIndexWriteDelegation('C:/index', owner(), async () => {}),
    ).rejects.toThrow('owned');
  });

  it('rechecks the epoch and revokes descendants after an exceptional return', async () => {
    state.owner = owner();
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    let descendant!: Promise<boolean>;
    await expect(
      withWrongIndexWriteDelegation('C:/index', owner(), async () => {
        descendant = wait.then(() => isWrongIndexWriteBlocked('C:/index'));
        state.owner.epoch = 8;
        expect(isWrongIndexWriteBlocked('C:/index')).toBe(true);
        state.owner = owner();
        throw new Error('aborted');
      }),
    ).rejects.toThrow('aborted');
    release();
    expect(await descendant).toBe(true);
  });
});
