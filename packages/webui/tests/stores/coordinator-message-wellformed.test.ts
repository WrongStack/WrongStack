import { beforeEach, describe, expect, it } from 'vitest';
import { useCoordinatorMonitorStore } from '../../src/stores/coordinator-monitor-store.js';

const ROCKET = '\u{1F680}';
// The WebUI test lib predates ES2024's String#isWellFormed typing.
const isWellFormed = (text: string): boolean =>
  (text as unknown as { isWellFormed(): boolean }).isWellFormed();

/**
 * F2645: the coordinator monitor builds task toasts with a plain 60-unit
 * `.slice` on the task description and the failure reason. Descriptions are
 * model-authored and errors carry provider text, so a split astral character
 * leaves a lone surrogate in the message the WebUI renders.
 */
describe('coordinator monitor messages keep valid UTF-16 (F2645)', () => {
  beforeEach(() => {
    useCoordinatorMonitorStore.getState().clear?.();
  });

  it('drops the orphaned half in a task.pending description', () => {
    const state = useCoordinatorMonitorStore.getState();
    state.pushEvent(
      'task.pending',
      { taskId: 't1', description: `${'d'.repeat(59)}${ROCKET}tail` },
      1,
    );
    const message = useCoordinatorMonitorStore.getState().events[0]?.message ?? '';

    expect(isWellFormed(message)).toBe(true);
    expect(message).toContain('d'.repeat(59));
  });

  it('drops the orphaned half in a task.failed reason', () => {
    const state = useCoordinatorMonitorStore.getState();
    state.pushEvent('task.failed', { taskId: 't2', error: `${'e'.repeat(59)}${ROCKET}tail` }, 1);
    const message = useCoordinatorMonitorStore.getState().events[0]?.message ?? '';

    expect(isWellFormed(message)).toBe(true);
  });

  it('renders short values unchanged (control)', () => {
    const state = useCoordinatorMonitorStore.getState();
    state.pushEvent('task.pending', { taskId: 't3', description: 'plain description' }, 1);

    expect(useCoordinatorMonitorStore.getState().events[0]?.message).toBe(
      'Task queued: "plain description"',
    );
  });
});
