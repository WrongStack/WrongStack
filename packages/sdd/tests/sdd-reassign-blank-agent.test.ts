import { describe, expect, it } from 'vitest';
import { reassignTask } from '../src/sdd-parallel-controls.js';

describe('reassignTask whitespace guard', () => {
  it('rejects blank agent names and trims valid ones', () => {
    let updated: unknown = null;
    const host = {
      opts: {
        tracker: {
          getNode: () => ({ id: 't1', status: 'pending' }),
          updateNode: (_id: string, patch: unknown) => {
            updated = patch;
          },
        },
      },
    } as never;

    expect(reassignTask(host, 't1', '   ')).toBe(false);
    expect(updated).toBeNull();
    expect(reassignTask(host, 't1', '  coder  ')).toBe(true);
    expect(updated).toEqual({ assignee: 'coder' });
  });
});
