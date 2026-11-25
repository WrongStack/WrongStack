import { describe, expect, it } from 'vitest';
import { eventDescription, type KanbanEvent } from '../src/kanban/task-activity-model';

describe('eventDescription non-finite file metrics', () => {
  it('omits NaN and Infinity durationMs and lines', () => {
    expect(
      eventDescription({
        type: 'task.file.write',
        after: { filePath: 'src/a.ts', durationMs: 42, lines: 10 },
      } as unknown as KanbanEvent),
    ).toBe('src/a.ts · 42ms · 10 lines');

    expect(
      eventDescription({
        type: 'task.file.write',
        after: { filePath: 'src/a.ts', durationMs: Number.NaN, lines: Number.POSITIVE_INFINITY },
      } as unknown as KanbanEvent),
    ).toBe('src/a.ts');
  });
});
