import { describe, expect, it } from 'vitest';
import { assertManagementWrite, managementTaskVersion } from '../src/management-fence.js';

describe('assertManagementWrite blank lease token guard', () => {
  it('refuses writes when lease token is blank or whitespace-only', async () => {
    const board = {
      id: 'b1',
      management: { lease: { token: '   ', expiresAt: Date.now() + 60_000 } },
    } as never;
    const task = { id: 't1', title: 'Test', status: 'todo' } as never;
    const ver = managementTaskVersion(board, task);

    await expect(
      assertManagementWrite('b1-root', board, [task], {
        expectedManagementToken: '   ',
        expectedManagementTaskVersions: { t1: ver },
      } as never),
    ).rejects.toThrow(/management lease/);
  });
});
