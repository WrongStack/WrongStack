import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { enumLabel, TASK_STATUS_KEYS } from '../src/kanban/kanban-labels';

describe('enumLabel prototype safety', () => {
  it('falls back to the raw value instead of translating Object.prototype properties', () => {
    let called = 0;
    const fakeT = ((key: string) => {
      called++;
      return `t:${key}`;
    }) as unknown as TFunction;

    expect(enumLabel(fakeT, TASK_STATUS_KEYS, 'toString')).toBe('toString');
    expect(called).toBe(0);
  });
});
