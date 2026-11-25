import { describe, expect, it } from 'vitest';
import { configHistoryDir } from '../src/utils/config-backup.js';

describe('configHistoryDir (F2197)', () => {
  it('treats whitespace-only globalRoot as empty', () => {
    expect(configHistoryDir('   ')).toBe('config-history');
  });
});
