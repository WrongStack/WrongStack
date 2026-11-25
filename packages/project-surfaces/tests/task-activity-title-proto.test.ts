import type { KanbanEvent } from '@wrongstack/kanban';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { eventTitle } from '../src/kanban/task-activity-model';

describe('eventTitle prototype safety', () => {
  it('does not pass Object.prototype properties to t() for inherited event.type keys', () => {
    let called = 0;
    const fakeT = ((key: string) => {
      called++;
      return `t:${key}`;
    }) as unknown as TFunction;

    const title = eventTitle({ type: 'toString' } as KanbanEvent, fakeT);
    expect(called).toBe(0);
    expect(title).not.toContain('t:');
  });
});
