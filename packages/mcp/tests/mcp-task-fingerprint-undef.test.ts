import { describe, expect, it } from 'vitest';
import { taskInputFingerprint } from '../src/task-input-state.js';

describe('taskInputFingerprint undefined guard (F2234)', () => {
  it('hashes undefined without throwing ERR_INVALID_ARG_TYPE', () => {
    const fp = taskInputFingerprint(undefined);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
