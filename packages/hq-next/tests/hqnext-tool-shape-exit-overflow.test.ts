import { describe, expect, it } from 'vitest';
import { detectShape } from '../src/hq/domain/tool-result-shape';

describe('detectShape safe exitCode guard (F2279)', () => {
  it('ignores overflowing exit codes instead of returning Infinity', () => {
    expect(detectShape('bash', `ok\nexit code: ${'9'.repeat(400)}`).exitCode).toBeUndefined();
    expect(detectShape('bash', 'ok\nexit code: 2').exitCode).toBe(2);
  });
});
